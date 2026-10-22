import { test } from "node:test";
import assert from "node:assert/strict";
import { populationStabilityIndex, frequencyDist, temporalPSI, rollingPSI } from "../assets/js/psi.js";

test("PSI: 相同分布 PSI ≈ 0", () => {
  const dist = [10, 20, 30, 40, 50];
  const r = populationStabilityIndex(dist, dist);
  assert.ok(r.psi < 0.01, `psi=${r.psi}`);
  assert.equal(r.verdict, "stable");
});

test("PSI: 大幅漂移 verdict=major", () => {
  const p = [50, 30, 20, 10, 5];
  const q = [5, 10, 20, 30, 50];
  const r = populationStabilityIndex(p, q);
  assert.ok(r.psi > 0.25, `psi=${r.psi}`);
  assert.equal(r.verdict, "major");
});

test("PSI: contributions 已按贡献度排序", () => {
  const p = [50, 30, 20, 10, 5];
  const q = [5, 10, 20, 30, 50];
  const r = populationStabilityIndex(p, q);
  for (let i = 1; i < r.contributions.length; i++) {
    assert.ok(Math.abs(r.contributions[i].term) <= Math.abs(r.contributions[i - 1].term));
  }
});

test("PSI: length mismatch 抛错", () => {
  assert.throws(() => populationStabilityIndex([1, 2], [1, 2, 3]));
});

test("frequencyDist: 红球分布", () => {
  const draws = [
    { reds: [1, 2, 3, 4, 5, 6], blue: 1 },
    { reds: [1, 2, 7, 8, 9, 10], blue: 2 },
  ];
  const f = frequencyDist(draws, "reds", 33);
  assert.equal(f[0], 2);
  assert.equal(f[1], 2);
  assert.equal(f[2], 1);
});

test("temporalPSI: 数据少 warning", () => {
  const r = temporalPSI([], "reds", 33);
  assert.ok(r.warning);
});

test("temporalPSI: 完整流程", () => {
  const draws = [];
  for (let i = 0; i < 80; i++) {
    const reds = [];
    while (reds.length < 6) {
      const n = ((i * 7 + reds.length) % 33) + 1;
      if (!reds.includes(n)) reds.push(n);
    }
    draws.push({ reds, blue: (i % 16) + 1 });
  }
  const r = temporalPSI(draws, "reds", 33);
  assert.ok(typeof r.psi === "number");
  assert.ok(r.earlyN + r.lateN === draws.length);
  assert.ok(["stable", "minor", "major"].includes(r.verdict));
});

test("rollingPSI: 序列输出按时间", () => {
  const draws = [];
  for (let i = 0; i < 250; i++) {
    const reds = [];
    while (reds.length < 6) {
      const n = ((i * 11 + reds.length * 3) % 33) + 1;
      if (!reds.includes(n)) reds.push(n);
    }
    draws.push({ reds, blue: (i % 16) + 1, issue: String(i) });
  }
  const series = rollingPSI(draws, "reds", 33, 100);
  assert.ok(series.length > 1);
  for (const p of series) {
    assert.ok(typeof p.psi === "number");
    assert.ok(p.psi >= 0);
  }
});
