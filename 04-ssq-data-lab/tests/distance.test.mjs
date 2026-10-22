import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalize,
  klDivergence,
  jsDivergence,
  jsDistance,
  wassersteinDistance,
  uniformDist,
  ticketsToFreqDist,
  samplingQualityScore,
} from "../assets/js/distance.js";

test("normalize sums to 1", () => {
  const p = normalize([1, 2, 3, 4]);
  const s = p.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(s - 1) < 1e-12);
});

test("normalize handles all-zero gracefully", () => {
  const p = normalize([0, 0, 0]);
  assert.deepEqual(p, [0, 0, 0]);
});

test("KL(P‖P) = 0", () => {
  const p = normalize([1, 2, 3, 4]);
  assert.ok(klDivergence(p, p) < 1e-12);
});

test("KL is non-negative (Gibbs inequality)", () => {
  const p = normalize([5, 1, 2]);
  const q = normalize([1, 1, 1]);
  assert.ok(klDivergence(p, q) >= 0);
  assert.ok(klDivergence(q, p) >= 0);
});

test("KL is asymmetric in general", () => {
  // 找一对真不对称的：偏度不同的分布
  const p = normalize([8, 1, 1, 1, 1]);
  const q = normalize([1, 1, 1, 1, 8]);
  const ab = klDivergence(p, q);
  const ba = klDivergence(q, p);
  // 这两个由对称性确实相等。换成非对称样本：
  const r = normalize([10, 5, 1]);
  const s = normalize([1, 2, 3]);
  assert.notEqual(klDivergence(r, s), klDivergence(s, r));
});

test("KL → ∞ when P puts mass on something Q doesn't", () => {
  const p = [0.5, 0.5, 0];
  const q = [0, 0.5, 0.5];
  assert.equal(klDivergence(p, q), Infinity);
});

test("JS is symmetric and bounded", () => {
  const p = normalize([5, 1, 1, 1]);
  const q = normalize([1, 1, 5, 1]);
  const a = jsDivergence(p, q);
  const b = jsDivergence(q, p);
  assert.ok(Math.abs(a - b) < 1e-12);
  assert.ok(a >= 0 && a <= Math.log(2) + 1e-9);
});

test("JS distance satisfies identity (P=Q ⇒ 0)", () => {
  const p = normalize([1, 2, 3, 4]);
  assert.ok(jsDistance(p, p) < 1e-9);
});

test("Wasserstein-1 of identical distributions is 0", () => {
  const p = normalize([1, 2, 3, 4]);
  assert.ok(wassersteinDistance(p, p) < 1e-12);
});

test("Wasserstein detects ordering: distance grows with shift", () => {
  // 全部质量在位置 0 vs 位置 5 → W1 = 5
  const p = [1, 0, 0, 0, 0, 0];
  const q = [0, 0, 0, 0, 0, 1];
  assert.ok(Math.abs(wassersteinDistance(p, q) - 5) < 1e-9);
});

test("uniformDist gives 1/size for each item", () => {
  const u = uniformDist(33);
  let s = 0;
  for (let i = 1; i <= 33; i++) {
    assert.ok(Math.abs(u[i] - 1 / 33) < 1e-12);
    s += u[i];
  }
  assert.ok(Math.abs(s - 1) < 1e-12);
});

test("ticketsToFreqDist normalizes the empirical distribution", () => {
  const tickets = [
    { reds: [1, 2, 3, 4, 5, 6] },
    { reds: [1, 2, 3, 4, 5, 7] },
  ];
  const d = ticketsToFreqDist(tickets, 33);
  let s = 0;
  for (let i = 1; i <= 33; i++) s += d[i];
  assert.ok(Math.abs(s - 1) < 1e-9);
  // 1 出现 2 次（共 12 个红球）→ 2/12 = 1/6
  assert.ok(Math.abs(d[1] - 1 / 6) < 1e-9);
});

test("samplingQualityScore: identical distribution → 100", () => {
  const p = normalize([1, 1, 1, 1]);
  const score = samplingQualityScore(p, p);
  assert.equal(score, 100);
});

test("samplingQualityScore: very different distribution → low score", () => {
  const p = [1, 0, 0, 0];
  const q = [0, 0, 0, 1];
  const score = samplingQualityScore(p, q);
  assert.ok(score < 50, `expected low score, got ${score}`);
});
