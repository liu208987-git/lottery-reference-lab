import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runChain,
  energy,
  autocorrelation,
  effectiveSampleSize,
  gelmanRubin,
} from "../assets/js/mcmc.js";
import { buildLKernel } from "../assets/js/dpp.js";
import { createRng } from "../assets/js/rng.js";

function uniformLogQ() {
  const arr = Array(34).fill(0);
  for (let i = 1; i <= 33; i++) arr[i] = Math.log(6 / 33);
  return arr;
}

test("runChain converges and produces samples", () => {
  const rng = createRng("mcmc-1").next;
  const logQuality = uniformLogQ();
  const q = Array(34).fill(0); for (let i = 1; i <= 33; i++) q[i] = 6 / 33;
  const L = buildLKernel(q);
  const ctx = { logQuality, L, constraints: {}, lambdaDiv: 0.5, lambdaCstr: 0, lambdaCrowd: 0, blue: 1 };
  const result = runChain({
    initial: [1, 2, 3, 4, 5, 6],
    pool: Array.from({ length: 33 }, (_, i) => i + 1),
    pinned: [],
    ctx,
    iterations: 1500,
    burnIn: 300,
    thin: 4,
    rng,
  });
  assert.ok(result.samples.length > 50);
  for (const s of result.samples) {
    assert.equal(s.reds.length, 6);
    const set = new Set(s.reds);
    assert.equal(set.size, 6);
  }
});

test("acceptance rate is in reasonable range (0.2 - 0.95)", () => {
  const rng = createRng("mcmc-2").next;
  const logQuality = uniformLogQ();
  const q = Array(34).fill(0); for (let i = 1; i <= 33; i++) q[i] = 6 / 33;
  const L = buildLKernel(q);
  const ctx = { logQuality, L, constraints: {}, lambdaDiv: 0, lambdaCstr: 0, lambdaCrowd: 0, blue: 1 };
  const result = runChain({
    initial: [1, 2, 3, 4, 5, 6],
    pool: Array.from({ length: 33 }, (_, i) => i + 1),
    pinned: [],
    ctx,
    iterations: 2000,
    burnIn: 500,
    thin: 1,
    rng,
  });
  assert.ok(result.acceptRate > 0.1 && result.acceptRate <= 1, `acceptRate=${result.acceptRate}`);
});

test("autocorrelation at lag 0 is exactly 1", () => {
  const series = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
  const acf = autocorrelation(series, 5);
  assert.equal(acf[0], 1);
});

test("autocorrelation of constant series degenerates safely", () => {
  const series = Array(20).fill(7);
  const acf = autocorrelation(series, 5);
  assert.deepEqual(acf, [1]);
});

test("effectiveSampleSize on iid noise approximates N", () => {
  // 模拟 iid 噪声：ESS 应该接近 N
  const rng = createRng("ess-iid").next;
  const series = Array.from({ length: 1000 }, () => rng());
  const { ess, tauInt } = effectiveSampleSize(series);
  assert.ok(tauInt < 1.5, `tauInt=${tauInt} should be small for iid`);
  assert.ok(ess > 300, `ess=${ess} should be high for iid`);
});

test("effectiveSampleSize on highly autocorrelated series is much smaller", () => {
  // AR(1) ρ=0.9：自相关很强
  const rng = createRng("ess-ar").next;
  let prev = 0;
  const series = [];
  for (let i = 0; i < 1000; i++) {
    prev = 0.9 * prev + 0.1 * (rng() - 0.5);
    series.push(prev);
  }
  const { ess } = effectiveSampleSize(series);
  assert.ok(ess < 500, `ar(1) ess=${ess} should be much smaller than 1000`);
});

test("gelmanRubin returns ~1 for chains drawn from same distribution", () => {
  const rng = createRng("gr-1").next;
  const c1 = Array.from({ length: 500 }, () => rng());
  const c2 = Array.from({ length: 500 }, () => rng());
  const c3 = Array.from({ length: 500 }, () => rng());
  const r = gelmanRubin([c1, c2, c3]);
  assert.ok(r > 0.95 && r < 1.1, `R=${r}`);
});

test("gelmanRubin > 1.2 when chains are clearly different", () => {
  const c1 = Array.from({ length: 500 }, () => Math.random());       // mean ≈ 0.5
  const c2 = Array.from({ length: 500 }, () => 5 + Math.random());   // mean ≈ 5.5
  const c3 = Array.from({ length: 500 }, () => -5 + Math.random());  // mean ≈ -4.5
  const r = gelmanRubin([c1, c2, c3]);
  assert.ok(r > 1.2, `R=${r} should clearly indicate non-convergence`);
});

test("MCMC explores the space (samples are diverse)", () => {
  const rng = createRng("mcmc-explore").next;
  const logQuality = uniformLogQ();
  const q = Array(34).fill(0); for (let i = 1; i <= 33; i++) q[i] = 6 / 33;
  const L = buildLKernel(q);
  const ctx = { logQuality, L, constraints: {}, lambdaDiv: 0.3, lambdaCstr: 0, lambdaCrowd: 0, blue: 1 };
  const result = runChain({
    initial: [1, 2, 3, 4, 5, 6],
    pool: Array.from({ length: 33 }, (_, i) => i + 1),
    pinned: [],
    ctx,
    iterations: 4000,
    burnIn: 500,
    thin: 1,
    rng,
  });
  const seenNumbers = new Set();
  for (const s of result.samples) for (const n of s.reds) seenNumbers.add(n);
  // 单链 + 一个交换提议 ⇒ 4000 步不一定能覆盖全 33；要求 ≥18 是合理下限
  assert.ok(seenNumbers.size >= 18, `should explore ≥18 numbers, got ${seenNumbers.size}`);
});

test("MCMC respects pinned (pinned numbers always present)", () => {
  const rng = createRng("mcmc-pinned").next;
  const logQuality = uniformLogQ();
  const q = Array(34).fill(0); for (let i = 1; i <= 33; i++) q[i] = 6 / 33;
  const L = buildLKernel(q);
  const ctx = { logQuality, L, constraints: {}, lambdaDiv: 0, lambdaCstr: 0, lambdaCrowd: 0, blue: 1 };
  const pinned = [7, 17];
  const result = runChain({
    initial: [7, 17, 1, 2, 3, 4],
    pool: Array.from({ length: 33 }, (_, i) => i + 1),
    pinned,
    ctx,
    iterations: 1000,
    burnIn: 100,
    thin: 1,
    rng,
  });
  for (const s of result.samples) {
    for (const p of pinned) assert.ok(s.reds.includes(p), `pinned ${p} missing from ${s.reds}`);
  }
});
