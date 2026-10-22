import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isPrime,
  oddEvenRatio,
  bigSmallRatio,
  primeCompositeRatio,
  path012Ratio,
  zoneRatio,
  acValue,
  consecutiveGroups,
  maxSameTail,
  groupBy,
  histogram,
} from "../assets/js/distribution.js";

test("isPrime basic cases", () => {
  assert.equal(isPrime(1), false);
  assert.equal(isPrime(2), true);
  assert.equal(isPrime(31), true);
  assert.equal(isPrime(33), false);
});

test("oddEvenRatio 3:3 for [1,2,3,4,5,6]", () => {
  assert.equal(oddEvenRatio([1, 2, 3, 4, 5, 6]), "3:3");
  assert.equal(oddEvenRatio([1, 3, 5, 7, 9, 11]), "6:0");
});

test("bigSmallRatio threshold 16", () => {
  assert.equal(bigSmallRatio([1, 2, 3, 16, 17, 33]), "2:4");
});

test("primeCompositeRatio for [2,3,5,7,11,13]", () => {
  assert.equal(primeCompositeRatio([2, 3, 5, 7, 11, 13]), "6:0");
  assert.equal(primeCompositeRatio([1, 4, 6, 8, 9, 10]), "0:6");
});

test("path012Ratio counts n % 3", () => {
  // 1%3=1, 2%3=2, 3%3=0, 4%3=1, 5%3=2, 6%3=0 -> 2:2:2
  assert.equal(path012Ratio([1, 2, 3, 4, 5, 6]), "2:2:2");
});

test("zoneRatio partitions 1-11/12-22/23-33", () => {
  assert.equal(zoneRatio([1, 5, 12, 20, 23, 33]), "2:2:2");
  assert.equal(zoneRatio([1, 2, 3, 4, 5, 6]), "6:0:0");
});

test("acValue known value for [1,2,3,4,5,6] = 0 (max consecutive)", () => {
  // diffs: 1,2,3,4,5 -> 5 unique - 5 = 0
  assert.equal(acValue([1, 2, 3, 4, 5, 6]), 0);
});

test("acValue maximum around 10 for spread-out reds", () => {
  // [1,2,5,11,20,32] should have high AC value
  const ac = acValue([1, 2, 5, 11, 20, 32]);
  assert.ok(ac >= 8 && ac <= 10);
});

test("consecutiveGroups counts runs", () => {
  assert.equal(consecutiveGroups([1, 2, 3, 7, 8, 20]), 2);
  assert.equal(consecutiveGroups([1, 5, 10, 15, 20, 25]), 0);
  assert.equal(consecutiveGroups([1, 2, 3, 4, 5, 6]), 1);
});

test("maxSameTail finds popular last digit", () => {
  assert.equal(maxSameTail([1, 11, 21, 3, 5, 7]), 3); // tail=1 appears 3 times
});

test("groupBy sorts by count desc", () => {
  const draws = [
    { reds: [1, 2, 3, 4, 5, 6], blue: 1 },
    { reds: [1, 3, 5, 7, 9, 11], blue: 1 }, // 6:0
    { reds: [7, 9, 11, 13, 15, 17], blue: 1 }, // 6:0
  ];
  const entries = groupBy(draws, (r) => oddEvenRatio(r));
  assert.equal(entries[0][0], "6:0");
  assert.equal(entries[0][1], 2);
});

test("histogram sorts values ascending", () => {
  const h = histogram([21, 50, 21, 100, 50, 50]);
  assert.deepEqual(h, [[21, 2], [50, 3], [100, 1]]);
});
