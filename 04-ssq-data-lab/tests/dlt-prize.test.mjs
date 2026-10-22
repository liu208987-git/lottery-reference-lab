import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hitClassProbability, classifyHit,
  withPrizeProbabilities, expectedReturn, additionalBetEdge,
  ticketsExpectedReturn,
  DLT_PRIZES,
} from "../assets/js/dlt-prize.js";

test("一等奖概率 = 1 / 21,425,712（精确）", () => {
  const p = hitClassProbability(5, 2);
  assert.ok(Math.abs(p - 1 / 21425712) < 1e-15, `got ${p}`);
});

test("二等奖概率 = 5+1 = C(5,5)·C(30,0)·C(2,1)·C(10,1) / 全部", () => {
  // C(2,1)·C(10,1) = 20，分母 21425712
  const p = hitClassProbability(5, 1);
  assert.ok(Math.abs(p - 20 / 21425712) < 1e-15);
});

test("9 个奖级概率之和约等于 (1 - P(中不到任何级)) <= 1", () => {
  const items = withPrizeProbabilities();
  const sum = items.reduce((s, p) => s + p.probability, 0);
  assert.ok(sum > 0 && sum < 1, `total winning prob ${sum}`);
  // 数值核对：精确总中奖率 ≈ 6.71%（这是大乐透官方数）
  assert.ok(Math.abs(sum - 0.0671) < 0.005, `prob sum ${sum} not near 0.0671`);
});

test("classifyHit 把 (5,2) 分入一等奖", () => {
  assert.equal(classifyHit(5, 2), 1);
  assert.equal(classifyHit(5, 1), 2);
  assert.equal(classifyHit(5, 0), 3);
  assert.equal(classifyHit(4, 2), 4);
  assert.equal(classifyHit(0, 0), 0);
  assert.equal(classifyHit(3, 1), 8);   // 八等奖
  assert.equal(classifyHit(2, 2), 8);   // 八等奖
  assert.equal(classifyHit(0, 2), 9);   // 九等奖
  assert.equal(classifyHit(2, 1), 9);   // 九等奖
});

test("expectedReturn 在 expected band 下基本投注的回报率 < 1（彩票数学定律）", () => {
  const er = expectedReturn({ band: "expected", mode: "base" });
  assert.ok(er.evPerYuan < 1, `payback ratio ${er.evPerYuan} should be < 1`);
  // 但应该在 30%-70% 之间（典型彩票回报率）
  assert.ok(er.evPerYuan > 0.2, `payback too low: ${er.evPerYuan}`);
});

test("additionalBetEdge 算追加投注的增量 EV", () => {
  const edge = additionalBetEdge("expected");
  // 增量收益 = 0.8 × (一二三等的 prob × prize)
  assert.ok(edge.extraGain > 0);
  assert.equal(edge.extraCost, 1);
  // 在 expected band 下，追加大概率仍是负 edge（与基本投注一样）
  // 但 edge per yuan 应该和 base payback ratio 相近
  assert.ok(edge.detail.length === 3); // 一二三等
});

test("ticketsExpectedReturn 线性叠加", () => {
  const er = ticketsExpectedReturn(10, { band: "expected", mode: "base" });
  assert.equal(er.tickets, 10);
  assert.ok(Math.abs(er.totalCost - 20) < 1e-9);
  assert.ok(Math.abs(er.totalEv - er.ev * 10) < 1e-6);
});

test("追加 mode 比 base mode 的总 EV 更高（因为多了 80% 加成）", () => {
  const erBase = expectedReturn({ band: "expected", mode: "base" });
  const erAdd = expectedReturn({ band: "expected", mode: "add" });
  assert.ok(erAdd.ev > erBase.ev);
  // 但回报率取决于成本——这是用户要看的关键
  assert.equal(erBase.cost, 2);
  assert.equal(erAdd.cost, 3);
});

test("hitClassProbability 边界值", () => {
  assert.equal(hitClassProbability(-1, 0), 0);
  assert.equal(hitClassProbability(0, 3), 0);
  assert.equal(hitClassProbability(6, 0), 0);
});
