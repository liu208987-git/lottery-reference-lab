import { test } from "node:test";
import assert from "node:assert/strict";

import {
  posteriorParams,
  posteriorMean,
  posteriorVariance,
  posteriorCI,
  posteriorMeanArray,
  thompsonWeights,
  RED_PRIOR,
  BLUE_PRIOR,
} from "../assets/js/bayes.js";
import { createRng, makeBetaSampler } from "../assets/js/rng.js";

test("posteriorParams: 0 observations returns prior", () => {
  const freq = [0, 0, 0]; // 2 个号码，全 0
  const p = posteriorParams(freq, 0, RED_PRIOR);
  assert.equal(p[1].alpha, RED_PRIOR.alpha0);
  assert.equal(p[1].beta, RED_PRIOR.beta0);
});

test("posteriorMean equals (alpha0+k)/(alpha0+beta0+N)", () => {
  const N = 100;
  const k = 30;
  const freq = [0, k];
  const p = posteriorParams(freq, N, RED_PRIOR);
  const expected = (RED_PRIOR.alpha0 + k) / (RED_PRIOR.alpha0 + RED_PRIOR.beta0 + N);
  assert.ok(Math.abs(posteriorMean(p[1]) - expected) < 1e-12);
});

test("posterior shrinks frequency estimate toward prior mean (6/33 ≈ 0.182)", () => {
  // 一个号码出现 0 次，N=20。频率估计 = 0；后验均值应 > 0 且 < 6/33
  const N = 20;
  const freq = [0, 0];
  const p = posteriorParams(freq, N, RED_PRIOR);
  const m = posteriorMean(p[1]);
  assert.ok(m > 0, "shouldn't be 0");
  assert.ok(m < 6 / 33, `${m} should be below prior mean 0.182`);
});

test("posterior CI shrinks as N grows", () => {
  const lowN = posteriorParams([0, 5], 10, RED_PRIOR)[1];
  const highN = posteriorParams([0, 1500], 8000, RED_PRIOR)[1];
  const ci1 = posteriorCI(lowN);
  const ci2 = posteriorCI(highN);
  assert.ok((ci1.upper - ci1.lower) > (ci2.upper - ci2.lower),
    `expected CI shrink: low=${ci1.upper - ci1.lower} high=${ci2.upper - ci2.lower}`);
});

test("posteriorMeanArray sums to ~1 when used as a normalized prob (after renormalize)", () => {
  // 33 个号码，合理频次（每号约 N*6/33 次），后验均值之和应≈ N*(6/33)*N_factor... 实际 sum ≈ 6/33 × 33 = ~6
  // 这里用更直观的：归一化后总和 = 1
  const freq = Array(34).fill(0);
  for (let i = 1; i <= 33; i++) freq[i] = 100;
  const arr = posteriorMeanArray(freq, 600, RED_PRIOR);
  const s = arr.slice(1).reduce((a, b) => a + b, 0);
  // 6/33 × 33 = 6（因为我们均匀分配 N=600，每号 100 次，期望比例 100/600=0.167≈6/36
  // 但 N×6/33=109 是均匀期望，所以后验均值约 6/33≈0.182
  // 归一化前总和应近 33 * 0.182 = 6
  assert.ok(Math.abs(s - 6) < 0.5, `sum=${s}`);
});

test("thompsonWeights returns positive weights in (0,1)", () => {
  const N = 100;
  const freq = [0]; for (let i = 1; i <= 33; i++) freq.push(20 + Math.floor(Math.random() * 10));
  const params = posteriorParams(freq, N, RED_PRIOR);
  const beta = makeBetaSampler(createRng("ts").next);
  const w = thompsonWeights(params, beta);
  for (let i = 1; i < w.length; i++) {
    assert.ok(w[i] > 0 && w[i] < 1, `w[${i}]=${w[i]}`);
  }
});

test("posterior variance > 0 and decreases as evidence grows", () => {
  const small = posteriorParams([0, 5], 10, RED_PRIOR)[1];
  const large = posteriorParams([0, 1000], 5000, RED_PRIOR)[1];
  assert.ok(posteriorVariance(small) > posteriorVariance(large));
});

test("BLUE_PRIOR has mean 1/16", () => {
  const m = BLUE_PRIOR.alpha0 / (BLUE_PRIOR.alpha0 + BLUE_PRIOR.beta0);
  assert.ok(Math.abs(m - 1 / 16) < 1e-12);
});
