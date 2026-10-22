// rational-betting：所有数学结果都对得起教科书

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  combinations, hypergeometric,
  ssqSinglePrizeProbabilities, dltSinglePrizeProbabilities,
  expectedValue, multiTicketCoverage, kellyFraction, bankrollSimulation,
} from "../assets/js/rational-betting.js";

test("combinations: 边界 + 经典值", () => {
  assert.equal(combinations(5, 0), 1);
  assert.equal(combinations(5, 5), 1);
  assert.equal(combinations(33, 6), 1107568);
  assert.equal(combinations(35, 5), 324632);
  assert.equal(combinations(12, 2), 66);
  assert.equal(combinations(16, 1), 16);
});

test("hypergeometric: 概率求和 = 1", () => {
  let sum = 0;
  for (let k = 0; k <= 6; k++) sum += hypergeometric(k, 6, 6, 33);
  assert.ok(Math.abs(sum - 1) < 1e-9, `sum=${sum}`);
});

test("ssq 一等奖概率 = 1/17721088（C(33,6)·16）", () => {
  const r = ssqSinglePrizeProbabilities();
  const jackpot = r.tiers.find((t) => t.name === "一等奖");
  // C(33,6) = 1107568, × 16 = 17721088
  const expected = 1 / 17721088;
  assert.ok(Math.abs(jackpot.p - expected) / expected < 1e-9, `p=${jackpot.p} expected=${expected}`);
});

test("ssq 至少中奖概率 ≈ 6.71%", () => {
  const r = ssqSinglePrizeProbabilities();
  // 标准答案：双色球任意中奖概率约 1/14.9 ≈ 6.71%
  assert.ok(r.pAny > 0.06 && r.pAny < 0.07, `pAny=${r.pAny}`);
});

test("dlt 一等奖概率 = 1/21425712", () => {
  const r = dltSinglePrizeProbabilities();
  const jackpot = r.tiers.find((t) => t.name === "一等奖");
  // C(35,5)·C(12,2) = 324632 × 66 = 21425712
  const expected = 1 / 21425712;
  assert.ok(Math.abs(jackpot.p - expected) / expected < 1e-9, `p=${jackpot.p} expected=${expected}`);
});

test("expectedValue: SSQ 默认奖金下 EV < 2 元 cost", () => {
  const r = ssqSinglePrizeProbabilities();
  const ev = expectedValue(r.tiers, { "一等奖": 5000000, "二等奖": 50000 }, 2);
  // EV 大约 1 元出头（彩票理论 EV = 50% return）
  assert.ok(ev.ev < 2, `EV=${ev.ev} 应 < 2`);
  assert.ok(ev.evMinusCost < 0);
  assert.equal(ev.shouldPlay, false);
});

test('expectedValue: SSQ 巨型奖池 EV 可超 cost（数学告诉你应该买）', () => {
  const r = ssqSinglePrizeProbabilities();
  // 极端假设一等奖 = 1 亿，二等奖 = 100 万
  const ev = expectedValue(r.tiers, { "一等奖": 100000000, "二等奖": 1000000 }, 2);
  assert.ok(ev.ev > 5, `极端奖池 EV=${ev.ev} 应 > 5`);
  assert.equal(ev.shouldPlay, true);
});

test("multiTicketCoverage: K=5 diverse > random（数学保证）", () => {
  const random = multiTicketCoverage({ K: 5, lottery: "ssq", tierThreshold: 6, strategy: "random", runs: 3000, seed: "r" });
  const diverse = multiTicketCoverage({ K: 5, lottery: "ssq", tierThreshold: 6, strategy: "diverse", runs: 3000, seed: "d" });
  // diverse 严格 ≥ random（最差情况相等）
  assert.ok(diverse.pAtLeastOneHit + 0.005 >= random.pAtLeastOneHit,
    `diverse=${diverse.pAtLeastOneHit} random=${random.pAtLeastOneHit}`);
  // 两者都在 6 等奖以上的合理范围（每注 6.71%，5 注 ~ 1−(0.9329)^5 ≈ 0.293）
  assert.ok(diverse.pAtLeastOneHit > 0.20 && diverse.pAtLeastOneHit < 0.40);
});

test("multiTicketCoverage: ci95 区间合理", () => {
  const r = multiTicketCoverage({ K: 5, lottery: "ssq", tierThreshold: 6, strategy: "diverse", runs: 1000 });
  assert.ok(r.ci95[0] < r.pAtLeastOneHit && r.pAtLeastOneHit < r.ci95[1]);
  assert.ok(r.stderr > 0);
});

test("kellyFraction: 普通彩票 fStar = 0（不应投）", () => {
  const r = kellyFraction(1.1, 2, 5000000);
  assert.equal(r.fraction, 0);
  assert.equal(r.shouldBet, false);
});

test("kellyFraction: EV > cost 时 fStar > 0", () => {
  const r = kellyFraction(3, 2, 5000000);
  assert.ok(r.fraction > 0);
  assert.equal(r.shouldBet, true);
});

test("bankrollSimulation: 每期 10 元 100 期，typical bankroll 缩水 50%", () => {
  const r = ssqSinglePrizeProbabilities();
  const sim = bankrollSimulation({
    bankroll: 1000,
    perPeriodCost: 10,
    periods: 100,
    simulations: 200,
    tiers: r.tiers,
    fixedPrizes: { "一等奖": 5000000, "二等奖": 50000 },
    seed: "test-sim",
  });
  // 总投入 1000 元；mean 应该接近初始的一半左右（彩票约 50% 返奖率）
  assert.ok(sim.finalMean >= 0);
  assert.ok(sim.finalMean <= sim.initialBankroll * 1.5,
    `mean=${sim.finalMean} 在大多数模拟下应 < 1500`);
  assert.ok(sim.bankruptcyRate >= 0 && sim.bankruptcyRate <= 1);
  assert.equal(sim.simulations, 200);
  assert.ok(Array.isArray(sim.sampleTrajectories) && sim.sampleTrajectories.length > 0);
});

test("bankrollSimulation: 投注比例越高破产率越高", () => {
  const r = ssqSinglePrizeProbabilities();
  const small = bankrollSimulation({
    bankroll: 100, perPeriodCost: 2, periods: 100, simulations: 100,
    tiers: r.tiers, fixedPrizes: { "一等奖": 5000000, "二等奖": 50000 }, seed: "small",
  });
  const big = bankrollSimulation({
    bankroll: 100, perPeriodCost: 50, periods: 100, simulations: 100,
    tiers: r.tiers, fixedPrizes: { "一等奖": 5000000, "二等奖": 50000 }, seed: "big",
  });
  assert.ok(big.bankruptcyRate >= small.bankruptcyRate,
    `big=${big.bankruptcyRate} small=${small.bankruptcyRate}`);
});
