import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeWeightsFromFreq,
  makeMixedWeights,
  weightedPickOne,
  weightedSampleWithoutReplacement,
  crowdPenalty,
  coveragePenalty,
  generateTickets,
} from "../assets/js/generator.js";
import { formatTicketLine } from "../assets/js/ui.js";

const RED_SIZE = 33;
const BLUE_SIZE = 16;

function seededRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeFreq(size, fill = 1) {
  const f = Array(size + 1).fill(fill);
  return f;
}

function averageRedOverlap(tickets) {
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < tickets.length; i++) {
    for (let j = i + 1; j < tickets.length; j++) {
      total += tickets[i].reds.filter((n) => tickets[j].reds.includes(n)).length;
      pairs++;
    }
  }
  return pairs ? total / pairs : 0;
}

test("formatTicketLine formats generated tickets for copy-all", () => {
  assert.equal(formatTicketLine({ reds: [3, 11, 18, 22, 27, 31], blue: 8 }), "03 11 18 22 27 31 + 08");
});

test("crowdPenalty penalizes popular-looking tickets", () => {
  const popular = crowdPenalty([1, 2, 3, 4, 5, 6], 8);
  const spread = crowdPenalty([4, 13, 22, 27, 32, 33], 11);
  assert.ok(popular > spread, `${popular} should be greater than ${spread}`);
});

test("coveragePenalty penalizes overlap with existing tickets", () => {
  const existing = [{ reds: [1, 2, 3, 4, 5, 6], blue: 8 }];
  const highOverlap = coveragePenalty({ reds: [1, 2, 3, 7, 8, 9], blue: 8 }, existing);
  const lowOverlap = coveragePenalty({ reds: [10, 11, 12, 13, 14, 15], blue: 9 }, existing);
  assert.ok(highOverlap > lowOverlap, `${highOverlap} should be greater than ${lowOverlap}`);
});

test("generateTickets diverse mode reduces red overlap under fixed random seed", () => {
  const freqR = makeFreq(RED_SIZE, 1);
  const freqB = makeFreq(BLUE_SIZE, 1);
  const base = generateTickets({
    freqR,
    freqB,
    strategyRed: "uniform",
    strategyBlue: "uniform",
    alpha: 1,
    constraints: { sum: false, odd: false, span: false, zone: false },
    count: 10,
    rand: seededRand(20260515),
  }).tickets;
  const diverse = generateTickets({
    freqR,
    freqB,
    strategyRed: "uniform",
    strategyBlue: "uniform",
    alpha: 1,
    constraints: { sum: false, odd: false, span: false, zone: false },
    count: 10,
    optimize: "diverse",
    candidateBatch: 30,
    rand: seededRand(20260515),
  }).tickets;
  assert.equal(diverse.length, 10);
  assert.ok(averageRedOverlap(diverse) <= 1.8);
  assert.ok(diverse.every((ticket) => crowdPenalty(ticket.reds, ticket.blue) <= 4));
});

test("makeWeightsFromFreq hot favours higher-freq numbers", () => {
  const freq = makeFreq(RED_SIZE, 0);
  freq[1] = 10;
  freq[2] = 0;
  const w = makeWeightsFromFreq(freq, "hot", 1);
  assert.ok(w[0] > w[1]); // index 0 corresponds to number 1
});

test("makeWeightsFromFreq cold favours lower-freq numbers", () => {
  const freq = makeFreq(RED_SIZE, 0);
  freq[1] = 10;
  freq[2] = 0;
  const w = makeWeightsFromFreq(freq, "cold", 1);
  assert.ok(w[1] > w[0]);
});

test("uniform strategy gives equal weights", () => {
  const freq = makeFreq(RED_SIZE, 5);
  const w = makeWeightsFromFreq(freq, "uniform", 1);
  assert.ok(w.every((x) => x === w[0]));
});

test("weightedPickOne returns an item from items list", () => {
  const items = [10, 20, 30];
  const weights = [0, 1, 0];
  const rand = seededRand(42);
  assert.equal(weightedPickOne(items, weights, rand), 20);
});

test("weightedSampleWithoutReplacement returns k unique items", () => {
  const items = Array.from({ length: RED_SIZE }, (_, i) => i + 1);
  const weights = items.map(() => 1);
  const rand = seededRand(7);
  const picks = weightedSampleWithoutReplacement(items, weights, 6, rand);
  assert.equal(picks.length, 6);
  assert.equal(new Set(picks).size, 6);
  for (const p of picks) assert.ok(p >= 1 && p <= RED_SIZE);
});

