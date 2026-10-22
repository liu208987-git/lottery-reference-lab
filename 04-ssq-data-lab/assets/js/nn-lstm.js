// LSTM 单层 cell（Hochreiter & Schmidhuber, 1997）
//
// 数学：在每个时间步 t，给定 x_t (输入) 与 h_{t-1}、c_{t-1}：
//   z_t = W·x_t + U·h_{t-1} + b              （4H×D + 4H×H + 4H×1，把 4 个门一次算完）
//   i_t, f_t, g_t, o_t = split(z_t, 4)
//   i_t = σ(z_i)        输入门（input gate）
//   f_t = σ(z_f)        遗忘门（forget gate）
//   g_t = tanh(z_g)     候选状态（cell candidate）
//   o_t = σ(z_o)        输出门（output gate）
//   c_t = f_t ⊙ c_{t-1} + i_t ⊙ g_t           cell 状态
//   h_t = o_t ⊙ tanh(c_t)                     隐藏状态（输出）
//
// BPTT 反向（参见 Christopher Olah 的推导，全部用矩阵形式）：
//   给上层 dh_t（来自下一时间步与下一层）+ dc_t（来自下一时间步）：
//     dot   = dh_t ⊙ tanh(c_t)
//     dc_t += dh_t ⊙ o_t ⊙ (1 - tanh²(c_t))
//     di    = dc_t ⊙ g_t
//     df    = dc_t ⊙ c_{t-1}
//     dg    = dc_t ⊙ i_t
//     dc_{t-1} = dc_t ⊙ f_t
//   再各自乘 sigmoid' 或 tanh'，得到 dz_i / dz_f / dz_g / dz_o
//   汇总：dz = stack(dz_i, dz_f, dz_g, dz_o) (4H×1)
//   dW += dz · x_t^T
//   dU += dz · h_{t-1}^T
//   db += dz
//   dx_t = W^T · dz
//   dh_{t-1} = U^T · dz
//
// 我们采用 forget-bias=1.0 的初始化（Jozefowicz 2015），帮助初期梯度流。

import {
  makeMat, zero, copyInto, clone,
  matmul, matmulAdd, transpose, add, hadamard, scale,
  sigmoid, sigmoidBackward, tanh, tanhBackward,
  xavierInit, orthogonalInit,
} from "./nn-math.js";

/** 创建 LSTM 单层参数。inputDim, hiddenDim. */
export function createLSTM(inputDim, hiddenDim, rng = Math.random) {
  const H = hiddenDim;
  const D = inputDim;
  const W = xavierInit(4 * H, D, rng);     // input-to-hidden (input/forget/cell/output 拼接)
  const U = orthogonalInit(4 * H, H, rng); // hidden-to-hidden（正交初始化更稳定）
  const b = makeMat(4 * H, 1);
  // forget-gate bias = 1（Jozefowicz 2015）
  for (let i = H; i < 2 * H; i++) b.data[i] = 1.0;
  return {
    inputDim, hiddenDim,
    params: { W, U, b },
  };
}

/** 单时间步前向，缓存中间量供 BPTT 用。 */
export function lstmStepForward(cell, x, hPrev, cPrev) {
  const { W, U, b } = cell.params;
  const H = cell.hiddenDim;
  // z = W·x + U·hPrev + b
  const Wx = matmul(W, x);
  const Uh = matmul(U, hPrev);
  const z = add(add(Wx, Uh), b);

  // 切分四块
  const zi = sliceRows(z, 0, H);
  const zf = sliceRows(z, H, 2 * H);
  const zg = sliceRows(z, 2 * H, 3 * H);
  const zo = sliceRows(z, 3 * H, 4 * H);

  const i = sigmoid(zi);
  const f = sigmoid(zf);
  const g = tanh(zg);
  const o = sigmoid(zo);

  // c_t = f ⊙ cPrev + i ⊙ g
  const c = makeMat(H, 1);
  for (let r = 0; r < H; r++) c.data[r] = f.data[r] * cPrev.data[r] + i.data[r] * g.data[r];

  // tanh(c_t) 与 h_t = o ⊙ tanh(c_t)
  const tanhC = tanh(c);
  const h = makeMat(H, 1);
  for (let r = 0; r < H; r++) h.data[r] = o.data[r] * tanhC.data[r];

  return {
    h, c,
    cache: { x, hPrev, cPrev, i, f, g, o, c, tanhC },
  };
}

/**
 * 单时间步反向。
 * @param dh dL/dh_t  来自上层与下一时间步（dh_next）
 * @param dc dL/dc_t  来自下一时间步（dc_next）
 * @param cache 由 lstmStepForward 返回
 * @param cell  LSTM 实例
 * @param grads { dW, dU, db } 累加器
 * @returns { dx, dhPrev, dcPrev }
 */
