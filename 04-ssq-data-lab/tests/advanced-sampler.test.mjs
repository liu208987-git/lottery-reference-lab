import { test } from "node:test";
import assert from "node:assert/strict";

import { generateAdvanced } from "../assets/js/advanced-sampler.js";

// 构造一个可控的 freq 数据：均匀且大样本（接近真实场景）
function uniformFreqs(N) {
  const freqR = Array(34).fill(0);
  const freqB = Array(17).fill(0);
  for (let i = 1; i <= 33; i++) freqR[i] = Math.round(N * 6 / 33);
  for (let i = 1; i <= 16; i++) freqB[i] = Math.round(N / 16);
  return { freqR, freqB, totalDraws: N };
}

const N = 3000;

test("Bayes-DPP: returns requested count of valid tickets", () => {
  const { freqR, freqB, totalDraws } = uniformFreqs(N);
  const { tickets, diagnostics } = generateAdvanced({
    freqR, freqB, totalDraws,
    method: "bayes-dpp",
    count: 5,
    constraints: {},
    seed: "test-bdpp",
  });
  assert.equal(tickets.length, 5);
  for (const t of tickets) {
    assert.equal(t.reds.length, 6);
    assert.equal(new Set(t.reds).size, 6);
    for (const r of t.reds) assert.ok(r >= 1 && r <= 33);
    assert.ok(t.blue >= 1 && t.blue <= 16);
  }
  assert.ok(diagnostics.qualityScore >= 0 && diagnostics.qualityScore <= 100);
  assert.equal(diagnostics.method, "bayes-dpp");
});

test("Thompson: returns valid tickets and score", () => {
  const { freqR, freqB, totalDraws } = uniformFreqs(N);
  const { tickets, diagnostics } = generateAdvanced({
    freqR, freqB, totalDraws,
    method: "thompson",
    count: 5,
    seed: "test-ts",
  });
  assert.equal(tickets.length, 5);
  assert.equal(diagnostics.method, "thompson");
});

test("MCMC: produces samples with diagnostics", () => {
  const { freqR, freqB, totalDraws } = uniformFreqs(N);
  const { tickets, diagnostics } = generateAdvanced({
    freqR, freqB, totalDraws,
    method: "mcmc",
    count: 5,
    mcmcIterations: 1500,
    mcmcBurnIn: 300,
    mcmcThin: 4,
    mcmcChains: 2,
    seed: "test-mcmc",
  });
  assert.equal(tickets.length, 5);
  assert.equal(diagnostics.method, "mcmc");
  assert.ok(diagnostics.acceptRate > 0);
  assert.ok(diagnostics.ess > 0);
  assert.ok(Number.isFinite(diagnostics.rHat));
});

test("seed reproducibility: same seed → identical tickets (Bayes-DPP)", () => {
  const { freqR, freqB, totalDraws } = uniformFreqs(N);
  const a = generateAdvanced({ freqR, freqB, totalDraws, method: "bayes-dpp", count: 5, seed: "fixed-seed-42" });
  const b = generateAdvanced({ freqR, freqB, totalDraws, method: "bayes-dpp", count: 5, seed: "fixed-seed-42" });
  assert.equal(a.tickets.length, b.tickets.length);
  for (let i = 0; i < a.tickets.length; i++) {
    assert.deepEqual(a.tickets[i].reds, b.tickets[i].reds);
    assert.equal(a.tickets[i].blue, b.tickets[i].blue);
  }
});

test("seed reproducibility: different seeds → different tickets", () => {
  const { freqR, freqB, totalDraws } = uniformFreqs(N);
  const a = generateAdvanced({ freqR, freqB, totalDraws, method: "bayes-dpp", count: 5, seed: "alpha" });
  const b = generateAdvanced({ freqR, freqB, totalDraws, method: "bayes-dpp", count: 5, seed: "beta" });
  let identical = 0;
  for (let i = 0; i < Math.min(a.tickets.length, b.tickets.length); i++) {
    if (a.tickets[i].key === b.tickets[i].key) identical++;
  }
  assert.ok(identical < a.tickets.length, "different seeds shouldn't produce identical tickets");
});