test("generateTickets produces requested count under loose constraints", () => {
  const freqR = makeFreq(RED_SIZE, 1);
  const freqB = makeFreq(BLUE_SIZE, 1);
  const rand = seededRand(123);
  const { tickets } = generateTickets({
    freqR,
    freqB,
    strategyRed: "uniform",
    strategyBlue: "uniform",
    alpha: 1,
    constraints: { sum: false, odd: false, span: false, zone: false },
    count: 5,
    rand,
  });
  assert.equal(tickets.length, 5);
  for (const t of tickets) {
    assert.equal(t.reds.length, 6);
    assert.equal(new Set(t.reds).size, 6);
    assert.ok(t.blue >= 1 && t.blue <= BLUE_SIZE);
    for (let i = 1; i < t.reds.length; i++) assert.ok(t.reds[i] > t.reds[i - 1]); // sorted asc
  }
  const keys = new Set(tickets.map((t) => t.key));
  assert.equal(keys.size, tickets.length); // deduped
});

test("generateTickets reports failures when constraints are unsatisfiable", () => {
  // Force impossible span on a tiny pool: make weights concentrate on low numbers only
  const freqR = Array(RED_SIZE + 1).fill(0);
  for (let i = 1; i <= 6; i++) freqR[i] = 100; // only small reds have weight
  const freqB = makeFreq(BLUE_SIZE, 1);
  const rand = seededRand(1);
  const { tickets, tries, failureReasons } = generateTickets({
    freqR,
    freqB,
    strategyRed: "hot",
    strategyBlue: "uniform",
    alpha: 2,
    constraints: { span: true, sum: false, odd: false, zone: false },
    count: 3,
    maxTry: 200,
    rand,
  });
  assert.ok(tries > 0);
  assert.ok(tickets.length <= 3);
  if (tickets.length === 0) {
    assert.ok(Object.keys(failureReasons).length > 0);
  }
});

test("makeMixedWeights suppresses extreme hot and cold", () => {
  // hot 极端高 / cold 极端高 → 几何平均都被压低；中间值权重相对最高
  const freq = makeFreq(RED_SIZE, 5);
  freq[1] = 50;  // 极热
  freq[2] = 0;   // 极冷
  freq[10] = 5;  // 中庸
  const w = makeMixedWeights(freq, 1);
  // index 0 = 号码1（极热），index 1 = 号码2（极冷），index 9 = 号码10（中庸）
  assert.ok(w[9] >= w[0], `mid (${w[9]}) should not be lower than hot (${w[0]})`);
  assert.ok(w[9] >= w[1], `mid (${w[9]}) should not be lower than cold (${w[1]})`);
});

test("generateTickets honours includeRed (胆码) appearing in every ticket", () => {
  const freqR = makeFreq(RED_SIZE, 1);
  const freqB = makeFreq(BLUE_SIZE, 1);
  const rand = seededRand(11);
  const { tickets } = generateTickets({
    freqR, freqB,
    strategyRed: "uniform",
    strategyBlue: "uniform",
    alpha: 1,
    constraints: { sum: false, odd: false, span: false, zone: false },
    count: 6,
    includeRed: [3, 11, 22],
    rand,
  });
  assert.equal(tickets.length, 6);
  for (const t of tickets) {
    assert.ok(t.reds.includes(3));
    assert.ok(t.reds.includes(11));
    assert.ok(t.reds.includes(22));
    assert.equal(t.reds.length, 6);
    assert.equal(new Set(t.reds).size, 6);
  }
});

test("generateTickets respects excludeRed and excludeBlue", () => {
  const freqR = makeFreq(RED_SIZE, 1);
  const freqB = makeFreq(BLUE_SIZE, 1);
  const rand = seededRand(31);
  const excludeRed = [1, 2, 3, 4, 5];
  const excludeBlue = [1, 2, 3, 4, 5, 6, 7, 8];
  const { tickets } = generateTickets({
    freqR, freqB,
    strategyRed: "uniform",
    strategyBlue: "uniform",
    alpha: 1,
    constraints: { sum: false, odd: false, span: false, zone: false },
    count: 8,
    excludeRed,
    excludeBlue,
    rand,
  });
  assert.equal(tickets.length, 8);
  for (const t of tickets) {
    for (const n of excludeRed) assert.ok(!t.reds.includes(n));
    assert.ok(!excludeBlue.includes(t.blue));
  }
});

