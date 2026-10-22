// 大乐透 LSTM 模型
//
// 与 SSQ 版本同构（nn-ssq-model.js），但适配 DLT 的 5+2 结构：
//   输入: 序列长度 T，每步特征 47 维 = [frontMultiHot(35) | backMultiHot(12)]
//   输出:
//     - frontHead: 35 维 sigmoid（multi-label BCE）
//     - backHead:  12 维 sigmoid（multi-label BCE，因为后区 2 个号也是 multi-hot）
//
// 注意：这是 SSQ 蓝球（单值 softmax）和 DLT 后区（双值 multi-hot）的关键区别。

import {
  makeMat, matmul, transpose, add,
  sigmoid, sigmoidBCEBackward, bceLoss,
  bceLossSmoothed, smoothBinaryTarget,
  xavierInit, makeDropoutMask, hadamard,
} from "./nn-math.js";
import {
  createStackedLSTM, stackedForward, stackedBackward,
  serializeStack, deserializeStack,
} from "./nn-stack.js";
import { dltFrontFeatures, appendFeatures, FEATURE_AUG_DIM } from "./nn-features.js";

export const FRONT_DIM = 35;
export const BACK_DIM = 12;
export const BASE_FEATURE_DIM = FRONT_DIM + BACK_DIM;
export const FEATURE_DIM = BASE_FEATURE_DIM + FEATURE_AUG_DIM;  // 47 + 14 = 61
export const FRONT_PICK = 5;
export const BACK_PICK = 2;
export const BACK_LOSS_WEIGHT = 5;

/** 编码一期 → 47+14=61 维（multi-hot + 14 维统计特征）。 */
export function encodeDltDraw(draw, history = []) {
  const v = new Float32Array(BASE_FEATURE_DIM);
  for (const r of draw.front) v[r - 1] = 1;
  for (const b of draw.back) v[FRONT_DIM + b - 1] = 1;
  const features = dltFrontFeatures(draw.front, history);
  const augmented = appendFeatures(v, features, BASE_FEATURE_DIM);
  return { rows: FEATURE_DIM, cols: 1, data: augmented };
}

export function encodeDltSequence(draws, fullHistoryUpToFirst = []) {
  const out = [];
  const rolling = fullHistoryUpToFirst.slice();
  for (const d of draws) {
    out.push(encodeDltDraw(d, rolling));
    rolling.push(d);
  }
  return out;
}

/** Target：前区 multi-hot + 后区 multi-hot。 */
export function encodeDltTarget(draw) {
  const front = makeMat(FRONT_DIM, 1);
  for (const r of draw.front) front.data[r - 1] = 1;
  const back = makeMat(BACK_DIM, 1);
  for (const b of draw.back) back.data[b - 1] = 1;
  return { front, back };
}

export function createDltModel({
  hiddenDim = 64,
  numLayers = 2,
  dropoutInput = 0.1,
  dropoutHidden = 0.2,
  dropoutOutput = 0.2,
  rng = Math.random,
} = {}) {
  const stack = createStackedLSTM(FEATURE_DIM, hiddenDim, numLayers, rng);
  const frontHead = {
    W: xavierInit(FRONT_DIM, hiddenDim, rng),
    b: makeMat(FRONT_DIM, 1),
  };
  const backHead = {
    W: xavierInit(BACK_DIM, hiddenDim, rng),
    b: makeMat(BACK_DIM, 1),
  };
  return {
    type: "dlt-lstm-v1",
    hiddenDim, numLayers,
    dropoutInput, dropoutHidden, dropoutOutput,
    stack, frontHead, backHead,
  };
}

export function forwardDltModel(model, sequence, { training = false, rng = Math.random } = {}) {
  const fwd = stackedForward(model.stack, sequence, {
    training,
    dropoutIn: model.dropoutInput,
    dropoutHidden: model.dropoutHidden,
    rng,
  });
  let hForHead = fwd.hLast;
  let outputMask = null;
  if (training && model.dropoutOutput > 0) {
    outputMask = makeDropoutMask(hForHead.rows, hForHead.cols, model.dropoutOutput, rng);
    hForHead = hadamard(hForHead, outputMask);
  }
  const fLogits = add(matmul(model.frontHead.W, hForHead), model.frontHead.b);
  const bLogits = add(matmul(model.backHead.W, hForHead), model.backHead.b);

  // 推理时应用 temperature scaling（如果 model 上有 calibration）
  let fProbs, bProbs;
  if (!training && (model.calibration?.frontT || model.calibration?.backT)) {
    const Tf = model.calibration.frontT || 1;
    const Tb = model.calibration.backT || 1;
    if (Tf !== 1) {
      const scaled = makeMat(fLogits.rows, fLogits.cols);
      for (let i = 0; i < fLogits.data.length; i++) scaled.data[i] = fLogits.data[i] / Tf;
      fProbs = sigmoid(scaled);
    } else fProbs = sigmoid(fLogits);
    if (Tb !== 1) {
      const scaled = makeMat(bLogits.rows, bLogits.cols);
      for (let i = 0; i < bLogits.data.length; i++) scaled.data[i] = bLogits.data[i] / Tb;
      bProbs = sigmoid(scaled);
    } else bProbs = sigmoid(bLogits);
  } else {
    fProbs = sigmoid(fLogits);
    bProbs = sigmoid(bLogits);
  }

  return { stackFwd: fwd, hLast: fwd.hLast, hForHead, outputMask, fLogits, fProbs, bLogits, bProbs };
}