export function lstmStepBackward(dh, dc, cache, cell, grads) {
  const { W, U } = cell.params;
  const H = cell.hiddenDim;
  const { x, hPrev, cPrev, i, f, g, o, c, tanhC } = cache;

  // h_t = o ⊙ tanh(c_t)
  const dot = makeMat(H, 1);
  const dcLocal = makeMat(H, 1);
  for (let r = 0; r < H; r++) {
    dot.data[r] = dh.data[r] * tanhC.data[r];
    dcLocal.data[r] = dh.data[r] * o.data[r] * (1 - tanhC.data[r] * tanhC.data[r]) + dc.data[r];
  }

  // di, df, dg, dcPrev 都来自 c_t = f⊙cPrev + i⊙g
  const di = makeMat(H, 1);
  const df = makeMat(H, 1);
  const dgRaw = makeMat(H, 1);
  const dcPrev = makeMat(H, 1);
  for (let r = 0; r < H; r++) {
    di.data[r] = dcLocal.data[r] * g.data[r];
    df.data[r] = dcLocal.data[r] * cPrev.data[r];
    dgRaw.data[r] = dcLocal.data[r] * i.data[r];
    dcPrev.data[r] = dcLocal.data[r] * f.data[r];
  }

  // 经过 sigmoid / tanh 反向，得到 dz_i / dz_f / dz_g / dz_o
  const dzi = sigmoidBackward(i, di);
  const dzf = sigmoidBackward(f, df);
  const dzg = tanhBackward(g, dgRaw);
  const dzo = sigmoidBackward(o, dot);

  // 拼接成 dz (4H×1)
  const dz = makeMat(4 * H, 1);
  for (let r = 0; r < H; r++) {
    dz.data[r] = dzi.data[r];
    dz.data[H + r] = dzf.data[r];
    dz.data[2 * H + r] = dzg.data[r];
    dz.data[3 * H + r] = dzo.data[r];
  }

  // dW += dz · x^T
  matmulAdd(grads.dW, dz, transpose(x));
  // dU += dz · hPrev^T
  matmulAdd(grads.dU, dz, transpose(hPrev));
  // db += dz
  for (let r = 0; r < dz.rows; r++) grads.db.data[r] += dz.data[r];

  // dx = W^T · dz
  const dx = matmul(transpose(W), dz);
  // dhPrev = U^T · dz
  const dhPrev = matmul(transpose(U), dz);

  return { dx, dhPrev, dcPrev };
}

function sliceRows(M, from, to) {
  const rows = to - from;
  const out = makeMat(rows, M.cols);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < M.cols; c++) out.data[r * M.cols + c] = M.data[(from + r) * M.cols + c];
  return out;
}

/** 一次性整序列前向（保留所有 h_t/c_t/cache 用于 BPTT）。 */
export function lstmForward(cell, xs, h0, c0) {
  const T = xs.length;
  const H = cell.hiddenDim;
  let h = h0 || makeMat(H, 1);
  let c = c0 || makeMat(H, 1);
  const hs = new Array(T);
  const cs = new Array(T);
  const caches = new Array(T);
  for (let t = 0; t < T; t++) {
    const { h: hNext, c: cNext, cache } = lstmStepForward(cell, xs[t], h, c);
    hs[t] = hNext;
    cs[t] = cNext;
    caches[t] = cache;
    h = hNext;
    c = cNext;
  }
  return { hs, cs, caches, hLast: h, cLast: c };
}

/** 整序列反向。dhFromAbove[t] = dL/dh_t（一般来自 output head）。 */
export function lstmBackward(cell, caches, dhFromAbove) {
  const T = caches.length;
  const H = cell.hiddenDim;
  const D = cell.inputDim;
  const grads = {
    dW: makeMat(4 * H, D),
    dU: makeMat(4 * H, H),
    db: makeMat(4 * H, 1),
  };
  let dhNext = makeMat(H, 1);
  let dcNext = makeMat(H, 1);
  const dxs = new Array(T);
  for (let t = T - 1; t >= 0; t--) {
    const dh = add(dhFromAbove[t] || makeMat(H, 1), dhNext);
    const { dx, dhPrev, dcPrev } = lstmStepBackward(dh, dcNext, caches[t], cell, grads);
    dxs[t] = dx;
    dhNext = dhPrev;
    dcNext = dcPrev;
  }
  return { grads, dxs, dh0: dhNext, dc0: dcNext };
}

/** 把 LSTM 参数序列化成可保存对象（不含 Float32Array buffer 的元信息）。 */
export function serializeLSTM(cell) {
  return {
    type: "lstm",
    inputDim: cell.inputDim,
    hiddenDim: cell.hiddenDim,
    params: {
      W: { rows: cell.params.W.rows, cols: cell.params.W.cols, data: Array.from(cell.params.W.data) },
      U: { rows: cell.params.U.rows, cols: cell.params.U.cols, data: Array.from(cell.params.U.data) },
      b: { rows: cell.params.b.rows, cols: cell.params.b.cols, data: Array.from(cell.params.b.data) },
    },
  };
}

export function deserializeLSTM(obj) {
  return {
    inputDim: obj.inputDim,
    hiddenDim: obj.hiddenDim,
    params: {
      W: { rows: obj.params.W.rows, cols: obj.params.W.cols, data: new Float32Array(obj.params.W.data) },
      U: { rows: obj.params.U.rows, cols: obj.params.U.cols, data: new Float32Array(obj.params.U.data) },
      b: { rows: obj.params.b.rows, cols: obj.params.b.cols, data: new Float32Array(obj.params.b.data) },
    },
  };
}
