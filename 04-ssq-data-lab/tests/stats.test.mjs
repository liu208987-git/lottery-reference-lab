import { test } from "node:test";
import assert from "node:assert/strict";

import {
  freqFromDraws,
  missCounts,
  topN,
  bottomN,
  zoneCounts,
  spanOf,
  sumOf,
  oddCountOf,
  passesConstraints,
  analyseConstraintFailures,
  RED_MAX,
  BLUE_MAX,
} from "../assets/js/stats.js";

const draws = [
  { issue: "A", reds: [1, 2, 3, 4, 5, 6], blue: 1 },
  { issue: "B", reds: [1, 2, 10, 20, 30, 33], blue: 2 },
  { issue: "C", reds: [5, 6, 7, 8, 9, 10], blue: 1 },
];

test("freqFromDraws counts red and blue occurrences", () => {
  const r = freqFromDraws(draws, "reds", RED_MAX);
  assert.equal(r[1], 2);
  assert.equal(r[2], 2);
  assert.equal(r[5], 2);
  assert.equal(r[10], 2);
  assert.equal(r[33], 1);
  assert.equal(r[15], 0);

  const b = freqFromDraws(draws, "blue", BLUE_MAX);
  assert.equal(b[1], 2);
  assert.equal(b[2], 1);
  assert.equal(b[3], 0);
});

test("missCounts gives 0 for numbers in the last draw", () => {
  const miss = missCounts(draws, "reds", RED_MAX);
  for (const n of [5, 6, 7, 8, 9, 10]) assert.equal(miss[n], 0);
  assert.equal(miss[1], 1);
  assert.equal(miss[33], 1);
  assert.equal(miss[15], draws.length);
});

test("topN sorts desc by value then asc by number", () => {
  const freq = Array(RED_MAX + 1).fill(0);
  freq[3] = 5;
  freq[7] = 5;
  freq[1] = 3;
  const top = topN(freq, 3, RED_MAX);
  assert.deepEqual(top, [[3, 5], [7, 5], [1, 3]]);
});

test("bottomN sorts asc by value then asc by number", () => {
  const freq = Array(RED_MAX + 1).fill(1);
  freq[10] = 0;
  freq[20] = 0;
  const bot = bottomN(freq, 2, RED_MAX);
  assert.deepEqual(bot, [[10, 0], [20, 0]]);
});

test("zoneCounts partitions 1-11 / 12-22 / 23-33", () => {
  assert.deepEqual(zoneCounts([1, 2, 11, 12, 22, 23]), [3, 2, 1]);
  assert.deepEqual(zoneCounts([1, 2, 3, 4, 5, 6]), [6, 0, 0]);
});

test("spanOf/sumOf/oddCountOf basics", () => {
  assert.equal(spanOf([1, 2, 3, 4, 5, 33]), 32);
  assert.equal(sumOf([1, 2, 3, 4, 5, 6]), 21);
  assert.equal(oddCountOf([1, 2, 3, 4, 5, 6]), 3);
});

test("passesConstraints respects sum/odd/span/zone rules", () => {
  const good = [3, 8, 13, 18, 23, 28]; // sum=93, odd=3, span=25, zone=2:2:2
  assert.ok(passesConstraints(good, { sum: true, odd: true, span: true, zone: true }));

  const sumTooLow = [1, 2, 3, 4, 5, 6]; // sum=21
  assert.ok(!passesConstraints(sumTooLow, { sum: true }));

  const zoneBust = [1, 2, 3, 4, 5, 11]; // zone 6:0:0
  assert.ok(!passesConstraints(zoneBust, { zone: true }));
});

test("analyseConstraintFailures reports each broken rule", () => {
  const reasons = analyseConstraintFailures([1, 2, 3, 4, 5, 6], {
    sum: true, odd: true, span: true, zone: true,
  });
  assert.equal(reasons.length, 3); // sum<70, span<18, zone>4; odd=3 is fine
  assert.ok(reasons.some((r) => r.includes("和值")));
  assert.ok(reasons.some((r) => r.includes("跨度")));
  assert.ok(reasons.some((r) => r.includes("单区")));
});
