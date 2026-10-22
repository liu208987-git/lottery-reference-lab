import { test } from "node:test";
import assert from "node:assert/strict";

import {
  combinations,
  danTuoTickets,
  complexTickets,
  priceOf,
} from "../assets/js/combinatorics.js";

test("combinations basic values", () => {
  assert.equal(combinations(5, 2), 10);
  assert.equal(combinations(33, 6), 1107568);
  assert.equal(combinations(10, 0), 1);
  assert.equal(combinations(10, 10), 1);
});

test("combinations returns 0 for invalid k", () => {
  assert.equal(combinations(5, -1), 0);
  assert.equal(combinations(5, 6), 0);
});

test("danTuoTickets basic: 2 dan + 10 tuo + 1 blue = C(10,4) = 210", () => {
  assert.equal(danTuoTickets({ danCount: 2, tuoCount: 10, blueCount: 1 }), 210);
});

test("danTuoTickets with multiple blues multiplies", () => {
  assert.equal(danTuoTickets({ danCount: 2, tuoCount: 10, blueCount: 3 }), 630);
});

test("danTuoTickets zero dan = full complex", () => {
  // 0 dan + 8 tuo -> C(8,6) = 28
  assert.equal(danTuoTickets({ danCount: 0, tuoCount: 8, blueCount: 1 }), 28);
});

test("danTuoTickets rejects invalid inputs", () => {
  assert.throws(() => danTuoTickets({ danCount: 6, tuoCount: 10, blueCount: 1 }));
  assert.throws(() => danTuoTickets({ danCount: 2, tuoCount: 3, blueCount: 1 })); // tuo too few
  assert.throws(() => danTuoTickets({ danCount: 2, tuoCount: 10, blueCount: 0 }));
});

test("complexTickets 8 red + 1 blue = 28", () => {
  assert.equal(complexTickets(8, 1), 28);
});

test("complexTickets matches C(n,6)*blue", () => {
  assert.equal(complexTickets(10, 2), 210 * 2);
});

test("priceOf 2 yuan per ticket", () => {
  assert.equal(priceOf(100), 200);
});
