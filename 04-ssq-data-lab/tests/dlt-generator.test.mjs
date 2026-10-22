import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dltComplexTickets,
  dltDanTuoTickets,
  dltPriceOf,
} from "../assets/js/dlt-combinatorics.js";
import { generateDltTickets } from "../assets/js/dlt-generator.js";
import { generateDltAdvanced } from "../assets/js/dlt-advanced-sampler.js";
import { formatDltTicketLine } from "../assets/js/dlt-ui.js";

const FRONT_SIZE = 35;
const BACK_SIZE = 12;

function seededRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeFreq(size, fill = 1) {
  return Array(size + 1).fill(fill);
}

function assertDltTicket(t) {
  assert.equal(t.front.length, 5);
  assert.equal(t.back.length, 2);
  assert.equal(new Set(t.front).size, 5);
  assert.equal(new Set(t.back).size, 2);
  for (let i = 1; i < t.front.length; i++) assert.ok(t.front[i] > t.front[i - 1]);
  for (let i = 1; i < t.back.length; i++) assert.ok(t.back[i] > t.back[i - 1]);
  for (const n of t.front) assert.ok(n >= 1 && n <= FRONT_SIZE);
  for (const n of t.back) assert.ok(n >= 1 && n <= BACK_SIZE);
}

test("formatDltTicketLine formats front/back tickets", () => {
  assert.equal(formatDltTicketLine({ front: [3, 11, 18, 22, 31], back: [4, 11] }), "03 11 18 22 31 + 04 11");
});

test("DLT combinatorics uses 5-front plus 2-back rule", () => {
  assert.equal(dltComplexTickets(8, 3), 168); // C(8,5) * C(3,2)
  assert.equal(dltDanTuoTickets({ danFront: 1, tuoFront: 7, danBack: 0, tuoBack: 3 }), 105);
  assert.equal(dltPriceOf(105), 210);
  assert.throws(() => dltComplexTickets(4, 2));
  assert.throws(() => dltDanTuoTickets({ danFront: 5, tuoFront: 7, danBack: 0, tuoBack: 3 }));
});

test("generateDltTickets produces valid unique tickets under loose constraints", () => {
  const { tickets } = generateDltTickets({
    freqFront: makeFreq(FRONT_SIZE),
    freqBack: makeFreq(BACK_SIZE),
    strategyFront: "uniform",
    strategyBack: "uniform",
    alpha: 1,
    constraints: {},
    count: 6,
    rand: seededRand(20260523),
  });
  assert.equal(tickets.length, 6);
  for (const ticket of tickets) assertDltTicket(ticket);
  assert.equal(new Set(tickets.map((t) => t.key)).size, tickets.length);
});

test("generateDltTickets honours front/back include and exclude lists", () => {
  const includeFront = [3, 11];
  const includeBack = [4];
  const excludeFront = [1, 2, 5, 8];
  const excludeBack = [1, 2, 3];
  const { tickets } = generateDltTickets({
    freqFront: makeFreq(FRONT_SIZE),
    freqBack: makeFreq(BACK_SIZE),
    strategyFront: "uniform",
    strategyBack: "uniform",
    alpha: 1,
    constraints: {},
    count: 5,
    includeFront,
    includeBack,
    excludeFront,
    excludeBack,
    rand: seededRand(42),
  });
  assert.equal(tickets.length, 5);
  for (const t of tickets) {
    assertDltTicket(t);
    for (const n of includeFront) assert.ok(t.front.includes(n));
    for (const n of includeBack) assert.ok(t.back.includes(n));
    for (const n of excludeFront) assert.ok(!t.front.includes(n));
    for (const n of excludeBack) assert.ok(!t.back.includes(n));
  }
});

test("generateDltAdvanced Bayes-DPP returns valid tickets and diagnostics", () => {
  const totalDraws = 2800;
  const freqFront = makeFreq(FRONT_SIZE, Math.round(totalDraws * 5 / FRONT_SIZE));
  const freqBack = makeFreq(BACK_SIZE, Math.round(totalDraws * 2 / BACK_SIZE));
  const { tickets, diagnostics } = generateDltAdvanced({
    freqFront,
    freqBack,
    totalDraws,
    method: "bayes-dpp",
    count: 4,
    seed: "dlt-bayes-dpp",
  });

  assert.equal(tickets.length, 4);
  for (const t of tickets) assertDltTicket(t);
  assert.equal(diagnostics.method, "bayes-dpp");
  assert.ok(diagnostics.qualityScore >= 0 && diagnostics.qualityScore <= 100);
  assert.equal(diagnostics.poolSize, FRONT_SIZE);
  assert.equal(diagnostics.poolBackSize, BACK_SIZE);
});
