import { test } from "node:test";
import assert from "node:assert/strict";

import { missStats } from "../assets/js/miss-stats.js";

test("missStats single-number basic case", () => {
  const draws = [
    { reds: [1, 2, 3, 4, 5, 6], blue: 1 },
    { reds: [7, 8, 9, 10, 11, 12], blue: 2 },
    { reds: [1, 13, 14, 15, 16, 17], blue: 3 },
    { reds: [18, 19, 20, 21, 22, 23], blue: 4 },
  ];
  const s = missStats(draws, 33, "reds");
  assert.equal(s[1].freq, 2);
  // 1 出现在 idx 0 和 idx 2，开局立即中（gap=0），第二次中前 gap=1，currentMiss=4-1-2=1
  assert.equal(s[1].currentMiss, 1);
  assert.equal(s[1].maxMiss, 1);
  // 平均遗漏 = N/freq - 1 = 4/2 - 1 = 1
  assert.equal(s[1].avgMiss, 1);
});

test("missStats: never appears -> currentMiss = total, maxMiss = total, freq = 0", () => {
  const draws = [
    { reds: [1, 2, 3, 4, 5, 6], blue: 1 },
    { reds: [7, 8, 9, 10, 11, 12], blue: 2 },
  ];
  const s = missStats(draws, 33, "reds");
  assert.equal(s[33].freq, 0);
  assert.equal(s[33].currentMiss, 2);
  assert.equal(s[33].maxMiss, 2);
});

test("missStats blue field works the same way", () => {
  const draws = [
    { reds: [1, 2, 3, 4, 5, 6], blue: 5 },
    { reds: [1, 2, 3, 4, 5, 6], blue: 5 },
    { reds: [1, 2, 3, 4, 5, 6], blue: 8 },
    { reds: [1, 2, 3, 4, 5, 6], blue: 5 },
  ];
  const s = missStats(draws, 16, "blue");
  assert.equal(s[5].freq, 3);
  assert.equal(s[5].currentMiss, 0);
  assert.equal(s[5].maxMiss, 1);
});

test("missStats: total currentMiss + freq * (avg+1) ≈ N for each number that appears", () => {
  const draws = Array.from({ length: 100 }, (_, i) => ({
    reds: [(i % 33) + 1, ((i + 1) % 33) + 1, ((i + 2) % 33) + 1,
           ((i + 3) % 33) + 1, ((i + 4) % 33) + 1, ((i + 5) % 33) + 1].sort((a, b) => a - b),
    blue: (i % 16) + 1,
  }));
  const s = missStats(draws, 33, "reds");
  for (let n = 1; n <= 33; n++) {
    if (s[n].freq === 0) continue;
    // avgMiss = N/freq - 1
    assert.ok(Math.abs(s[n].avgMiss - (100 / s[n].freq - 1)) < 1e-9);
  }
});