export function dltLossAndGrads(model, sequence, target, { rng = Math.random, labelSmoothing = 0 } = {}) {
  const fwd = forwardDltModel(model, sequence, { training: true, rng });
  const T = sequence.length;
  const H = model.hiddenDim;

  let frontT = target.front;
  let backT = target.back;
  if (labelSmoothing > 0) {
    frontT = smoothBinaryTarget(target.front, labelSmoothing);
    backT = smoothBinaryTarget(target.back, labelSmoothing);
  }

  const fLoss = labelSmoothing > 0
    ? bceLossSmoothed(fwd.fProbs, target.front, labelSmoothing) / FRONT_DIM
    : bceLoss(fwd.fProbs, target.front) / FRONT_DIM;
  const bLoss = labelSmoothing > 0
    ? bceLossSmoothed(fwd.bProbs, target.back, labelSmoothing) / BACK_DIM
    : bceLoss(fwd.bProbs, target.back) / BACK_DIM;
  const totalLoss = fLoss + BACK_LOSS_WEIGHT * bLoss;

  // 反向 head（用 soft target）
  const dF = sigmoidBCEBackward(fwd.fProbs, frontT);
  for (let i = 0; i < dF.data.length; i++) dF.data[i] /= FRONT_DIM;
  const dB = sigmoidBCEBackward(fwd.bProbs, backT);
  for (let i = 0; i < dB.data.length; i++) dB.data[i] *= BACK_LOSS_WEIGHT / BACK_DIM;

  const hT = transpose(fwd.hForHead);
  const grads = {
    frontHead: {
      dW: matmul(dF, hT),
      db: makeMat(FRONT_DIM, 1),
    },
    backHead: {
      dW: matmul(dB, hT),
      db: makeMat(BACK_DIM, 1),
    },
  };
  for (let i = 0; i < dF.data.length; i++) grads.frontHead.db.data[i] = dF.data[i];
  for (let i = 0; i < dB.data.length; i++) grads.backHead.db.data[i] = dB.data[i];

  let dh = add(matmul(transpose(model.frontHead.W), dF), matmul(transpose(model.backHead.W), dB));
  if (fwd.outputMask) dh = hadamard(dh, fwd.outputMask);

  const dhFromAbove = new Array(T);
  for (let t = 0; t < T - 1; t++) dhFromAbove[t] = makeMat(H, 1);
  dhFromAbove[T - 1] = dh;

  const { grads: stackGrads } = stackedBackward(model.stack, fwd.stackFwd, dhFromAbove);
  grads.stack = stackGrads;
  return { loss: totalLoss, fLoss, bLoss, grads, fwd };
}

export function flattenDltParams(model) {
  const out = {};
  for (let l = 0; l < model.numLayers; l++) {
    out[`stack.${l}.W`] = model.stack.layers[l].params.W;
    out[`stack.${l}.U`] = model.stack.layers[l].params.U;
    out[`stack.${l}.b`] = model.stack.layers[l].params.b;
  }
  out["frontHead.W"] = model.frontHead.W;
  out["frontHead.b"] = model.frontHead.b;
  out["backHead.W"] = model.backHead.W;
  out["backHead.b"] = model.backHead.b;
  return out;
}

export function flattenDltGrads(g) {
  const out = {};
  for (let l = 0; l < g.stack.length; l++) {
    out[`stack.${l}.W`] = g.stack[l].dW;
    out[`stack.${l}.U`] = g.stack[l].dU;
    out[`stack.${l}.b`] = g.stack[l].db;
  }
  out["frontHead.W"] = g.frontHead.dW;
  out["frontHead.b"] = g.frontHead.db;
  out["backHead.W"] = g.backHead.dW;
  out["backHead.b"] = g.backHead.db;
  return out;
}

export function topKFront(fProbs, k = 5) {
  const arr = [];
  for (let i = 0; i < FRONT_DIM; i++) arr.push([i + 1, fProbs.data[i]]);
  arr.sort((a, b) => b[1] - a[1]);
  return arr.slice(0, k);
}

export function topKBack(bProbs, k = 2) {
  const arr = [];
  for (let i = 0; i < BACK_DIM; i++) arr.push([i + 1, bProbs.data[i]]);
  arr.sort((a, b) => b[1] - a[1]);
  return arr.slice(0, k);
}

export function serializeDltModel(model) {
  const flat = (m) => ({ rows: m.rows, cols: m.cols, data: Array.from(m.data) });
  return {
    type: "dlt-lstm-v1",
    hiddenDim: model.hiddenDim,
    numLayers: model.numLayers,
    dropoutInput: model.dropoutInput,
    dropoutHidden: model.dropoutHidden,
    dropoutOutput: model.dropoutOutput,
    stack: serializeStack(model.stack),
    frontHead: { W: flat(model.frontHead.W), b: flat(model.frontHead.b) },
    backHead: { W: flat(model.backHead.W), b: flat(model.backHead.b) },
    calibration: model.calibration || null,
  };
}

export function deserializeDltModel(obj) {
  const inflate = (m) => ({ rows: m.rows, cols: m.cols, data: new Float32Array(m.data) });
  return {
    type: "dlt-lstm-v1",
    hiddenDim: obj.hiddenDim,
    numLayers: obj.numLayers,
    dropoutInput: obj.dropoutInput || 0,
    dropoutHidden: obj.dropoutHidden || 0,
    dropoutOutput: obj.dropoutOutput || 0,
    stack: deserializeStack(obj.stack),
    frontHead: { W: inflate(obj.frontHead.W), b: inflate(obj.frontHead.b) },
    backHead: { W: inflate(obj.backHead.W), b: inflate(obj.backHead.b) },
    calibration: obj.calibration || null,
  };
}
