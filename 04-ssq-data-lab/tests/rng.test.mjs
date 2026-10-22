import { test } from "node:test";
import assert from "node:assert/strict";

import {
  xmur3,
  mulberry32,
  createRng,
  makeGaussian,
  makeGammaSampler,
  makeBetaSampler,
} from "../assets/js/rng.js";

test("createRng returns deterministic stream for same seed", () => {
  const a = createRng("hello");
  const b = createRng("hello");
  for (let i = 0; i < 100; i++) {
    assert.equal(a.next(), b.next());
  }
});

test("createRng with different seeds produces different streams", () => {
  const a = createRng("seed1");
  const b = createRng("seed2");
  let same = 0;
  for (let i = 0; i < 50; i++) if (a.next() === b.next()) same++;
  assert.ok(same < 5, `expected mostly different values, got ${same}/50 same`);
});

test("mulberry32 outputs in [0,1)", () => {
  const r = mulberry32(42);
  for (let i = 0; i < 10000; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1);
  }
});

test("Gaussian sampler approximates N(0,1) (mean ≈ 0, var ≈ 1)", () => {
  const rng = createRng("g-test").next;
  const gauss = makeGaussian(rng);
  const N = 20000;
  const samples = Array.from({ length: N }, () => gauss());
  const mean = samples.reduce((a, b) => a + b, 0) / N;
  const variance = samples.reduce((a, x) => a + (x - mean) ** 2, 0) / N;
  assert.ok(Math.abs(mean) < 0.05, `mean=${mean}`);
  assert.ok(Math.abs(variance - 1) < 0.06, `var=${variance}`);
});

test("Gamma(shape=3) has mean ≈ 3 and variance ≈ 3", () => {
  const rng = createRng("gamma-test").next;
  const gamma = makeGammaSampler(rng);
  const N = 15000;
  const samples = Array.from({ length: N }, () => gamma(3));
  const mean = samples.reduce((a, b) => a + b, 0) / N;
  const variance = samples.reduce((a, x) => a + (x - mean) ** 2, 0) / N;
  assert.ok(Math.abs(mean - 3) < 0.1, `mean=${mean}`);
  assert.ok(Math.abs(variance - 3) < 0.3, `var=${variance}`);
});

test("Beta(2,5) has mean ≈ 2/7 ≈ 0.286", () => {
  const rng = createRng("beta-test").next;
  const beta = makeBetaSampler(rng);
  const N = 15000;
  const samples = Array.from({ length: N }, () => beta(2, 5));
  const mean = samples.reduce((a, b) => a + b, 0) / N;
  for (const s of samples) assert.ok(s >= 0 && s <= 1);
  assert.ok(Math.abs(mean - 2 / 7) < 0.015, `mean=${mean}`);
});
