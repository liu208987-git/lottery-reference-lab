// conformal prediction 单元测试

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inverseRankScore,
  fitConformalThreshold,
  conformalPredict,
  evaluateCoverage,
  splitConformal,
} from "../assets/js/conformal.js";

test("inverseRankScore: 概率最高的号 score 最低", () => {
  const probs = new Float32Array([0.1, 0.5, 0.2, 0.3]);
  const s = inverseRankScore(probs);
  // probs 排序: idx1(0.5) > idx3(0.3) > idx2(0.2) > idx0(0.1)
  // ranks      : 0       , 1       , 2       , 3
  // score (/3) : 0       , 1/3     , 2/3     , 1
  assert.equal(s[1], 0);
  assert.ok(Math.abs(s[3] - 1 / 3) < 1e-6);
  assert.ok(Math.abs(s[2] - 2 / 3) < 1e-6);
  assert.equal(s[0], 1);
});

test("fitConformalThreshold: 完美预测时 qHat 应该接近 0", () => {
  // 33 维的均匀概率 + 真号永远在 top 6
  const records = [];
  for (let i = 0; i < 50; i++) {
    const probs = new Float32Array(33);
    // 让前 6 号概率最高
    for (let j = 0; j < 33; j++) probs[j] = j < 6 ? 0.9 : 0.01;
    records.push({ probs, realSet: [1, 2, 3, 4, 5, 6] }); // 1-6 号
  }
  const { qHat } = fitConformalThreshold(records, 0.1);
  // 真号都在 rank 0-5 之间，score = [0, 5/32]
  assert.ok(qHat <= 5 / 32 + 1e-3, `期望 qHat ≤ 0.156，得 ${qHat}`);
});

test("conformalPredict: 集合大小随 qHat 单调", () => {
  const probs = new Float32Array(33);
  for (let i = 0; i < 33; i++) probs[i] = (33 - i) / 33; // 严格递减
  const small = conformalPredict(probs, 0.1);
  const big = conformalPredict(probs, 0.5);
  assert.ok(big.size > small.size);
});

test("splitConformal: i.i.d. 均匀场景下经验覆盖率应接近 1-α", () => {
  // 32 期均匀随机 33 维概率，真号也随机
  const records = [];
  let seed = 42;
  const lcg = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 200; i++) {
    const probs = new Float32Array(33);
    for (let j = 0; j < 33; j++) probs[j] = lcg();
    // realSet 是 6 个 1-33 不重复随机号
    const pool = Array.from({ length: 33 }, (_, k) => k + 1);
    for (let j = pool.length - 1; j > 0; j--) {
      const k = Math.floor(lcg() * (j + 1));
      [pool[j], pool[k]] = [pool[k], pool[j]];
    }
    records.push({ probs, realSet: pool.slice(0, 6) });
  }
  const result = splitConformal(records, 0.1, 0.5);
  // expected coverage = 0.9，允许 ±10pp
  assert.ok(result.coverage > 0.75, `覆盖率 ${result.coverage} 应 > 0.75`);
  assert.ok(result.coverage <= 1, `覆盖率 ${result.coverage} 应 ≤ 1`);
  assert.ok(result.avgSize > 0 && result.avgSize <= 33);
});

test("splitConformal: 数据不足时返回 warning", () => {
  const r = splitConformal([{ probs: [], realSet: [] }], 0.1);
  assert.ok(r.warning);
});

test("evaluateCoverage: 真号全在集合 → coverage = 1", () => {
  const probs = new Float32Array(33);
  for (let i = 0; i < 33; i++) probs[i] = i < 10 ? 0.9 : 0.01; // 前 10 号高概率
  const records = [
    { probs, realSet: [1, 2, 3, 4, 5, 6] },
    { probs, realSet: [4, 5, 6, 7, 8, 9] },
  ];
  // qHat 取 9/32 让前 10 号都进集合
  const r = evaluateCoverage(records, 9 / 32);
  assert.equal(r.coverage, 1);
  assert.equal(r.avgSize, 10);
});
