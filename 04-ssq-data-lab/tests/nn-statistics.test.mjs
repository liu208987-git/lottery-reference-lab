import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bootstrapCI,
  pairedBootstrap,
  metricAvgHit6,
  metricBlueAcc,
  reliabilityDiagram,
  uniformBaselineHitK,
} from "../assets/js/nn-statistics.js";

test("bootstrapCI: constant data → CI tightly around the constant", () => {
  const records = Array.from({ length: 100 }, () => ({ redHit6: 1.0 }));
  const ci = bootstrapCI(records, metricAvgHit6, { B: 200, seed: "const" });
  assert.ok(Math.abs(ci.mean - 1) < 1e-9);
  assert.ok(Math.abs(ci.lower - 1) < 1e-9);
  assert.ok(Math.abs(ci.upper - 1) < 1e-9);
});

test("bootstrapCI: random data → CI brackets the true mean", () => {
  // hit@6 ~ Binomial(6, 6/33)；样本均值 ≈ 36/33 ≈ 1.09
  // 用 200 样本 + 500 bootstrap，95% CI 应包含 1.0
  const records = [];
  for (let i = 0; i < 300; i++) {
    let s = 0;
    for (let j = 0; j < 6; j++) if (Math.random() < 6 / 33) s++;
    records.push({ redHit6: s });
  }
  const ci = bootstrapCI(records, metricAvgHit6, { B: 300, seed: "rand" });
  assert.ok(ci.lower < ci.mean && ci.mean < ci.upper);
  assert.ok(ci.upper - ci.lower < 0.5, `CI width = ${ci.upper - ci.lower}`);
});

test("pairedBootstrap: same data → mean diff ≈ 0", () => {
  const records = Array.from({ length: 50 }, (_, i) => ({ redHit6: i % 3 }));
  const r = pairedBootstrap(records, records, metricAvgHit6, { B: 200, seed: "paired" });
  assert.ok(Math.abs(r.mean) < 1e-9);
  // 当两组完全相同时差值在所有 bootstrap 重采样上恒为 0
  assert.equal(r.lower, 0);
  assert.equal(r.upper, 0);
});

test("pairedBootstrap: A consistently +1 over B → mean ≈ 1, CI excludes 0", () => {
  const A = Array.from({ length: 100 }, (_, i) => ({ redHit6: 2 + (i % 2) }));
  const B = Array.from({ length: 100 }, (_, i) => ({ redHit6: 1 + (i % 2) }));
  const r = pairedBootstrap(A, B, metricAvgHit6, { B: 300, seed: "diff" });
  assert.ok(Math.abs(r.mean - 1) < 0.01);
  assert.ok(r.lower > 0); // CI 不包含 0 → 显著
});

test("metricAvgHit6 averages correctly", () => {
  const recs = [{ redHit6: 0 }, { redHit6: 2 }, { redHit6: 4 }];
  assert.equal(metricAvgHit6(recs), 2);
});

test("metricBlueAcc handles boolean and numeric", () => {
  assert.equal(metricBlueAcc([{ blueHit: true }, { blueHit: false }]), 0.5);
  assert.equal(metricBlueAcc([{ blueHit: 0.5 }, { blueHit: 0.5 }]), 0.5);
});

test("reliabilityDiagram: well-calibrated → small ECE", () => {
  // 模拟完美校准：对每个 record，用 redProbs[i] = (i+1)/33，hit 按概率随机产生
  const records = [];
  for (let r = 0; r < 200; r++) {
    const probs = [];
    const reds = [];
    for (let i = 0; i < 33; i++) {
      const p = Math.random();
      probs.push(p);
      if (Math.random() < p) reds.push(i + 1);
    }
    records.push({ redProbs: probs, realReds: reds });
  }
  const { points, ece } = reliabilityDiagram(records, { bins: 10 });
  assert.equal(points.length, 10);
  assert.ok(ece < 0.1, `ECE = ${ece}`);
});

test("reliabilityDiagram: badly-calibrated (always 0.5, never hit) → ECE ≈ 0.5", () => {
  const records = [];
  for (let r = 0; r < 50; r++) {
    const probs = Array(33).fill(0.5);
    records.push({ redProbs: probs, realReds: [] });
  }
  const { ece } = reliabilityDiagram(records, { bins: 10 });
  assert.ok(ece > 0.4, `ECE = ${ece}`);
});

