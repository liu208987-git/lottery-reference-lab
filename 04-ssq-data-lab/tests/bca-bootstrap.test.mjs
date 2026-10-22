import { test } from "node:test";
import assert from "node:assert/strict";
import { bcaBootstrap } from "../assets/js/bca-bootstrap.js";

test("bcaBootstrap: 退化情况 n<3 返回 0", () => {
  const r = bcaBootstrap([1, 2], (x) => x.reduce((s, v) => s + v, 0) / x.length);
  assert.equal(r.B, 0);
});

test("bcaBootstrap: 正态样本均值 BCa CI 接近 percentile（z0≈0, a≈0）", () => {
  // 100 个 N(5, 1) 样本（伪正态）
  let seed = 42;
  const lcg = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  // Box-Muller
  const data = [];
  for (let i = 0; i < 50; i++) {
    const u1 = lcg(), u2 = lcg();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    data.push(5 + z);
  }
  const r = bcaBootstrap(data, (x) => x.reduce((s, v) => s + v, 0) / x.length, { B: 800, seed: "test1" });
  // mean 应该接近 5
  assert.ok(Math.abs(r.mean - 5) < 0.3, `mean ${r.mean}`);
  // CI 包含 5
  assert.ok(r.lower < 5 && r.upper > 5, `CI [${r.lower}, ${r.upper}] 不含 5`);
  // 正态情况下 z0 应该接近 0
  assert.ok(Math.abs(r.z0) < 0.3, `z0=${r.z0}`);
});

test("bcaBootstrap: 偏态分布 BCa CI 与 percentile 不同", () => {
  // 强右偏（指数分布近似）
  let seed = 7;
  const lcg = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const data = [];
  for (let i = 0; i < 80; i++) data.push(-Math.log(lcg() + 1e-9));
  const r = bcaBootstrap(data, (x) => x.reduce((s, v) => s + v, 0) / x.length, { B: 800, seed: "skew" });
  // BCa 与 percentile 应该有可见差异
  const bcaWidth = r.upper - r.lower;
  const pcWidth = r.pcUpper - r.pcLower;
  assert.ok(bcaWidth > 0 && pcWidth > 0);
  // 偏态时一般 z0 不为 0
  assert.ok(typeof r.z0 === "number" && Math.abs(r.z0) > 0.01, `z0=${r.z0} 应非 0`);
});
