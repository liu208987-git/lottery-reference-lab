import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pearson, spearman,
  correlationPValue,
  frontBackSumCorrelation,
  oddCountIndependenceTest,
  frontBackPairLift,
  verdictFromP,
} from "../assets/js/dlt-independence.js";

test("pearson 完美相关返回 1", () => {
  const r = pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  assert.ok(Math.abs(r - 1) < 1e-9);
});

test("pearson 完美负相关返回 -1", () => {
  const r = pearson([1, 2, 3], [3, 2, 1]);
  assert.ok(Math.abs(r + 1) < 1e-9);
});

test("pearson 独立数据接近 0", () => {
  // 用伪随机但互不相关的数据
  const xs = [1, 5, 3, 8, 2, 6, 9, 4, 7, 10];
  const ys = [4, 2, 8, 1, 9, 5, 3, 10, 6, 7];
  const r = pearson(xs, ys);
  assert.ok(Math.abs(r) < 0.7);
});

test("spearman 对单调变换不变", () => {
  const xs = [1, 2, 3, 4, 5];
  const ys1 = [1, 4, 9, 16, 25];   // x²
  const ys2 = [1, 8, 27, 64, 125]; // x³
  // x → x² 单调，spearman 应该是 1
  assert.ok(Math.abs(spearman(xs, ys1) - 1) < 1e-9);
  assert.ok(Math.abs(spearman(xs, ys2) - 1) < 1e-9);
});

test("correlationPValue r=0 时 p ≈ 1", () => {
  const p = correlationPValue(0, 100);
  assert.ok(p > 0.99);
});

test("correlationPValue 大 |r| + 大 n → p 极小", () => {
  const p = correlationPValue(0.5, 200);
  assert.ok(p < 0.001);
});

test("frontBackSumCorrelation 对真实独立分布不显著", () => {
  // 模拟 200 期独立 DLT 数据
  const draws = [];
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 300; i++) {
    const front = [];
    while (front.length < 5) {
      const n = 1 + Math.floor(rand() * 35);
      if (!front.includes(n)) front.push(n);
    }
    const back = [];
    while (back.length < 2) {
      const n = 1 + Math.floor(rand() * 12);
      if (!back.includes(n)) back.push(n);
    }
    draws.push({ front, back });
  }
  const r = frontBackSumCorrelation(draws);
  // 在独立数据下 |r| 应该小于 0.2
  assert.ok(Math.abs(r.pearson) < 0.25, `pearson ${r.pearson}`);
});

test("oddCountIndependenceTest 返回有效卡方结构", () => {
  const draws = [];
  for (let i = 0; i < 100; i++) {
    draws.push({ front: [1, 2, 3, 4, 5], back: [1, 2] });
  }
  const r = oddCountIndependenceTest(draws);
  assert.ok(typeof r.chi === "number");
  assert.ok(r.df >= 1);
  assert.ok(r.p >= 0 && r.p <= 1);
});

test("frontBackPairLift 返回 35×12 中偏离最远的 K 对", () => {
  const draws = [];
  for (let i = 0; i < 500; i++) {
    const front = [(i % 35) + 1, ((i + 1) % 35) + 1, ((i + 2) % 35) + 1, ((i + 3) % 35) + 1, ((i + 4) % 35) + 1];
    const back = [(i % 12) + 1, ((i + 1) % 12) + 1];
    draws.push({ front, back });
  }
  const r = frontBackPairLift(draws, { topK: 5 });
  assert.equal(r.extremes.length, 5);
  for (const e of r.extremes) {
    assert.ok(e.front >= 1 && e.front <= 35);
    assert.ok(e.back >= 1 && e.back <= 12);
  }
});

test("verdictFromP 阈值分级", () => {
  assert.equal(verdictFromP(0.0005).reject, true);
  assert.equal(verdictFromP(0.0005).severity, "strong");
  assert.equal(verdictFromP(0.005).severity, "moderate");
  assert.equal(verdictFromP(0.03).severity, "weak");
  assert.equal(verdictFromP(0.5).reject, false);
});
