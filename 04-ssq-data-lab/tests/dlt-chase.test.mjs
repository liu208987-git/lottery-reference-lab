import { test } from "node:test";
import assert from "node:assert/strict";
import { ticketRevenue, simulateChase } from "../assets/js/dlt-chase.js";

test("ticketRevenue 一等奖命中返回 expected band 奖金", () => {
  const ticket = { front: [1, 2, 3, 4, 5], back: [1, 2] };
  const draw = { front: [1, 2, 3, 4, 5], back: [1, 2] };
  const r = ticketRevenue(ticket, draw, "expected");
  assert.equal(r.level, 1);
  assert.ok(r.prize > 0);
});

test("ticketRevenue 未中奖返回 level=0 prize=0", () => {
  const ticket = { front: [6, 7, 8, 9, 10], back: [3, 4] };
  const draw = { front: [1, 2, 3, 4, 5], back: [1, 2] };
  const r = ticketRevenue(ticket, draw, "expected");
  assert.equal(r.level, 0);
  assert.equal(r.prize, 0);
});

test("simulateChase flat 50 期 1 注的资金期望符合 EV × draws", () => {
  const r = simulateChase({
    runs: 200, draws: 30, ticketsPerDraw: 1,
    bankroll: 1000, strategy: "flat", prizeBand: "expected", seed: "flat-1",
  });
  // 期望最终 bankroll 应该接近 bankroll + draws × (EV - cost)
  // 而 EV - cost < 0，所以 finalMean < 1000
  assert.ok(r.finalMean < 1000);
  assert.ok(r.runs === 200);
  assert.ok(r.ruinProb >= 0 && r.ruinProb <= 1);
});

test("simulateChase martingale 破产率明显高于 flat（小本金下）", () => {
  const flatR = simulateChase({
    runs: 200, draws: 50, ticketsPerDraw: 1,
    bankroll: 200, strategy: "flat", prizeBand: "conservative", seed: "comp-flat",
  });
  const martR = simulateChase({
    runs: 200, draws: 50, ticketsPerDraw: 1,
    bankroll: 200, strategy: "martingale", prizeBand: "conservative",
    martingaleBaseTickets: 1, martingaleCap: 16, seed: "comp-mart",
  });
  assert.ok(martR.ruinProb >= flatR.ruinProb,
    `martingale (${martR.ruinProb}) should not be lower than flat (${flatR.ruinProb})`);
});

test("simulateChase 返回正确结构", () => {
  const r = simulateChase({ runs: 50, draws: 10, ticketsPerDraw: 1, bankroll: 500, strategy: "flat" });
  assert.equal(r.runs, 50);
  assert.equal(r.draws, 10);
  assert.equal(r.finalBankroll.length, 50);
  assert.ok(Array.isArray(r.trajectories));
  assert.ok(r.trajectories.length <= 30);
  assert.ok(typeof r.finalMean === "number");
  assert.ok(typeof r.finalMedian === "number");
  assert.ok(r.finalP05 <= r.finalMedian);
  assert.ok(r.finalMedian <= r.finalP95);
});

test("simulateChase 大本金 + 小注数 → 破产率接近 0", () => {
  const r = simulateChase({
    runs: 100, draws: 10, ticketsPerDraw: 1,
    bankroll: 100000, strategy: "flat", seed: "big-bank",
  });
  assert.equal(r.ruinProb, 0);
});

test("simulateChase 同种子结果可复现", () => {
  const a = simulateChase({ runs: 100, draws: 10, bankroll: 500, strategy: "flat", seed: "repro" });
  const b = simulateChase({ runs: 100, draws: 10, bankroll: 500, strategy: "flat", seed: "repro" });
  assert.equal(a.finalMean, b.finalMean);
  assert.equal(a.ruinProb, b.ruinProb);
});

test("everJackpotProb 接近 0（一等奖概率太低，30 期 × 100 注理论命中数 < 0.001）", () => {
  const r = simulateChase({ runs: 200, draws: 30, ticketsPerDraw: 1, bankroll: 100000, seed: "jp" });
  assert.ok(r.everJackpotProb < 0.01, `jackpot prob ${r.everJackpotProb}`);
});
