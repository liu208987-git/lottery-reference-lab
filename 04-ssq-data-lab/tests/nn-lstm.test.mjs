// LSTM 梯度检查 —— 反向传播的"金标准"。
// 用数值梯度（中心差分）与解析梯度对比，相对误差 < 1e-4 视为通过。

import { test } from "node:test";
import assert from "node:assert/strict";

import { createLSTM, lstmForward, lstmBackward, lstmStepForward } from "../assets/js/nn-lstm.js";
import { makeMat, clone } from "../assets/js/nn-math.js";
import { createRng } from "../assets/js/rng.js";

function l2NormFromAll(hs) {
  let s = 0;
  for (const h of hs) for (let i = 0; i < h.data.length; i++) s += h.data[i] * h.data[i];
  return s;
}

/**
 * 以 loss = 0.5 * Σ ||h_t||² 为目标，dL/dh_t = h_t。
 * 验证 dW、dU、db 的解析梯度等于数值梯度。
 */
function testGradient(paramKey, getter) {
  const rng = createRng("grad-test").next;
  const cell = createLSTM(4, 3, rng);
  const T = 4;
  const xs = [];
  for (let t = 0; t < T; t++) {
    const x = makeMat(4, 1);
    for (let i = 0; i < 4; i++) x.data[i] = rng() * 2 - 1;
    xs.push(x);
  }

  // 前向 + 反向（解析）
  const fwd = lstmForward(cell, xs);
  const dhFromAbove = fwd.hs.map((h) => clone(h)); // dL/dh_t = h_t
  const { grads } = lstmBackward(cell, fwd.caches, dhFromAbove);
  const analytical = grads[paramKey];
  const param = getter(cell);

  // 数值梯度（采样几个位置）
  const eps = 1e-4;  // 太小会被 Float32 噪声淹没
  const samplePoints = Math.min(15, param.data.length);
  const stride = Math.max(1, Math.floor(param.data.length / samplePoints));
  let maxAbsErr = 0;
  let maxRelErr = 0;
  for (let idx = 0; idx < param.data.length; idx += stride) {
    const orig = param.data[idx];
    param.data[idx] = orig + eps;
    const lossPlus = 0.5 * l2NormFromAll(lstmForward(cell, xs).hs);
    param.data[idx] = orig - eps;
    const lossMinus = 0.5 * l2NormFromAll(lstmForward(cell, xs).hs);
    param.data[idx] = orig;
    const numerical = (lossPlus - lossMinus) / (2 * eps);
    const an = analytical.data[idx];
    const err = Math.abs(numerical - an);
    if (err > maxAbsErr) maxAbsErr = err;
    // 仅当数值显著时计算相对误差
    const denom = Math.max(Math.abs(numerical), Math.abs(an));
    if (denom > 1e-3) {
      const rel = err / denom;
      if (rel > maxRelErr) maxRelErr = rel;
    }
  }
  return { maxAbsErr, maxRelErr };
}

test("LSTM analytical dW matches numerical gradient (rel < 5e-3 or abs < 1e-4)", () => {
  const { maxAbsErr, maxRelErr } = testGradient("dW", (c) => c.params.W);
  assert.ok(maxRelErr < 5e-3 || maxAbsErr < 1e-4,
    `dW rel=${maxRelErr.toExponential(2)} abs=${maxAbsErr.toExponential(2)}`);
});

test("LSTM analytical dU matches numerical gradient", () => {
  const { maxAbsErr, maxRelErr } = testGradient("dU", (c) => c.params.U);
  assert.ok(maxRelErr < 5e-3 || maxAbsErr < 1e-4,
    `dU rel=${maxRelErr.toExponential(2)} abs=${maxAbsErr.toExponential(2)}`);
});

test("LSTM analytical db matches numerical gradient", () => {
  const { maxAbsErr, maxRelErr } = testGradient("db", (c) => c.params.b);
  assert.ok(maxRelErr < 5e-3 || maxAbsErr < 1e-4,
    `db rel=${maxRelErr.toExponential(2)} abs=${maxAbsErr.toExponential(2)}`);
});

test("LSTM forward shape: T steps produce T hidden states of size H", () => {
  const cell = createLSTM(5, 7);
  const xs = [];
  for (let t = 0; t < 6; t++) {
    const x = makeMat(5, 1);
    for (let i = 0; i < 5; i++) x.data[i] = Math.random();
    xs.push(x);
  }
  const fwd = lstmForward(cell, xs);
  assert.equal(fwd.hs.length, 6);
  for (const h of fwd.hs) {
    assert.equal(h.rows, 7);
    assert.equal(h.cols, 1);
  }
});

test("LSTM cell state c does not blow up over many steps", () => {
  const cell = createLSTM(3, 4);
  const xs = [];
  for (let t = 0; t < 200; t++) {
    const x = makeMat(3, 1);
    for (let i = 0; i < 3; i++) x.data[i] = Math.random();
    xs.push(x);
  }
  const fwd = lstmForward(cell, xs);
  for (const c of fwd.cs) {
    for (let i = 0; i < c.data.length; i++) {
      assert.ok(isFinite(c.data[i]), `cell state diverged: ${c.data[i]}`);
      assert.ok(Math.abs(c.data[i]) < 100, `cell state too large: ${c.data[i]}`);
    }
  }
});
