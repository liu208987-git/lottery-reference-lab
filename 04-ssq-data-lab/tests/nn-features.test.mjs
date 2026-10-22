import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ssqRedFeatures, dltFrontFeatures,
  FEATURE_AUG_DIM, appendFeatures,
} from "../assets/js/nn-features.js";

test("ssqRedFeatures 返回 14 维向量", () => {
  const f = ssqRedFeatures([1, 5, 10, 20, 25, 33], []);
  assert.equal(f.length, 14);
  for (const v of f) assert.ok(Number.isFinite(v));
});

test("ssqRedFeatures: sum 归一化", () => {
  const f = ssqRedFeatures([1, 2, 3, 4, 5, 6], []); // sum=21
  assert.ok(Math.abs(f[0] - 0.21) < 1e-6);
});

test("ssqRedFeatures: 全奇时 oddRatio = 1", () => {
  const f = ssqRedFeatures([1, 3, 5, 7, 9, 11], []);
  assert.equal(f[2], 1);
});

test("ssqRedFeatures: 三区比 sum 等于 1", () => {
  const f = ssqRedFeatures([1, 5, 12, 18, 24, 30], []);
  assert.ok(Math.abs(f[5] + f[6] + f[7] - 1) < 1e-6);
});

test("ssqRedFeatures: AC=0（等差）→ feature[8]=0", () => {
  // 1,2,3,4,5,6 是连续整数，diff set = {1,2,3,4,5}, size=5, AC=5-5=0
  const f = ssqRedFeatures([1, 2, 3, 4, 5, 6], []);
  assert.equal(f[8], 0);
});

test("ssqRedFeatures 历史相关：完整 30 期历史下 missMax > 0", () => {
  const history = [];
  for (let i = 0; i < 50; i++) {
    history.push({ reds: [(i % 33) + 1, ((i + 5) % 33) + 1, ((i + 10) % 33) + 1, ((i + 15) % 33) + 1, ((i + 20) % 33) + 1, ((i + 25) % 33) + 1] });
  }
  const f = ssqRedFeatures([1, 2, 3, 4, 5, 6], history);
  assert.ok(f[10] >= 0 && f[10] <= 1);
  assert.ok(f[11] >= 0 && f[11] <= 1);
  assert.ok(f[12] >= 0 && f[12] <= 1, `entropy ${f[12]} out of [0,1]`);
});

test("dltFrontFeatures 返回 14 维向量", () => {
  const f = dltFrontFeatures([2, 8, 15, 22, 30], []);
  assert.equal(f.length, 14);
});

test("dltFrontFeatures pick=5 → oddRatio 分母 5", () => {
  const f = dltFrontFeatures([1, 3, 5, 7, 9], []); // 5 奇
  assert.equal(f[2], 1);
});

test("appendFeatures: 拼接成 baseDim + 14 长度", () => {
  const base = new Float32Array(49);
  base[0] = 1;
  base[10] = 1;
  const features = [0.5, 0.6, 0.4, 0.5, 0.3, 0.4, 0.4, 0.2, 0.5, 0.2, 0.5, 0.1, 0.8, 0.7];
  const out = appendFeatures(base, features, 49);
  assert.equal(out.length, 49 + 14);
  assert.equal(out[0], 1);
  assert.equal(out[10], 1);
  for (let i = 0; i < 14; i++) {
    assert.ok(Math.abs(out[49 + i] - features[i]) < 1e-5, `out[${49 + i}] = ${out[49 + i]} expected ${features[i]}`);
  }
});

test("FEATURE_AUG_DIM === 14", () => {
  assert.equal(FEATURE_AUG_DIM, 14);
});
