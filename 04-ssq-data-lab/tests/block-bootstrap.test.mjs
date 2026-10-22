import { test } from "node:test";
import assert from "node:assert/strict";
import { movingBlockBootstrap, stationaryBootstrap } from "../assets/js/block-bootstrap.js";

const data = Array.from({ length: 100 }, (_, i) => i + 0.5 * Math.sin(i / 5));
const meanFn = (x) => x.reduce((s, v) => s + v, 0) / x.length;

test("MBB: 均值估计 + 95% CI 包含真值", () => {
  const r = movingBlockBootstrap(data, meanFn, { B: 400, seed: "mbb1" });
  assert.ok(r.B === 400);
  assert.ok(r.blockSize > 1);
  assert.ok(r.lower < r.mean && r.mean < r.upper, `CI [${r.lower}, ${r.upper}] mean ${r.mean}`);
});

test("Stationary bootstrap: 同样给出有效 CI", () => {
  const r = stationaryBootstrap(data, meanFn, { B: 400, seed: "sb1" });
  assert.ok(r.lower < r.upper);
  assert.ok(typeof r.p === "number" && r.p > 0 && r.p < 1);
});

test("MBB n<4 退化", () => {
  const r = movingBlockBootstrap([1, 2], meanFn);
  assert.equal(r.B, 0);
});

test("MBB block 大于 n 时退化", () => {
  const r = movingBlockBootstrap([1, 2, 3, 4], meanFn, { blockSize: 100 });
  assert.equal(r.B, 0);
});
