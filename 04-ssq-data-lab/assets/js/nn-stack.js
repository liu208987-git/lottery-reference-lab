// 多层 LSTM 堆叠 + 输入/输出 dropout
//
// 经典做法（参见 Zaremba 2014 "Recurrent Neural Network Regularization"）：
//   只在垂直方向（层间）加 dropout，时间方向不加，这样 cell 状态不会被噪声污染。
//
//   x_t                  →  dropout_in  →  LSTM₁  →  dropout(h¹_t)  →  LSTM₂  →  ...  →  LSTM_L
//                                          h¹_t                       h²_t                h^L_t
//
// 推理（mode="eval"）：所有 dropout 等价于恒等映射。

import {
  createLSTM, lstmStepForward, lstmStepBackward,
  serializeLSTM, deserializeLSTM,
} from "./nn-lstm.js";
import { makeMat, makeDropoutMask, hadamard, add } from "./nn-math.js";

/** 构造 numLayers 层堆叠 LSTM。 */
export function createStackedLSTM(inputDim, hiddenDim, numLayers = 1, rng = Math.random) {
  const layers = [];
  for (let l = 0; l < numLayers; l++) {
    const inDim = l === 0 ? inputDim : hiddenDim;
    layers.push(createLSTM(inDim, hiddenDim, rng));
  }
  return { inputDim, hiddenDim, numLayers, layers };
}

/**
 * 前向：返回每层每时间步的 h、c、cache 与 dropout mask。
 * @param stack 堆叠 LSTM
 * @param xs 序列 [x_1, x_2, ..., x_T]，每个 x_t 是 inputDim×1
 * @param opts.dropoutIn  在第一层之前对 x_t 做 dropout
 * @param opts.dropoutHidden 在层间对 h_t 做 dropout
 * @param opts.training true=训练（启用 dropout）
 * @param opts.rng
 */
export function stackedForward(stack, xs, opts = {}) {
  const { dropoutIn = 0, dropoutHidden = 0, training = false, rng = Math.random } = opts;
  const T = xs.length;
  const L = stack.numLayers;
  const H = stack.hiddenDim;

  // 每层每时间步的状态
  const allH = Array.from({ length: L }, () => new Array(T));
  const allC = Array.from({ length: L }, () => new Array(T));
  const allCache = Array.from({ length: L }, () => new Array(T));
  const inputMasks = new Array(T);     // dropout 应用在原始 x_t
  const layerMasks = Array.from({ length: L - 1 }, () => new Array(T)); // 层间 mask

  // 起始 hidden / cell（全 0）
  let hPrev = Array.from({ length: L }, () => makeMat(H, 1));
  let cPrev = Array.from({ length: L }, () => makeMat(H, 1));

  for (let t = 0; t < T; t++) {
    let curInput = xs[t];

    // 输入 dropout
    if (training && dropoutIn > 0) {
      const mask = makeDropoutMask(curInput.rows, curInput.cols, dropoutIn, rng);
      inputMasks[t] = mask;
      curInput = hadamard(curInput, mask);
    } else {
      inputMasks[t] = null;
    }

    for (let l = 0; l < L; l++) {
      const out = lstmStepForward(stack.layers[l], curInput, hPrev[l], cPrev[l]);
      allH[l][t] = out.h;
      allC[l][t] = out.c;
      allCache[l][t] = out.cache;
      hPrev[l] = out.h;
      cPrev[l] = out.c;

      // 给下一层的输入：如果不是最后一层，可能加 dropout
      if (l < L - 1) {
        let next = out.h;
        if (training && dropoutHidden > 0) {
          const mask = makeDropoutMask(H, 1, dropoutHidden, rng);
          layerMasks[l][t] = mask;
          next = hadamard(next, mask);
        } else {
          layerMasks[l][t] = null;
        }
        curInput = next;
      }
    }
  }

  return {
    allH, allC, allCache,
    inputMasks, layerMasks,
    hLast: allH[L - 1][T - 1],
    cLast: allC[L - 1][T - 1],
  };
}

/**
 * 反向：dhFromAbove[t] 是 dL/dh_t（最顶层的梯度），来自输出头。
 * 返回每层的 grads 与 dx（用于嵌入层之类的，本项目里 x 是 one-hot 输入，dx 不再向前传）。
 */
export function stackedBackward(stack, fwd, dhFromAbove) {
  const { allCache, inputMasks, layerMasks } = fwd;
  const L = stack.numLayers;
  const T = allCache[0].length;
  const H = stack.hiddenDim;

  const grads = stack.layers.map((layer) => ({
    dW: makeMat(layer.params.W.rows, layer.params.W.cols),
    dU: makeMat(layer.params.U.rows, layer.params.U.cols),
    db: makeMat(layer.params.b.rows, layer.params.b.cols),
  }));

  // 给最顶层每时间步注入 dh
  // 反向 BPTT：从最后一层开始，往下传播 dx 给上一层（dx 充当下层的 dh 来源之一）
  // 简化结构：先逐层时间步反向得到 dx，再把 dx 加到下一层的 dh

  // 准备每层的 dh 序列（最顶层 = dhFromAbove；中间层 = 来自上层的 dx + 时间方向的 dhPrev）
  let dhPerLayer = Array.from({ length: L }, () => new Array(T));
  for (let t = 0; t < T; t++) dhPerLayer[L - 1][t] = dhFromAbove[t] || makeMat(H, 1);
  for (let l = L - 2; l >= 0; l--) for (let t = 0; t < T; t++) dhPerLayer[l][t] = makeMat(H, 1);

  // 反向：从顶层往底层
  for (let l = L - 1; l >= 0; l--) {
    let dhNext = makeMat(H, 1);
    let dcNext = makeMat(H, 1);
    for (let t = T - 1; t >= 0; t--) {
      // 时间方向 dhNext 加上来自顶部（output head 或 layer 间） 的 dh
      const dh = add(dhPerLayer[l][t], dhNext);
      const { dx, dhPrev, dcPrev } = lstmStepBackward(
        dh, dcNext, allCache[l][t], stack.layers[l], grads[l]
      );
      dhNext = dhPrev;
      dcNext = dcPrev;

      // 把 dx 当作下一层（l-1）的 dh 加进去
      if (l > 0) {
        let dxToBelow = dx;
        // 经过 layerMasks[l-1][t] 的反向：mask ⊙ dx
        const mask = layerMasks[l - 1] && layerMasks[l - 1][t];
        if (mask) dxToBelow = hadamard(dx, mask);
        // 累加到 dhPerLayer[l-1][t]
        for (let i = 0; i < H; i++) dhPerLayer[l - 1][t].data[i] += dxToBelow.data[i];
      } else {
        // 第 0 层的 dx 经过 inputMask 反向（如果有），但因为 x 是 one-hot 不再向上传，不需要进一步处理
        // 这里只需把 dxs 输出供调用方使用（在我们的 ssq-model 里不需要）
      }
    }
  }

  return { grads };
}

export function serializeStack(stack) {
  return {
    type: "stacked-lstm",
    inputDim: stack.inputDim,
    hiddenDim: stack.hiddenDim,
    numLayers: stack.numLayers,
    layers: stack.layers.map(serializeLSTM),
  };
}

export function deserializeStack(obj) {
  return {
    inputDim: obj.inputDim,
    hiddenDim: obj.hiddenDim,
    numLayers: obj.numLayers,
    layers: obj.layers.map(deserializeLSTM),
  };
}
