import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateChase, ticketRevenue } from "../assets/js/ssq-chase.js";

test("ticketRevenue: 一等奖 6+1", () => {
  const r = ticketRevenue(
    { reds: [1, 2, 3, 4, 5, 6], blue: 7 },
    { reds: [1, 2, 3, 4, 5, 6], blue: 7 },
    "expected",
  );
  assert.equal(r.level, 1);
  assert.ok(r.prize > 0);
});

test("ticketRevenue: 不中 → level=0, prize=0", () => {
  const r = ticketRevenue(
    { reds: [1, 2, 3, 4, 5, 6], blue: 7 },
    { reds: [10, 11, 12, 13, 14, 15], blue: 8 },
    "expected",
  );
  assert.equal(r.level, 0);
  assert.equal(r.prize, 0);
});

test("simulateChase: flat 策略输出结构正确", () => {
  const r = simulateChase({
    runs: 200,
    draws: 30,
    ticketsPerDraw: 1,
    bankroll: 200,
    strategy: "flat",
    prizeBand: "expected",
    seed: "ssq-test-flat",
  });
  assert.equal(r.runs, 200);
  assert.ok(r.ruinProb >= 0 && r.ruinProb <= 1);
  assert.ok(r.finalMean >= 0);
  assert.ok(r.everJackpotProb >= 0 && r.everJackpotProb <= 1);
  assert.ok(r.trajectories.length > 0 && r.trajectories.length <= 30);
});

test("simulateChase: 高投注 → 高破产率（单调）", () => {
  const small = simulateChase({
    runs: 200, draws: 50, ticketsPerDraw: 1,
    bankroll: 200, strategy: "flat", seed: "ssq-small",
  });
  const big = simulateChase({
    runs: 200, draws: 50, ticketsPerDraw: 5,
    bankroll: 200, strategy: "flat", seed: "ssq-big",
  });
  assert.ok(big.ruinProb >= small.ruinProb,
    `big=${big.ruinProb} small=${small.ruinProb}`);
});

test("simulateChase: martingale 策略破产率明显高", () => {
  const flat = simulateChase({
    runs: 200, draws: 50, ticketsPerDraw: 1,
    bankroll: 100, strategy: "flat", seed: "mflat",
  });
  const mart = simulateChase({
    runs: 200, draws: 50, ticketsPerDraw: 1,
    bankroll: 100, strategy: "martingale", seed: "mmart",
  });
  // martingale 在小本金下破产率应 > flat
  assert.ok(mart.ruinProb >= flat.ruinProb,
    `martingale=${mart.ruinProb} flat=${flat.ruinProb}`);
});
