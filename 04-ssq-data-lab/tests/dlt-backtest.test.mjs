import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scoreDltTicket,
  summarizeDltBacktest,
  theoreticalDltHitBaseline,
  runDltBacktest,
} from "../assets/js/dlt-backtest.js";

function draw(issue, front, back, date = "2026-01-01") {
  return { issue, date, front, back };
}

function ticket(front, back) {
  return { front, back };
}

test("scoreDltTicket counts front/back hits and matched numbers", () => {
  const actual = draw("26055", [9, 10, 20, 33, 35], [4, 11]);
  const result = scoreDltTicket(ticket([1, 9, 10, 22, 35], [4, 12]), actual);

  assert.equal(result.frontHits, 3);
  assert.equal(result.backHits, 1);
  assert.equal(result.hitClass, "3+1");
  assert.deepEqual(result.frontMatched, [9, 10, 35]);
  assert.deepEqual(result.backMatched, [4]);
});

test("theoreticalDltHitBaseline exposes honest random-hit expectations", () => {
  const baseline = theoreticalDltHitBaseline();

  assert.equal(baseline.frontAvgPerTicket, 25 / 35);
  assert.equal(baseline.backAvgPerTicket, 4 / 12);
  assert.equal(baseline.jackpotProbability, 1 / 21425712);
});

test("summarizeDltBacktest reports cost, averages, distribution and best record", () => {
  const records = [
    { issue: "26051", ticketIndex: 0, frontHits: 5, backHits: 2, hitClass: "5+2" },
    { issue: "26052", ticketIndex: 0, frontHits: 3, backHits: 1, hitClass: "3+1" },
    { issue: "26052", ticketIndex: 1, frontHits: 0, backHits: 0, hitClass: "0+0" },
  ];

  const summary = summarizeDltBacktest(records, { rounds: 2, ticketsPerDraw: 2 });

  assert.equal(summary.rounds, 2);
  assert.equal(summary.totalTickets, 3);
  assert.equal(summary.costYuan, 6);
  assert.equal(summary.avgFrontHits, (5 + 3 + 0) / 3);
  assert.equal(summary.avgBackHits, 1);
  assert.equal(summary.hitDistribution["5+2"], 1);
  assert.equal(summary.hitDistribution["3+1"], 1);
  assert.equal(summary.hitDistribution["0+0"], 1);
  assert.equal(summary.best.issue, "26051");
  assert.equal(summary.best.frontHits, 5);
  assert.equal(summary.best.backHits, 2);
  assert.ok(summary.frontLiftVsRandom > 1);
});

test("runDltBacktest walks forward without exposing the target draw to sampler", () => {
  const draws = [
    draw("26050", [1, 2, 3, 4, 5], [1, 2], "2026-05-09"),
    draw("26051", [6, 7, 8, 9, 10], [3, 4], "2026-05-11"),
    draw("26052", [1, 8, 9, 10, 11], [4, 5], "2026-05-13"),
    draw("26053", [2, 3, 20, 28, 33], [2, 12], "2026-05-16"),
  ];
  const calls = [];

  const result = runDltBacktest(draws, {
    lookback: 2,
    rounds: 2,
    ticketsPerDraw: 2,
    sampler({ history, target, roundIndex }) {
      calls.push({
        roundIndex,
        target: target.issue,
        historyIssues: history.map((d) => d.issue),
      });
      return [
        ticket([1, 8, 9, 10, 11], [4, 6]),
        ticket([2, 3, 20, 28, 33], [2, 12]),
      ];
    },
  });

  assert.deepEqual(calls, [
    { roundIndex: 0, target: "26052", historyIssues: ["26050", "26051"] },
    { roundIndex: 1, target: "26053", historyIssues: ["26051", "26052"] },
  ]);
  assert.equal(result.records.length, 4);
  assert.equal(result.summary.rounds, 2);
  assert.equal(result.summary.totalTickets, 4);
  assert.equal(result.summary.hitDistribution["5+1"], 1);
  assert.equal(result.summary.hitDistribution["5+2"], 1);
});