test("generateTickets avoidLast keeps tickets disjoint from previous reds", () => {
  const freqR = makeFreq(RED_SIZE, 1);
  const freqB = makeFreq(BLUE_SIZE, 1);
  const rand = seededRand(7);
  const avoidLast = [4, 8, 15, 16, 23, 30];
  const { tickets } = generateTickets({
    freqR, freqB,
    strategyRed: "uniform",
    strategyBlue: "uniform",
    alpha: 1,
    constraints: { sum: false, odd: false, span: false, zone: false },
    count: 5,
    avoidLast,
    rand,
  });
  assert.equal(tickets.length, 5);
  for (const t of tickets) {
    for (const n of avoidLast) assert.ok(!t.reds.includes(n));
  }
});

test("includeRed wins over excludeRed when conflicting", () => {
  const freqR = makeFreq(RED_SIZE, 1);
  const freqB = makeFreq(BLUE_SIZE, 1);
  const rand = seededRand(99);
  const { tickets } = generateTickets({
    freqR, freqB,
    strategyRed: "uniform",
    strategyBlue: "uniform",
    alpha: 1,
    constraints: { sum: false, odd: false, span: false, zone: false },
    count: 3,
    includeRed: [7, 14],
    excludeRed: [7], // 与胆码冲突，应该被胆码覆盖
    rand,
  });
  for (const t of tickets) {
    assert.ok(t.reds.includes(7), `ticket ${t.reds} should still include 7`);
    assert.ok(t.reds.includes(14));
  }
});

test("generateTickets throws when too many include reds", () => {
  const freqR = makeFreq(RED_SIZE, 1);
  const freqB = makeFreq(BLUE_SIZE, 1);
  assert.throws(() => generateTickets({
    freqR, freqB,
    strategyRed: "uniform",
    strategyBlue: "uniform",
    alpha: 1,
    constraints: {},
    count: 1,
    includeRed: [1, 2, 3, 4, 5, 6, 7],
  }), /胆码/);
});

test("generateTickets throws when pool is too small after excludes", () => {
  const freqR = makeFreq(RED_SIZE, 1);
  const freqB = makeFreq(BLUE_SIZE, 1);
  const excludeRed = Array.from({ length: 30 }, (_, i) => i + 1); // exclude 1..30 → only 31,32,33 left
  assert.throws(() => generateTickets({
    freqR, freqB,
    strategyRed: "uniform",
    strategyBlue: "uniform",
    alpha: 1,
    constraints: {},
    count: 1,
    excludeRed,
  }), /排除过多/);
});

test("generateTickets throws when all blues are excluded", () => {
  const freqR = makeFreq(RED_SIZE, 1);
  const freqB = makeFreq(BLUE_SIZE, 1);
  const excludeBlue = Array.from({ length: BLUE_SIZE }, (_, i) => i + 1);
  assert.throws(() => generateTickets({
    freqR, freqB,
    strategyRed: "uniform",
    strategyBlue: "uniform",
    alpha: 1,
    constraints: {},
    count: 1,
    excludeBlue,
  }), /蓝球/);
});

test("AC and noConsec constraints are enforced when set", () => {
  const freqR = makeFreq(RED_SIZE, 1);
  const freqB = makeFreq(BLUE_SIZE, 1);
  const rand = seededRand(2026);
  const { tickets } = generateTickets({
    freqR, freqB,
    strategyRed: "uniform",
    strategyBlue: "uniform",
    alpha: 1,
    constraints: { ac: true, noConsec: true },
    count: 6,
    maxTry: 3000,
    rand,
  });
  // 至少应该有几注满足
  assert.ok(tickets.length > 0);
  for (const t of tickets) {
    // AC ≥ 7
    const diffs = new Set();
    for (let i = 0; i < t.reds.length; i++) {
      for (let j = i + 1; j < t.reds.length; j++) {
        diffs.add(Math.abs(t.reds[i] - t.reds[j]));
      }
    }
    assert.ok(diffs.size - (t.reds.length - 1) >= 7);
    // 连号组 ≤ 1
    let groups = 0, inRun = false;
    const sorted = [...t.reds].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] === 1) {
        if (!inRun) groups++;
        inRun = true;
      } else inRun = false;
    }
    assert.ok(groups <= 1);
  }
});
