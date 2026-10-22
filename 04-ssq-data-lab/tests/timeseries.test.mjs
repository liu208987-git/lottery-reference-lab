import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSeries, movingAverage } from "../assets/js/timeseries.js";

const draws = [
  { reds: [1, 2, 3, 4, 5, 6], blue: 1 },
  { reds: [10, 12, 14, 16, 20, 22], blue: 8 },
  { reds: [3, 9, 11, 19, 23, 33], blue: 16 },
];

test("buildSeries sum", () => {
  assert.deepEqual(buildSeries(draws, "sum"), [21, 94, 98]);
});

test("buildSeries span", () => {
  assert.deepEqual(buildSeries(draws, "span"), [5, 12, 30]);
});

test("buildSeries odd", () => {
  assert.deepEqual(buildSeries(draws, "odd"), [3, 0, 6]);
});

test("buildSeries blue", () => {
  assert.deepEqual(buildSeries(draws, "blue"), [1, 8, 16]);
});

test("movingAverage with window=1 returns input copy", () => {
  const v = [1, 2, 3, 4];
  const out = movingAverage(v, 1);
  assert.deepEqual(out, v);
  assert.notEqual(out, v); // 是副本
});

test("movingAverage with window=3 stabilises after warm-up", () => {
  const v = [3, 6, 9, 12, 15];
  const ma = movingAverage(v, 3);
  // 前两个未达窗口，按可用样本平均
  assert.equal(ma[0], 3);
  assert.equal(ma[1], 4.5);
  assert.equal(ma[2], 6); // (3+6+9)/3
  assert.equal(ma[3], 9); // (6+9+12)/3
  assert.equal(ma[4], 12); // (9+12+15)/3
});

test("movingAverage of constant series equals the constant", () => {
  const v = Array(20).fill(7);
  const ma = movingAverage(v, 5);
  for (const x of ma) assert.equal(x, 7);
});
