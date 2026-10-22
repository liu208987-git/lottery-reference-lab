import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCooccurrenceMatrix,
  matrixMax,
  topPartners,
  liftOf,
  extremePairs,
  INDEPENDENT_LIFT_BASELINE,
} from "../assets/js/cooccurrence.js";

const sampleDraws = [
  { issue: "1", reds: [1, 2, 3, 4, 5, 6], blue: 1 },
  { issue: "2", reds: [1, 2, 7, 8, 9, 10], blue: 2 },
  { issue: "3", reds: [3, 4, 5, 6, 11, 12], blue: 3 },
];

test("buildCooccurrenceMatrix is symmetric with zero diagonal", () => {
  const m = buildCooccurrenceMatrix(sampleDraws);
  for (let i = 1; i <= 33; i++) assert.equal(m[i][i], 0);
  for (let i = 1; i <= 33; i++) {
    for (let j = i + 1; j <= 33; j++) {
      assert.equal(m[i][j], m[j][i], `(${i},${j}) symmetry`);
    }
  }
});

test("buildCooccurrenceMatrix counts pairs correctly", () => {
  const m = buildCooccurrenceMatrix(sampleDraws);
  // 1 与 2 同期出现 2 次（draw 1 + draw 2）
  assert.equal(m[1][2], 2);
  // 3 与 4 同期出现 2 次（draw 1 + draw 3）
  assert.equal(m[3][4], 2);
  // 1 与 3 仅 draw 1 同期 1 次
  assert.equal(m[1][3], 1);
  // 1 与 11 从未同期
  assert.equal(m[1][11], 0);
});

test("each draw contributes C(6,2)=15 to total upper-triangle sum", () => {
  const m = buildCooccurrenceMatrix(sampleDraws);
  let total = 0;
  for (let i = 1; i <= 33; i++) {
    for (let j = i + 1; j <= 33; j++) total += m[i][j];
  }
  assert.equal(total, sampleDraws.length * 15);
});

test("matrixMax returns largest upper-triangle value", () => {
  const m = buildCooccurrenceMatrix(sampleDraws);
  assert.equal(matrixMax(m), 2);
});

test("topPartners returns sorted partners excluding self", () => {
  const m = buildCooccurrenceMatrix(sampleDraws);
  const partners = topPartners(m, 1, 5);
  assert.equal(partners.length, 5);
  assert.ok(!partners.some(([n]) => n === 1));
  // 1 与 2,7,8,9,10 都共现 1 次（draw 2），与 3,4,5,6 也是 1 次（draw 1）
  // 但与 2 的共现是 2 次（draw 1 + draw 2）
  assert.equal(partners[0][0], 2);
  assert.equal(partners[0][1], 2);
});

test("liftOf returns 0 when frequency is 0", () => {
  const m = buildCooccurrenceMatrix(sampleDraws);
  const freqs = Array(34).fill(0);
  for (const d of sampleDraws) for (const r of d.reds) freqs[r]++;
  // 号码 33 在样本里 freq=0
  assert.equal(liftOf(m, freqs, sampleDraws.length, 33, 1), 0);
});

test("liftOf is positive for co-occurring pairs", () => {
  const m = buildCooccurrenceMatrix(sampleDraws);
  const freqs = Array(34).fill(0);
  for (const d of sampleDraws) for (const r of d.reds) freqs[r]++;
  const lift = liftOf(m, freqs, sampleDraws.length, 1, 2);
  assert.ok(lift > 0);
});

test("INDEPENDENT_LIFT_BASELINE is approximately 0.859", () => {
  assert.ok(Math.abs(INDEPENDENT_LIFT_BASELINE - 0.859) < 0.01);
});

test("extremePairs returns at most k entries", () => {
  const m = buildCooccurrenceMatrix(sampleDraws);
  const freqs = Array(34).fill(0);
  for (const d of sampleDraws) for (const r of d.reds) freqs[r]++;
  const ex = extremePairs(m, freqs, sampleDraws.length, 5);
  assert.ok(ex.length <= 5);
  for (const p of ex) assert.ok(p.count > 0);
});
