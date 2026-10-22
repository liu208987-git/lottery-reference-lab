import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chiSquared,
  expectedUniform,
  redChi,
  blueChi,
  chiSquaredPValue,
} from "../assets/js/chi-square.js";

test("chiSquared zero when observed equals expected", () => {
  const obs = [10, 10, 10, 10];
  const exp = [10, 10, 10, 10];
  assert.equal(chiSquared(obs, exp), 0);
});

test("chiSquared throws on length mismatch", () => {
  assert.throws(() => chiSquared([1, 2], [1, 2, 3]));
});

test("expectedUniform distributes total evenly", () => {
  const exp = expectedUniform(100, 4);
  assert.deepEqual(exp, [25, 25, 25, 25]);
});

test("redChi returns valid structure for sample draws", () => {
  const draws = [
    { reds: [1, 2, 3, 4, 5, 6], blue: 1 },
    { reds: [1, 2, 3, 4, 5, 7], blue: 2 },
  ];
  const r = redChi(draws);
  assert.equal(r.observed.length, 33);
  assert.equal(r.df, 32);
  assert.ok(r.chi >= 0);
});

test("blueChi returns valid structure", () => {
  const draws = [{ reds: [1, 2, 3, 4, 5, 6], blue: 1 }];
  const b = blueChi(draws);
  assert.equal(b.observed.length, 16);
  assert.equal(b.df, 15);
});

test("chiSquaredPValue approximates known values (df=1, chi=3.84 -> p≈0.05)", () => {
  const p = chiSquaredPValue(3.841, 1);
  assert.ok(Math.abs(p - 0.05) < 0.002, `expected ~0.05 got ${p}`);
});

test("chiSquaredPValue for df=10, chi=18.307 -> p≈0.05", () => {
  const p = chiSquaredPValue(18.307, 10);
  assert.ok(Math.abs(p - 0.05) < 0.002, `expected ~0.05 got ${p}`);
});

test("chiSquaredPValue for df=32, chi=46.194 -> p≈0.05", () => {
  const p = chiSquaredPValue(46.194, 32);
  assert.ok(Math.abs(p - 0.05) < 0.003, `expected ~0.05 got ${p}`);
});

test("chiSquaredPValue 1 when chi=0", () => {
  assert.equal(chiSquaredPValue(0, 10), 1);
});

test("chiSquaredPValue near 0 for extremely large chi", () => {
  const p = chiSquaredPValue(1000, 10);
  assert.ok(p < 1e-20);
});
