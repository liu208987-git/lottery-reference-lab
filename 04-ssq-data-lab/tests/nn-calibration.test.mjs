import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMat } from "../assets/js/nn-math.js";
import {
  fitTemperatureSigmoid, fitTemperatureSoftmax,
  applyTemperatureSigmoid, applyTemperatureSoftmax,
  lcbScore, topKByLCB,
} from "../assets/js/nn-calibration.js";
import {
  smoothBinaryTarget, smoothCategoricalTarget,
  bceLossSmoothed, crossEntropySmoothed,
} from "../assets/js/nn-math.js";

/* ============================================================
 *  Label smoothing 单测
 * ============================================================ */

test("smoothBinaryTarget: 1 → 1-ε, 0 → ε", () => {
  const t = makeMat(4, 1);
  t.data.set([1, 0, 1, 0]);
  const s = smoothBinaryTarget(t, 0.05);
  assert.ok(Math.abs(s.data[0] - 0.95) < 1e-6);
  assert.ok(Math.abs(s.data[1] - 0.05) < 1e-6);
  assert.ok(Math.abs(s.data[2] - 0.95) < 1e-6);
  assert.ok(Math.abs(s.data[3] - 0.05) < 1e-6);
});

test("smoothCategoricalTarget: K=4, ε=0.04 → one-hot 0.97 / 其它 0.01", () => {
  const t = makeMat(4, 1);
  t.data.set([1, 0, 0, 0]);
  const s = smoothCategoricalTarget(t, 0.04);
  assert.ok(Math.abs(s.data[0] - (1 - 0.04 + 0.01)) < 1e-6, `s[0]=${s.data[0]}`);
  for (let i = 1; i < 4; i++) {
    assert.ok(Math.abs(s.data[i] - 0.01) < 1e-6);
  }
});

test("bceLossSmoothed: ε=0 时等于原 bceLoss", async () => {
  const { bceLoss } = await import("../assets/js/nn-math.js");
  const probs = makeMat(3, 1);
  probs.data.set([0.7, 0.3, 0.5]);
  const target = makeMat(3, 1);
  target.data.set([1, 0, 1]);
  const lOrig = bceLoss(probs, target);
  const lSmooth0 = bceLossSmoothed(probs, target, 0);
  assert.ok(Math.abs(lOrig - lSmooth0) < 1e-6);
});

test("bceLossSmoothed: ε > 0 时对完美预测仍有非零 loss（防过拟合）", async () => {
  const { bceLoss } = await import("../assets/js/nn-math.js");
  const probs = makeMat(2, 1);
  probs.data.set([0.999, 0.001]);
  const target = makeMat(2, 1);
  target.data.set([1, 0]);
  const lOrig = bceLoss(probs, target);
  const lSmooth = bceLossSmoothed(probs, target, 0.1);
  assert.ok(lSmooth > lOrig, `smoothed ${lSmooth} should be > original ${lOrig}`);
});

test("crossEntropySmoothed: ε=0 等于 crossEntropy", async () => {
  const { crossEntropy } = await import("../assets/js/nn-math.js");
  const probs = makeMat(4, 1);
  probs.data.set([0.7, 0.1, 0.1, 0.1]);
  const target = makeMat(4, 1);
  target.data.set([1, 0, 0, 0]);
  const lOrig = crossEntropy(probs, target);
  const lSmooth0 = crossEntropySmoothed(probs, target, 0);
  assert.ok(Math.abs(lOrig - lSmooth0) < 1e-6);
});

/* ============================================================
 *  Temperature scaling 单测
 * ============================================================ */

test("fitTemperatureSigmoid: 完美校准数据 T 应接近 1", () => {
  // 构造数据：logit = inverseSigmoid(target_freq) ⇒ 已经校准
  const N = 200;
  const logitsList = [], targetsList = [];
  for (let n = 0; n < N; n++) {
    const z = makeMat(5, 1);
    const t = makeMat(5, 1);
    for (let i = 0; i < 5; i++) {
      const p = 0.1 + 0.15 * i; // 0.1, 0.25, 0.4, 0.55, 0.7
      z.data[i] = Math.log(p / (1 - p));
      // 按 p 概率掷
      t.data[i] = Math.random() < p ? 1 : 0;
    }
    logitsList.push(z);
    targetsList.push(t);
  }
  const r = fitTemperatureSigmoid(logitsList, targetsList);
  // T 应接近 1（在大样本下 ±0.3 内）
  assert.ok(Math.abs(r.T - 1) < 0.5, `T=${r.T} should be ≈ 1`);
});

test("fitTemperatureSigmoid: 过自信数据（logit 放大）拟合出 T > 1", () => {
  const N = 500;
  const logitsList = [], targetsList = [];
  for (let n = 0; n < N; n++) {
    const z = makeMat(5, 1);
    const t = makeMat(5, 1);
    for (let i = 0; i < 5; i++) {
      const trueP = 0.3;
      // 真实标签按 trueP 抽，但 logit 故意放大 3 倍（模拟过自信）
      const truLogit = Math.log(trueP / (1 - trueP));
      z.data[i] = truLogit * 3;
      t.data[i] = Math.random() < trueP ? 1 : 0;
    }
    logitsList.push(z);
    targetsList.push(t);
  }
  const r = fitTemperatureSigmoid(logitsList, targetsList);
  // 过自信，T 应该 > 1.5（把 logit 拉回 / 3）
  assert.ok(r.T > 1.5, `T=${r.T} should be > 1.5 for overconfident model`);
  // ECE 应该改善
  assert.ok(r.eceAtT < r.eceAt1, `eceAtT=${r.eceAtT} should be < eceAt1=${r.eceAt1}`);
});

