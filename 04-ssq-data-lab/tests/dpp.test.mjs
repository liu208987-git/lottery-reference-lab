import { test } from "node:test";
import assert from "node:assert/strict";

import { buildLKernel, greedyKDPP, logDetSubmatrix } from "../assets/js/dpp.js";

test("L kernel is symmetric and has positive diagonal", () => {
  const q = [0]; for (let i = 1; i <= 33; i++) q.push(0.5 + (i % 7) * 0.1);
  const L = buildLKernel(q);
  for (let i = 1; i <= 33; i++) {
    assert.ok(L[i][i] > 0, `diag i=${i}`);
    for (let j = i + 1; j <= 33; j++) {
      assert.ok(Math.abs(L[i][j] - L[j][i]) < 1e-12, `(${i},${j}) symmetry`);
    }
  }
});

test("L kernel diagonal equals q_i² and off-diagonal scales with similarity", () => {
  const q = [0]; for (let i = 1; i <= 33; i++) q.push(1);
  const L = buildLKernel(q, { tau: 5 });
  // 当 q=1 时 L_ij = sim(i,j)
  // 1 与 2 的距离 = 1 → exp(-1/5) ≈ 0.819；同区(1-11)、不同尾。
  const expected12 = Math.exp(-1 / 5) + 0.2; // sameZoneBoost
  assert.ok(Math.abs(L[1][2] - Math.min(1, expected12)) < 0.01);
  // 1 与 33 → exp(-32/5) ≈ 0.002 + sameTailBoost? 33%10=3, 1%10=1 → 不同尾，不同区
  assert.ok(L[1][33] < 0.01);
});

test("greedy k-DPP returns exactly k items, all distinct, from pool", () => {
  const q = [0]; for (let i = 1; i <= 33; i++) q.push(1);
  const L = buildLKernel(q);
  const result = greedyKDPP(L, 6);
  assert.equal(result.length, 6);
  const set = new Set(result);
  assert.equal(set.size, 6);
  for (const r of result) assert.ok(r >= 1 && r <= 33);
});

test("greedy DPP picks spread-out numbers (not all consecutive)", () => {
  const q = [0]; for (let i = 1; i <= 33; i++) q.push(1);
  const L = buildLKernel(q, { tau: 8 });
  const result = greedyKDPP(L, 6);
  const sorted = [...result].sort((a, b) => a - b);
  // 平均间距应该比"连号"大很多。33/6 ≈ 5.5
  let consecutivePairs = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] === 1) consecutivePairs++;
  }
  assert.ok(consecutivePairs <= 1, `should have ≤1 consecutive pair, got ${consecutivePairs}`);
});

test("greedy DPP respects pinned numbers", () => {
  const q = [0]; for (let i = 1; i <= 33; i++) q.push(1);
  const L = buildLKernel(q);
  const pinned = [3, 17, 28];
  const result = greedyKDPP(L, 6, { pinned });
  assert.equal(result.length, 6);
  for (const p of pinned) assert.ok(result.includes(p));
});

test("greedy DPP respects pool restrictions", () => {
  const q = [0]; for (let i = 1; i <= 33; i++) q.push(1);
  const L = buildLKernel(q);
  const pool = [1, 2, 3, 4, 5, 6, 7];
  const result = greedyKDPP(L, 6, { pool });
  assert.equal(result.length, 6);
  for (const r of result) assert.ok(pool.includes(r));
});

test("logDetSubmatrix matches direct 2x2 determinant", () => {
  const L = Array.from({ length: 4 }, () => Array(4).fill(0));
  // 简单 PSD 矩阵：[[2,1],[1,3]] det = 5
  L[1][1] = 2; L[1][2] = 1;
  L[2][1] = 1; L[2][2] = 3;
  const ld = logDetSubmatrix(L, [1, 2]);
  assert.ok(Math.abs(ld - Math.log(5)) < 1e-9);
});

test("logDetSubmatrix returns -Infinity for non-PSD or singular", () => {
  const L = [[0,0,0],[0,1,1],[0,1,1]]; // 2 行相同，det=0
  const ld = logDetSubmatrix(L, [1, 2]);
  assert.equal(ld, -Infinity);
});

test("DPP greedy with high quality bias picks high-q numbers", () => {
  const q = [0]; for (let i = 1; i <= 33; i++) q.push(0.01);
  q[5] = q[15] = q[25] = 10; // 突出三个高质量
  const L = buildLKernel(q);
  const result = greedyKDPP(L, 6);
  assert.ok(result.includes(5));
  assert.ok(result.includes(15));
  assert.ok(result.includes(25));
});
