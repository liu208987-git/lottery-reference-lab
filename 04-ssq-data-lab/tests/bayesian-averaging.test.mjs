import { test } from "node:test";
import assert from "node:assert/strict";
import { bmaWeights, bmaCombine, bmaFromHistories, selectOptimalBeta } from "../assets/js/bayesian-averaging.js";

test("bmaWeights: K=1 时返回 [1]", () => {
  const w = bmaWeights([0.5]);
  assert.equal(w.length, 1);
  assert.equal(w[0], 1);
});

test("bmaWeights: 相同 NLL 给均匀权重", () => {
  const w = bmaWeights([0.5, 0.5, 0.5]);
  for (const v of w) assert.ok(Math.abs(v - 1 / 3) < 1e-9);
});

test("bmaWeights: 较低 NLL 模型获得更高权重（β>0）", () => {
  const w = bmaWeights([0.4, 0.6, 0.8], 5);
  assert.ok(w[0] > w[1] && w[1] > w[2]);
  const sum = w[0] + w[1] + w[2];
  assert.ok(Math.abs(sum - 1) < 1e-6);
});

test("bmaWeights: β=0 退化为均匀权重", () => {
  const w = bmaWeights([0.4, 0.6, 0.8], 0);
  for (const v of w) assert.ok(Math.abs(v - 1 / 3) < 1e-9);
});

test("bmaCombine: K 个相同 prob 平均还是它", () => {
  const probs = [
    new Float32Array([0.1, 0.5, 0.4]),
    new Float32Array([0.1, 0.5, 0.4]),
  ];
  const w = new Float64Array([0.5, 0.5]);
  const r = bmaCombine(probs, w);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(r.mean[i] - probs[0][i]) < 1e-6);
  for (let i = 0; i < 3; i++) assert.ok(r.std[i] < 1e-6);
});

test("bmaCombine: 不同 probs 的 std > 0", () => {
  const probs = [
    new Float32Array([0.1, 0.5, 0.4]),
    new Float32Array([0.4, 0.4, 0.2]),
  ];
  const w = new Float64Array([0.5, 0.5]);
  const r = bmaCombine(probs, w);
  for (let i = 0; i < 3; i++) assert.ok(r.std[i] > 0);
});

test("bmaFromHistories: 取每模型最佳 valLoss", () => {
  const histories = [
    { valLoss: [0.8, 0.6, 0.5, 0.55] },  // best 0.5
    { valLoss: [0.7, 0.65, 0.7] },       // best 0.65
  ];
  const r = bmaFromHistories(histories, 1);
  assert.deepEqual(r.valNLLs, [0.5, 0.65]);
  // 第一个模型权重更大
  assert.ok(r.weights[0] > r.weights[1]);
});

test("selectOptimalBeta: 返回 0-5 范围的 β", () => {
  // K=2 模型，N=10 个 val 样本，dim=4
  const valNLLs = [0.5, 0.6];
  const valProbsList = [
    Array.from({ length: 10 }, () => new Float32Array([0.1, 0.4, 0.3, 0.2])),
    Array.from({ length: 10 }, () => new Float32Array([0.2, 0.3, 0.4, 0.1])),
  ];
  const valTargets = Array.from({ length: 10 }, () => [2]);  // 真号永远是 2
  const r = selectOptimalBeta(valNLLs, valProbsList, valTargets);
  assert.ok(r.betaOptimal >= 0 && r.betaOptimal <= 5);
  assert.equal(r.weightsAtOptimal.length, 2);
  assert.ok(typeof r.nllAtOptimal === "number");
});
