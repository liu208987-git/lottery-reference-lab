// SSQ LSTM 预测模型
//
// 架构（升级版 V2）：
//   输入: 序列长度 T，每步特征 49 维
//        [redMultiHot(33) | blueOneHot(16)]
//
//   层（默认 numLayers=1，可配置 2、3 层）:
//     Dropout(p_input)
//     LSTM(49 → H)
//     Dropout(p_hidden) 层间
//     LSTM(H → H)
//     ...
//     Dropout(p_output) 在最后 h_T 上
//     Dense Red Head:   h → 33 logits → sigmoid（每个红球独立 0/1，multi-label BCE）
//     Dense Blue Head:  h → 16 logits → softmax（蓝球唯一，cross-entropy）
//
// 损失 = BCE(redLogits, redTarget) + BLUE_LOSS_WEIGHT * CE(blueLogits, blueTarget)

import {
  makeMat, zero,
  matmul, transpose, add,
  sigmoid, sigmoidBCEBackward, bceLoss,
  softmax, softmaxCEBackward, crossEntropy,
  bceLossSmoothed, crossEntropySmoothed,
  smoothBinaryTarget, smoothCategoricalTarget,
  xavierInit, matmulAdd,
  makeDropoutMask, hadamard,
} from "./nn-math.js";
import {
  createStackedLSTM, stackedForward, stackedBackward,
  serializeStack, deserializeStack,
} from "./nn-stack.js";
import { ssqRedFeatures, appendFeatures, FEATURE_AUG_DIM } from "./nn-features.js";

export const RED_DIM = 33;
export const BLUE_DIM = 16;
export const BASE_FEATURE_DIM = RED_DIM + BLUE_DIM;
export const FEATURE_DIM = BASE_FEATURE_DIM + FEATURE_AUG_DIM;  // 49 + 14 = 63
export const BLUE_LOSS_WEIGHT = 6;

/**
 * 把一期开奖编码为 49+14 维向量：
 *   [pos 0..32]: 红球 multi-hot
 *   [pos 33..48]: 蓝球 one-hot
 *   [pos 49..62]: 14 维手工统计特征（基于 history 计算）
 *
 * @param history 当前期之前的所有 draw（用于算遗漏 / 频率 / 熵）
 *                如果不传或 []，特征会退化（不影响 multi-hot 部分）
 */
export function encodeDraw(draw, history = []) {
  const v = new Float32Array(BASE_FEATURE_DIM);
  for (const r of draw.reds) v[r - 1] = 1;
  v[RED_DIM + draw.blue - 1] = 1;
  const features = ssqRedFeatures(draw.reds, history);
  const augmented = appendFeatures(v, features, BASE_FEATURE_DIM);
  return { rows: FEATURE_DIM, cols: 1, data: augmented };
}

/** 把多期序列编码：每期都基于"截至前一期"的 history 计算特征。 */
export function encodeSequence(draws, fullHistoryUpToFirst = []) {
  const out = [];
  // 维护 rolling history
  const rolling = fullHistoryUpToFirst.slice();
  for (const d of draws) {
    out.push(encodeDraw(d, rolling));
    rolling.push(d);
  }
  return out;
}

/** 取一期作为 target：red multi-hot (33×1) + blue one-hot (16×1) 单独返回。 */
export function encodeTarget(draw) {
  const red = makeMat(RED_DIM, 1);
  for (const r of draw.reds) red.data[r - 1] = 1;
  const blue = makeMat(BLUE_DIM, 1);
  blue.data[draw.blue - 1] = 1;
  return { red, blue };
}

/** 创建模型。 */
export function createModel({
  hiddenDim = 64,
  numLayers = 1,
  dropoutInput = 0,
  dropoutHidden = 0,
  dropoutOutput = 0,
  rng = Math.random,
} = {}) {
  const stack = createStackedLSTM(FEATURE_DIM, hiddenDim, numLayers, rng);
  const redHead = {
    W: xavierInit(RED_DIM, hiddenDim, rng),
    b: makeMat(RED_DIM, 1),
  };
  const blueHead = {
    W: xavierInit(BLUE_DIM, hiddenDim, rng),
    b: makeMat(BLUE_DIM, 1),
  };
  return {
    hiddenDim,
    numLayers,
    dropoutInput,
    dropoutHidden,
    dropoutOutput,
    stack,
    redHead,
    blueHead,
  };
}

/**
 * 一次完整前向：输入 T 期序列，使用最后一步的 h_T 做预测。
 * @param training true 时启用 dropout
 * @param rng 用于 dropout 的 RNG
 */
