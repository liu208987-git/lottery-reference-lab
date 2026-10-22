import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreSsqTicket, summarizeSsqBacktest, theoreticalSsqHitBaseline, runSsqBacktest,
} from "../assets/js/ssq-backtest.js";
import fs from "node:fs";

test("scoreSsqTicket: 命中型态正确", () => {
  const ticket = { reds: [1, 2, 3, 4, 5, 6], blue: 7 };
  const draw = { reds: [1, 2, 3, 10, 11, 12], blue: 7 };
  const r = scoreSsqTicket(ticket, draw);
  assert.equal(r.redHits, 3);
  assert.equal(r.blueHits, 1);
  assert.equal(r.hitClass, "3+1");
  assert.deepEqual(r.redMatched, [1, 2, 3]);
  assert.deepEqual(r.blueMatched, [7]);
});

test("scoreSsqTicket: 全不中", () => {
  const ticket = { reds: [1, 2, 3, 4, 5, 6], blue: 7 };
  const draw = { reds: [10, 11, 12, 13, 14, 15], blue: 8 };
  const r = scoreSsqTicket(ticket, draw);
  assert.equal(r.redHits, 0);
  assert.equal(r.blueHits, 0);
  assert.equal(r.hitClass, "0+0");
});

test("theoreticalSsqHitBaseline: 红基线 = 1.09，蓝基线 = 0.0625", () => {
  const b = theoreticalSsqHitBaseline();
  assert.ok(Math.abs(b.redAvgPerTicket - 36 / 33) < 1e-9);
  assert.ok(Math.abs(b.blueAvgPerTicket - 1 / 16) < 1e-9);
  assert.ok(Math.abs(b.jackpotProbability - 1 / 17721088) < 1e-15);
});

test("summarizeSsqBacktest: 空 records → 0 输出", () => {
  const r = summarizeSsqBacktest([]);
  assert.equal(r.totalTickets, 0);
  assert.equal(r.avgRedHits, 0);
  assert.equal(r.avgBlueHits, 0);
});

test("summarizeSsqBacktest: 命中分布矩阵正确", () => {
  const records = [
    { issue: "1", redHits: 3, blueHits: 1, hitClass: "3+1" },
    { issue: "2", redHits: 4, blueHits: 0, hitClass: "4+0" },
    { issue: "3", redHits: 3, blueHits: 1, hitClass: "3+1" },
  ];
  const r = summarizeSsqBacktest(records, { rounds: 3, ticketsPerDraw: 1 });
  assert.equal(r.totalTickets, 3);
  assert.equal(r.hitDistribution["3+1"], 2);
  assert.equal(r.hitDistribution["4+0"], 1);
  // best = 4+0（按权重 4*10=40 > 3*10+1=31）
  assert.equal(r.best.hitClass, "4+0");
});

test("runSsqBacktest: 真实历史数据跑通", () => {
  const raw = JSON.parse(fs.readFileSync("data/draws.json", "utf8"));
  const draws = raw.draws.slice(-300);
  const r = runSsqBacktest(draws, {
    method: "legacy-uniform",
    rounds: 20,
    ticketsPerDraw: 3,
    lookback: 100,
    seed: "test",
  });
  assert.equal(r.summary.rounds, 20);
  assert.equal(r.summary.totalTickets, 60);
  assert.ok(r.records.length === 60);
  assert.ok(r.summary.avgRedHits >= 0);
  // 均匀基线应该接近 1.09
  assert.ok(r.summary.avgRedHits > 0.5 && r.summary.avgRedHits < 2,
    `avgRedHits=${r.summary.avgRedHits}`);
});
