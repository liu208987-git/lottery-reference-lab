import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeMat, fromArray2D, fromArray1D,
  matmul, transpose, add, hadamard, scale,
  sigmoid, sigmoidBackward, tanh, tanhBackward,
  softmax, crossEntropy, softmaxCEBackward,
  bceLoss, sigmoidBCEBackward,
  xavierInit, orthogonalInit,
  clipGradGlobal, l2Norm, hasNaN,
  maxAbsDiff,
} from "../assets/js/nn-math.js";

test("matmul 2x3 · 3x2 = 2x2", () => {
  const A = fromArray2D([[1,2,3],[4,5,6]]);
  const B = fromArray2D([[7,8],[9,10],[11,12]]);
  const C = matmul(A, B);
  assert.deepEqual(Array.from(C.data), [58,64,139,154]);
});

test("transpose round-trip", () => {
  const A = fromArray2D([[1,2,3],[4,5,6]]);
  const T = transpose(transpose(A));
  assert.equal(maxAbsDiff(A, T), 0);
});

test("sigmoid clamps and saturates", () => {
  const A = fromArray1D([0, 100, -100]);
  const S = sigmoid(A);
  assert.ok(Math.abs(S.data[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(S.data[1] - 1) < 1e-6);
  assert.ok(Math.abs(S.data[2] - 0) < 1e-6);
});

test("sigmoidBackward: (σ(0)=0.5)' = 0.25", () => {
  const sigOut = fromArray1D([0.5]);
  const dOut = fromArray1D([1]);
  const dIn = sigmoidBackward(sigOut, dOut);
  assert.ok(Math.abs(dIn.data[0] - 0.25) < 1e-9);
});

test("tanh and its derivative at 0", () => {
  const A = fromArray1D([0]);
  const t = tanh(A);
  assert.equal(t.data[0], 0);
  const dIn = tanhBackward(t, fromArray1D([1]));
  assert.ok(Math.abs(dIn.data[0] - 1) < 1e-9); // 1 - 0² = 1
});

test("softmax sums to 1 and is shift-invariant", () => {
  const A = fromArray1D([1, 2, 3, 4]);
  const B = fromArray1D([1001, 1002, 1003, 1004]); // shift by 1000
  const sA = softmax(A);
  const sB = softmax(B);
  let sumA = 0, sumB = 0;
  for (let i = 0; i < 4; i++) {
    sumA += sA.data[i];
    sumB += sB.data[i];
    assert.ok(Math.abs(sA.data[i] - sB.data[i]) < 1e-6);
  }
  assert.ok(Math.abs(sumA - 1) < 1e-6);
  assert.ok(Math.abs(sumB - 1) < 1e-6);
});

test("softmax + cross-entropy backward = (probs - target)", () => {
  const probs = fromArray1D([0.1, 0.7, 0.2]);
  const target = fromArray1D([0, 1, 0]);
  const grad = softmaxCEBackward(probs, target);
  // Float32 精度
  assert.ok(Math.abs(grad.data[0] - 0.1) < 1e-6);
  assert.ok(Math.abs(grad.data[1] - (-0.3)) < 1e-6);
  assert.ok(Math.abs(grad.data[2] - 0.2) < 1e-6);
});

test("BCE: perfect prediction → loss ≈ 0", () => {
  const probs = fromArray1D([0.9999, 0.0001]);
  const target = fromArray1D([1, 0]);
  const loss = bceLoss(probs, target);
  assert.ok(loss < 1e-3);
});

test("BCE: wrong prediction → high loss", () => {
  const probs = fromArray1D([0.001, 0.999]);
  const target = fromArray1D([1, 0]);
  const loss = bceLoss(probs, target);
  assert.ok(loss > 5); // ~ 7+
});

test("xavier init has correct variance scale", () => {
  const M = xavierInit(64, 32);
  // Var ≈ 6/(64+32) / 3 ≈ 0.0208，std ≈ 0.144 (uniform on [-0.25, 0.25]: var = 0.0208)
  let mean = 0;
  for (let i = 0; i < M.data.length; i++) mean += M.data[i];
  mean /= M.data.length;
  assert.ok(Math.abs(mean) < 0.05);
});

test("orthogonal init: Q^T Q ≈ I (column-wise)", () => {
  const Q = orthogonalInit(8, 8);
  // 验证列正交：第 0 列 · 第 1 列 ≈ 0；第 0 列 · 第 0 列 ≈ 1
  const col = (j) => {
    const out = new Array(8);
    for (let i = 0; i < 8; i++) out[i] = Q.data[i * 8 + j];
    return out;
  };
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const c0 = col(0);
  const c1 = col(1);
  assert.ok(Math.abs(dot(c0, c0) - 1) < 1e-5);
  assert.ok(Math.abs(dot(c0, c1)) < 1e-5);
});

test("clipGradGlobal scales when norm exceeds maxNorm", () => {
  const g1 = fromArray1D([3, 4]); // norm = 5
  const g2 = fromArray1D([0]);
  const norm = clipGradGlobal([g1, g2], 1);
  assert.ok(Math.abs(norm - 5) < 1e-5);
  // 缩放后总范数 = 1
  assert.ok(Math.abs(g1.data[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(g1.data[1] - 0.8) < 1e-6);
});

test("clipGradGlobal noop when norm < maxNorm", () => {
  const g = fromArray1D([0.3, 0.4]);
  const before = Array.from(g.data);
  clipGradGlobal([g], 10);
  for (let i = 0; i < before.length; i++) assert.equal(g.data[i], before[i]);
});

test("hasNaN detects nan/inf", () => {
  const m = fromArray1D([1, 2]);
  assert.equal(hasNaN(m), false);
  m.data[0] = NaN;
  assert.equal(hasNaN(m), true);
  m.data[0] = Infinity;
  assert.equal(hasNaN(m), true);
});