test("fitTemperatureSigmoid: 欠自信数据 T < 1", () => {
  const N = 500;
  const logitsList = [], targetsList = [];
  for (let n = 0; n < N; n++) {
    const z = makeMat(5, 1);
    const t = makeMat(5, 1);
    for (let i = 0; i < 5; i++) {
      const trueP = 0.7;
      const truLogit = Math.log(trueP / (1 - trueP));
      z.data[i] = truLogit * 0.4;  // 欠自信
      t.data[i] = Math.random() < trueP ? 1 : 0;
    }
    logitsList.push(z);
    targetsList.push(t);
  }
  const r = fitTemperatureSigmoid(logitsList, targetsList);
  assert.ok(r.T < 0.7, `T=${r.T} should be < 0.7 for underconfident model`);
});

test("applyTemperatureSigmoid T=1 等于普通 sigmoid", () => {
  const z = makeMat(3, 1);
  z.data.set([0, 1, -1]);
  const out = applyTemperatureSigmoid(z, 1);
  assert.ok(Math.abs(out.data[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(out.data[1] - 1 / (1 + Math.exp(-1))) < 1e-6);
  assert.ok(Math.abs(out.data[2] - 1 / (1 + Math.exp(1))) < 1e-6);
});

test("applyTemperatureSigmoid T>1 把概率拉向 0.5", () => {
  const z = makeMat(2, 1);
  z.data.set([3, -3]);    // 在 T=1 下为 0.95 / 0.05
  const at1 = applyTemperatureSigmoid(z, 1);
  const at5 = applyTemperatureSigmoid(z, 5);
  assert.ok(at5.data[0] < at1.data[0]);  // 0.95 → 更小
  assert.ok(at5.data[1] > at1.data[1]);  // 0.05 → 更大
  // 都向 0.5 靠近
  assert.ok(Math.abs(at5.data[0] - 0.5) < Math.abs(at1.data[0] - 0.5));
});

test("applyTemperatureSoftmax 不改变 argmax", () => {
  const z = makeMat(4, 1);
  z.data.set([0.5, 2.0, 1.0, -1.0]);
  for (const T of [0.5, 1, 2, 5]) {
    const p = applyTemperatureSoftmax(z, T);
    let max = -1, argmax = -1;
    for (let i = 0; i < 4; i++) if (p.data[i] > max) { max = p.data[i]; argmax = i; }
    assert.equal(argmax, 1, `T=${T}: argmax should be 1, got ${argmax}`);
  }
});

test("applyTemperatureSoftmax sum to 1", () => {
  const z = makeMat(4, 1);
  z.data.set([1, 2, 3, 4]);
  const p = applyTemperatureSoftmax(z, 2);
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += p.data[i];
  assert.ok(Math.abs(sum - 1) < 1e-6);
});

test("fitTemperatureSoftmax: 过自信数据 T > 1", () => {
  const N = 400;
  const logitsList = [], targetsList = [];
  // 真实分布 [0.5, 0.3, 0.15, 0.05]
  const trueP = [0.5, 0.3, 0.15, 0.05];
  for (let n = 0; n < N; n++) {
    const z = makeMat(4, 1);
    const t = makeMat(4, 1);
    // logit 放大 3 倍模拟过自信
    for (let i = 0; i < 4; i++) z.data[i] = Math.log(trueP[i]) * 3;
    // 按真实分布抽
    let r = Math.random();
    let cum = 0, hit = 3;
    for (let i = 0; i < 4; i++) { cum += trueP[i]; if (r <= cum) { hit = i; break; } }
    t.data[hit] = 1;
    logitsList.push(z);
    targetsList.push(t);
  }
  const r = fitTemperatureSoftmax(logitsList, targetsList);
  assert.ok(r.T > 1.3, `T=${r.T} should be > 1.3`);
  assert.ok(r.eceAtT < r.eceAt1 + 1e-6, `eceAtT=${r.eceAtT} not better than ${r.eceAt1}`);
});

/* ============================================================
 *  LCB ranking 单测
 * ============================================================ */

test("lcbScore: λ·σ 越大分数越低", () => {
  assert.ok(lcbScore(0.5, 0.1, 1) > lcbScore(0.5, 0.3, 1));
  assert.ok(lcbScore(0.5, 0.0, 1) === 0.5);
  assert.ok(lcbScore(0.5, 0.2, 0) === 0.5); // λ=0 时不惩罚 std
});

test("topKByLCB: 高 std 的高均值号被低 std 的中等均值号反超（λ 足够大时）", () => {
  // 5 个号：1 号 μ=0.5 σ=0.4, 2 号 μ=0.3 σ=0.05, 3-5 号 μ=0.2 σ=0.05
  const means = makeMat(5, 1);
  means.data.set([0.5, 0.3, 0.2, 0.2, 0.2]);
  const stds = makeMat(5, 1);
  stds.data.set([0.4, 0.05, 0.05, 0.05, 0.05]);
  // λ=0：选 1 号最高
  const t0 = topKByLCB(means, stds, 1, 0);
  assert.equal(t0[0][0], 1);
  // λ=2：1 号 score=0.5-0.8=-0.3, 2 号 score=0.3-0.1=0.2 → 2 号反超
  const t2 = topKByLCB(means, stds, 1, 2);
  assert.equal(t2[0][0], 2);
});

test("topKByLCB 返回正好 k 个", () => {
  const means = makeMat(10, 1);
  const stds = makeMat(10, 1);
  for (let i = 0; i < 10; i++) {
    means.data[i] = Math.random();
    stds.data[i] = Math.random() * 0.1;
  }
  const t = topKByLCB(means, stds, 3);
  assert.equal(t.length, 3);
});