test("uniformBaselineHitK: K=6 → 1.09, K=8 → 1.45", () => {
  assert.ok(Math.abs(uniformBaselineHitK(6) - 6 * 6 / 33) < 1e-9);
  assert.ok(Math.abs(uniformBaselineHitK(8) - 8 * 6 / 33) < 1e-9);
});


/* ============================================================
 * Brier Skill Score 单测
 * ============================================================ */

import { brierSkillScore, permutationTest } from "../assets/js/nn-statistics.js";

test("brierSkillScore: 完美预测器 → BSS = 1", () => {
  const records = [];
  for (let n = 0; n < 50; n++) {
    const reds = [1, 2, 3, 4, 5, 6];
    const probs = new Array(33).fill(0);
    for (const r of reds) probs[r - 1] = 1;
    records.push({ redProbs: probs, realReds: reds });
  }
  const r = brierSkillScore(records, 33, 6);
  assert.ok(r.bss > 0.99, `BSS ${r.bss} should be ~1`);
});

test("brierSkillScore: climatology baseline → BSS ≈ 0", () => {
  const records = [];
  for (let n = 0; n < 50; n++) {
    const reds = [];
    while (reds.length < 6) {
      const x = 1 + Math.floor(Math.random() * 33);
      if (!reds.includes(x)) reds.push(x);
    }
    const probs = new Array(33).fill(6 / 33); // 全部 baseline
    records.push({ redProbs: probs, realReds: reds });
  }
  const r = brierSkillScore(records, 33, 6);
  assert.ok(Math.abs(r.bss) < 0.05, `BSS ${r.bss} should be ~0 for climatology`);
});

test("brierSkillScore: 随机猜测劣于 baseline → BSS < 0", () => {
  const records = [];
  for (let n = 0; n < 50; n++) {
    const reds = [];
    while (reds.length < 6) {
      const x = 1 + Math.floor(Math.random() * 33);
      if (!reds.includes(x)) reds.push(x);
    }
    // 故意瞎猜：随机一些 0 和 1
    const probs = [];
    for (let i = 0; i < 33; i++) probs.push(Math.random() < 0.5 ? 1 : 0);
    records.push({ redProbs: probs, realReds: reds });
  }
  const r = brierSkillScore(records, 33, 6);
  assert.ok(r.bss < -0.5, `BSS ${r.bss} should be very negative for random 0/1`);
});

test("brierSkillScore: DLT 35/5 配置", () => {
  const records = [];
  for (let n = 0; n < 30; n++) {
    const reds = [];
    while (reds.length < 5) {
      const x = 1 + Math.floor(Math.random() * 35);
      if (!reds.includes(x)) reds.push(x);
    }
    const probs = new Array(35).fill(5 / 35);
    records.push({ redProbs: probs, realReds: reds });
  }
  const r = brierSkillScore(records, 35, 5);
  assert.ok(Math.abs(r.bss) < 0.05);
  assert.equal(r.size, 35);
  assert.equal(r.pick, 5);
});

/* ============================================================
 * Permutation test
 * ============================================================ */

test("permutationTest: 两组完全相同 → p ≈ 1", () => {
  const records = [];
  for (let i = 0; i < 30; i++) records.push({ redHit6: Math.floor(Math.random() * 4) });
  const r = permutationTest(records, records, (rec) => rec.redHit6, { B: 200 });
  assert.ok(r.pTwoSided > 0.5, `p=${r.pTwoSided} should be > 0.5 for identical groups`);
  assert.ok(Math.abs(r.observed) < 1e-9);
});

test("permutationTest: A 比 B 始终高 1 → p < 0.01", () => {
  const a = [], b = [];
  for (let i = 0; i < 50; i++) {
    a.push({ v: 2 + Math.random() * 0.1 });
    b.push({ v: 1 + Math.random() * 0.1 });
  }
  const r = permutationTest(a, b, (rec) => rec.v, { B: 500, seed: "perm-test" });
  assert.ok(r.observed > 0.9, `observed=${r.observed} should be ~1`);
  assert.ok(r.pTwoSided < 0.01, `p=${r.pTwoSided} should be very small`);
});

test("permutationTest: 同种子可重现", () => {
  const a = [], b = [];
  for (let i = 0; i < 30; i++) {
    a.push({ v: i });
    b.push({ v: i + 0.3 });
  }
  const r1 = permutationTest(a, b, (rec) => rec.v, { B: 200, seed: "repro" });
  const r2 = permutationTest(a, b, (rec) => rec.v, { B: 200, seed: "repro" });
  assert.equal(r1.pTwoSided, r2.pTwoSided);
});
