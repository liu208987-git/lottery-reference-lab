import { test } from "node:test";
import assert from "node:assert/strict";
import { cosineWithWarmup, stepDecay, makeSchedule } from "../assets/js/nn-schedule.js";

test("cosineWithWarmup: warmup=0 时第 0 step lr ≈ peak", () => {
  const lr = cosineWithWarmup(0, 100, { lrPeak: 1e-3 });
  assert.ok(Math.abs(lr - 1e-3) < 1e-9, `got ${lr}`);
});

test("cosineWithWarmup: 末尾 lr ≈ lrMin", () => {
  const lr = cosineWithWarmup(100, 100, { lrPeak: 1e-3, lrMin: 1e-5 });
  assert.ok(Math.abs(lr - 1e-5) < 1e-7, `got ${lr}`);
});

test("cosineWithWarmup: warmup 期内线性升", () => {
  const lr0 = cosineWithWarmup(0, 100, { lrPeak: 1, warmupSteps: 10 });
  const lr5 = cosineWithWarmup(5, 100, { lrPeak: 1, warmupSteps: 10 });
  const lr9 = cosineWithWarmup(9, 100, { lrPeak: 1, warmupSteps: 10 });
  assert.ok(lr0 < lr5);
  assert.ok(lr5 < lr9);
  assert.ok(Math.abs(lr0 - 0.1) < 1e-9);
  assert.ok(Math.abs(lr5 - 0.6) < 1e-9);
});

test("cosineWithWarmup: 中点 lr 介于 peak 和 min 之间", () => {
  const lr = cosineWithWarmup(50, 100, { lrPeak: 1, lrMin: 0 });
  // 中点 cos(π/2) = 0, 所以 lr = 0.5 * 1 = 0.5
  assert.ok(Math.abs(lr - 0.5) < 1e-9, `got ${lr}`);
});

test("stepDecay: 每 5 epoch 减半", () => {
  assert.equal(stepDecay(0, 1, { stepEpochs: 5, gamma: 0.5 }), 1);
  assert.equal(stepDecay(4, 1, { stepEpochs: 5, gamma: 0.5 }), 1);
  assert.equal(stepDecay(5, 1, { stepEpochs: 5, gamma: 0.5 }), 0.5);
  assert.equal(stepDecay(10, 1, { stepEpochs: 5, gamma: 0.5 }), 0.25);
});

test("makeSchedule cosine 工厂", () => {
  const fn = makeSchedule("cosine", { lrPeak: 1e-3, lrMin: 1e-5, warmupSteps: 10 });
  const lr = fn(50, 100);
  assert.ok(lr > 1e-5 && lr < 1e-3);
});

test("makeSchedule constant 退化", () => {
  const fn = makeSchedule("constant", { lrPeak: 0.005 });
  for (const step of [0, 50, 99]) {
    assert.equal(fn(step, 100), 0.005);
  }
});

test("makeSchedule unknown 退化为 constant", () => {
  const fn = makeSchedule("xxx", { lrPeak: 0.001 });
  assert.equal(fn(0, 100), 0.001);
});