export function forwardModel(model, sequence, { training = false, rng = Math.random } = {}) {
  const fwd = stackedForward(model.stack, sequence, {
    training,
    dropoutIn: model.dropoutInput,
    dropoutHidden: model.dropoutHidden,
    rng,
  });

  // 输出层 dropout
  let hForHead = fwd.hLast;
  let outputMask = null;
  if (training && model.dropoutOutput > 0) {
    outputMask = makeDropoutMask(hForHead.rows, hForHead.cols, model.dropoutOutput, rng);
    hForHead = hadamard(hForHead, outputMask);
  }

  const redLogits = add(matmul(model.redHead.W, hForHead), model.redHead.b);
  const blueLogits = add(matmul(model.blueHead.W, hForHead), model.blueHead.b);

  // 推理时如果 model 有校准温度 (T_red, T_blue)，应用 temperature scaling
  // 训练时（training=true）必须用 T=1，否则梯度计算就错了
  let redProbs, blueProbs;
  if (!training && (model.calibration?.redT || model.calibration?.blueT)) {
    const Tr = model.calibration.redT || 1;
    const Tb = model.calibration.blueT || 1;
    if (Tr !== 1) {
      const scaled = makeMat(redLogits.rows, redLogits.cols);
      for (let i = 0; i < redLogits.data.length; i++) scaled.data[i] = redLogits.data[i] / Tr;
      redProbs = sigmoid(scaled);
    } else {
      redProbs = sigmoid(redLogits);
    }
    if (Tb !== 1) {
      const scaled = makeMat(blueLogits.rows, blueLogits.cols);
      for (let i = 0; i < blueLogits.data.length; i++) scaled.data[i] = blueLogits.data[i] / Tb;
      blueProbs = softmax(scaled);
    } else {
      blueProbs = softmax(blueLogits);
    }
  } else {
    redProbs = sigmoid(redLogits);
    blueProbs = softmax(blueLogits);
  }

  return {
    stackFwd: fwd,
    hLast: fwd.hLast,
    hForHead,
    outputMask,
    redLogits, redProbs,
    blueLogits, blueProbs,
  };
}

/**
 * 计算 loss + 反向传播一次。返回 { loss, redLoss, blueLoss, grads }。
 *
 * grads 字典 keys:
 *   stack.layers[l].dW/dU/db,
 *   redHead.dW, redHead.db, blueHead.dW, blueHead.db
 */
export function lossAndGrads(model, sequence, target, { rng = Math.random, labelSmoothing = 0 } = {}) {
  const fwd = forwardModel(model, sequence, { training: true, rng });
  const T = sequence.length;
  const H = model.hiddenDim;

  // Label smoothing：softTarget 仅用于反向梯度计算和 loss reporting
  // 注意：softmaxCEBackward / sigmoidBCEBackward 都是 (probs - target)，target 用 soft 即可
  let redTarget = target.red;
  let blueTarget = target.blue;
  if (labelSmoothing > 0) {
    redTarget = smoothBinaryTarget(target.red, labelSmoothing);
    blueTarget = smoothCategoricalTarget(target.blue, labelSmoothing);
  }

  const redLoss = labelSmoothing > 0
    ? bceLossSmoothed(fwd.redProbs, target.red, labelSmoothing) / RED_DIM
    : bceLoss(fwd.redProbs, target.red) / RED_DIM;
  const blueLoss = labelSmoothing > 0
    ? crossEntropySmoothed(fwd.blueProbs, target.blue, labelSmoothing)
    : crossEntropy(fwd.blueProbs, target.blue);
  const totalLoss = redLoss + BLUE_LOSS_WEIGHT * blueLoss;

  // 输出层反向（target 用 soft 版本）
  const dRedLogits = sigmoidBCEBackward(fwd.redProbs, redTarget);
  for (let i = 0; i < dRedLogits.data.length; i++) dRedLogits.data[i] /= RED_DIM;

  const dBlueLogits = softmaxCEBackward(fwd.blueProbs, blueTarget);
  for (let i = 0; i < dBlueLogits.data.length; i++) dBlueLogits.data[i] *= BLUE_LOSS_WEIGHT;

  // dHead.W = dLogits · hForHead^T；db = dLogits
  const hHeadT = transpose(fwd.hForHead);
  const grads = {
    redHead: {
      dW: matmul(dRedLogits, hHeadT),
      db: makeMat(RED_DIM, 1),
    },
    blueHead: {
      dW: matmul(dBlueLogits, hHeadT),
      db: makeMat(BLUE_DIM, 1),
    },
  };
  for (let i = 0; i < dRedLogits.data.length; i++) grads.redHead.db.data[i] = dRedLogits.data[i];
  for (let i = 0; i < dBlueLogits.data.length; i++) grads.blueHead.db.data[i] = dBlueLogits.data[i];

  // dhForHead = redHead.W^T · dRedLogits + blueHead.W^T · dBlueLogits
  const dhFromRed = matmul(transpose(model.redHead.W), dRedLogits);
  const dhFromBlue = matmul(transpose(model.blueHead.W), dBlueLogits);
  let dhForHead = add(dhFromRed, dhFromBlue);

  // 反向 dropoutOutput：dhLast = mask ⊙ dhForHead
  let dhLast = dhForHead;
  if (fwd.outputMask) {
    dhLast = hadamard(dhForHead, fwd.outputMask);
  }

  // 把 dhLast 注入到最后时间步；其余时间步给 0（因为只在最后一步监督）
  const dhFromAbove = new Array(T);
  for (let t = 0; t < T - 1; t++) dhFromAbove[t] = makeMat(H, 1);
  dhFromAbove[T - 1] = dhLast;

  const { grads: stackGrads } = stackedBackward(model.stack, fwd.stackFwd, dhFromAbove);
  grads.stack = stackGrads; // grads.stack[l] = { dW, dU, db }

  return { loss: totalLoss, redLoss, blueLoss, grads, fwd };
}