test("pinned numbers (胆码) appear in every ticket", () => {
  const { freqR, freqB, totalDraws } = uniformFreqs(N);
  const includeRed = [3, 17, 25];
  for (const method of ["bayes-dpp", "thompson", "mcmc"]) {
    const { tickets } = generateAdvanced({
      freqR, freqB, totalDraws, method,
      count: 4, includeRed, seed: `pinned-${method}`,
      mcmcIterations: 800, mcmcBurnIn: 100, mcmcThin: 2, mcmcChains: 2,
    });
    for (const t of tickets) {
      for (const p of includeRed) assert.ok(t.reds.includes(p), `${method}: pinned ${p} missing in ${t.reds}`);
    }
  }
});

test("excluded numbers never appear", () => {
  const { freqR, freqB, totalDraws } = uniformFreqs(N);
  const excludeRed = [1, 2, 3, 4, 5];
  const excludeBlue = [16];
  const { tickets } = generateAdvanced({
    freqR, freqB, totalDraws, method: "bayes-dpp",
    count: 5, excludeRed, excludeBlue, seed: "excl",
  });
  for (const t of tickets) {
    for (const r of t.reds) assert.ok(!excludeRed.includes(r));
    assert.notEqual(t.blue, 16);
  }
});

test("Bayes-DPP produces more diverse tickets than Thompson on average", () => {
  const { freqR, freqB, totalDraws } = uniformFreqs(N);
  const dpp = generateAdvanced({ freqR, freqB, totalDraws, method: "bayes-dpp", count: 10, seed: "div-dpp" });
  const ts = generateAdvanced({ freqR, freqB, totalDraws, method: "thompson", count: 10, seed: "div-ts" });

  // 计算多注之间的平均成对重叠
  const avgPairOverlap = (tickets) => {
    let total = 0, count = 0;
    for (let i = 0; i < tickets.length; i++) {
      for (let j = i + 1; j < tickets.length; j++) {
        const overlap = tickets[i].reds.filter((n) => tickets[j].reds.includes(n)).length;
        total += overlap;
        count++;
      }
    }
    return count === 0 ? 0 : total / count;
  };
  const oDpp = avgPairOverlap(dpp.tickets);
  const oTs = avgPairOverlap(ts.tickets);
  // DPP 应该有更低或相当的重叠（多样性更好）
  assert.ok(oDpp <= oTs + 0.5, `dpp overlap ${oDpp} should be ≤ thompson ${oTs}`);
});

test("quality score is in [0, 100] for all methods", () => {
  const { freqR, freqB, totalDraws } = uniformFreqs(N);
  for (const method of ["bayes-dpp", "thompson", "mcmc"]) {
    const { diagnostics } = generateAdvanced({
      freqR, freqB, totalDraws, method,
      count: 5, seed: `score-${method}`,
      mcmcIterations: 800, mcmcBurnIn: 100, mcmcThin: 2, mcmcChains: 2,
    });
    assert.ok(diagnostics.qualityScore >= 0, `${method} score=${diagnostics.qualityScore}`);
    assert.ok(diagnostics.qualityScore <= 100, `${method} score=${diagnostics.qualityScore}`);
  }
});

test("constraint enforcement: sum constraint reduces invalid output", () => {
  const { freqR, freqB, totalDraws } = uniformFreqs(N);
  const { tickets } = generateAdvanced({
    freqR, freqB, totalDraws, method: "bayes-dpp",
    count: 8, constraints: { sum: true }, seed: "cstr",
  });
  for (const t of tickets) {
    const s = t.reds.reduce((a, b) => a + b, 0);
    assert.ok(s >= 70 && s <= 150, `sum ${s} out of range`);
  }
});
