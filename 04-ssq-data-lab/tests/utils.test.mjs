import { test } from "node:test";
import assert from "node:assert/strict";

import { parseNumList, clamp, pad2 } from "../assets/js/utils.js";

test("parseNumList handles common separators", () => {
  assert.deepEqual(parseNumList("1, 2 3、4；5;6"), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseNumList("03 11 18 22 27 31", 1, 33), [3, 11, 18, 22, 27, 31]);
});

test("parseNumList trims, dedupes and skips invalid tokens", () => {
  assert.deepEqual(parseNumList("  03 , 03, abc, 7, 7 "), [3, 7]);
});

test("parseNumList filters by [lo, hi]", () => {
  assert.deepEqual(parseNumList("0, 1, 33, 34, -2, 17", 1, 33), [1, 33, 17]);
});

test("parseNumList tolerates empty / nullish input", () => {
  assert.deepEqual(parseNumList(""), []);
  assert.deepEqual(parseNumList(null), []);
  assert.deepEqual(parseNumList(undefined), []);
});

test("parseNumList rejects non-integers (decimals)", () => {
  assert.deepEqual(parseNumList("1, 2.5, 3"), [1, 3]);
});

test("clamp/pad2 sanity", () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(-1, 1, 10), 1);
  assert.equal(clamp(99, 1, 10), 10);
  assert.equal(pad2(3), "03");
  assert.equal(pad2(33), "33");
});