/** 把 grads / params 摊平为 Adam 期望的字典形式（含多层 LSTM）。 */
export function flattenParams(model) {
  const out = {};
  for (let l = 0; l < model.numLayers; l++) {
    out[`stack.${l}.W`] = model.stack.layers[l].params.W;
    out[`stack.${l}.U`] = model.stack.layers[l].params.U;
    out[`stack.${l}.b`] = model.stack.layers[l].params.b;
  }
  out["redHead.W"] = model.redHead.W;
  out["redHead.b"] = model.redHead.b;
  out["blueHead.W"] = model.blueHead.W;
  out["blueHead.b"] = model.blueHead.b;
  return out;
}

export function flattenGrads(g) {
  const out = {};
  for (let l = 0; l < g.stack.length; l++) {
    out[`stack.${l}.W`] = g.stack[l].dW;
    out[`stack.${l}.U`] = g.stack[l].dU;
    out[`stack.${l}.b`] = g.stack[l].db;
  }
  out["redHead.W"] = g.redHead.dW;
  out["redHead.b"] = g.redHead.db;
  out["blueHead.W"] = g.blueHead.dW;
  out["blueHead.b"] = g.blueHead.db;
  return out;
}

/** 序列化（用于训练后保存到 localStorage 或下载）。 */
export function serializeModel(model) {
  const flat = (m) => ({ rows: m.rows, cols: m.cols, data: Array.from(m.data) });
  return {
    type: "ssq-lstm-v2",
    hiddenDim: model.hiddenDim,
    numLayers: model.numLayers,
    dropoutInput: model.dropoutInput,
    dropoutHidden: model.dropoutHidden,
    dropoutOutput: model.dropoutOutput,
    stack: serializeStack(model.stack),
    redHead: { W: flat(model.redHead.W), b: flat(model.redHead.b) },
    blueHead: { W: flat(model.blueHead.W), b: flat(model.blueHead.b) },
    calibration: model.calibration || null,
  };
}

export function deserializeModel(obj) {
  const inflate = (m) => ({ rows: m.rows, cols: m.cols, data: new Float32Array(m.data) });
  // v1 兼容：单层 lstm 字段
  if (obj.type === "ssq-lstm-v1") {
    // 把 v1 的 lstm 包装成单层 stack
    const v1Stack = {
      type: "stacked-lstm",
      inputDim: obj.lstm.inputDim,
      hiddenDim: obj.lstm.hiddenDim,
      numLayers: 1,
      layers: [obj.lstm],
    };
    return {
      hiddenDim: obj.hiddenDim,
      numLayers: 1,
      dropoutInput: 0, dropoutHidden: 0, dropoutOutput: 0,
      stack: deserializeStack(v1Stack),
      redHead: { W: inflate(obj.redHead.W), b: inflate(obj.redHead.b) },
      blueHead: { W: inflate(obj.blueHead.W), b: inflate(obj.blueHead.b) },
    };
  }
  return {
    hiddenDim: obj.hiddenDim,
    numLayers: obj.numLayers,
    dropoutInput: obj.dropoutInput || 0,
    dropoutHidden: obj.dropoutHidden || 0,
    dropoutOutput: obj.dropoutOutput || 0,
    stack: deserializeStack(obj.stack),
    redHead: { W: inflate(obj.redHead.W), b: inflate(obj.redHead.b) },
    blueHead: { W: inflate(obj.blueHead.W), b: inflate(obj.blueHead.b) },
    calibration: obj.calibration || null,
  };
}

/** 给定 redProbs (33×1)，返回前 K 个号码（1-indexed）。 */
export function topKRed(redProbs, k = 6) {
  const arr = [];
  for (let i = 0; i < RED_DIM; i++) arr.push([i + 1, redProbs.data[i]]);
  arr.sort((a, b) => b[1] - a[1]);
  return arr.slice(0, k);
}

/** 给定 blueProbs (16×1)，返回最高概率号码（1-indexed）。 */
export function argMaxBlue(blueProbs) {
  let best = 1, bestP = blueProbs.data[0];
  for (let i = 1; i < BLUE_DIM; i++) {
    if (blueProbs.data[i] > bestP) {
      bestP = blueProbs.data[i];
      best = i + 1;
    }
  }
  return { num: best, prob: bestP };
}
