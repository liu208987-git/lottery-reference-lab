// model-compare.js 单元测试：用真实 SSQ 数据训两个不同 seed 的小 LSTM，
// 构造 payload → 调用 renderComparison → 验证输出 HTML 包含关键标识。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createModel, serializeModel } from "../assets/js/nn-ssq-model.js";
import { trainModel, buildSamples } from "../assets/js/nn-trainer.js";
import { createRng } from "../assets/js/rng.js";
import { renderComparison } from "../assets/js/model-compare.js";

// 加载 SSQ 数据
const raw = JSON.parse(fs.readFileSync("data/draws.json", "utf8"));
const draws = raw.draws.slice(-200);  // 200 期足够小模型
const seqLen = 10;
const samples = buildSamples(draws, seqLen);
const splitIdx = Math.floor(samples.length * 0.85);
const trainSamples = samples.slice(0, splitIdx);
const valSamples = samples.slice(splitIdx);

async function trainSmall(seedStr) {
  const rng = createRng(seedStr).next;
  const model = createModel({ hiddenDim: 12, numLayers: 1, rng });
  const result = await trainModel(model, trainSamples, valSamples, {
    epochs: 2, batchSize: 32, lr: 5e-3,
    gradClip: 5, patience: 3, weightDecay: 1e-5,
    labelSmoothing: 0.05, rng,
  });
  return { model, history: result.history };
}

test("renderComparison: SSQ 单模型 vs 单模型 输出包含 BSS/VS/置换 关键字", async () => {
  const a = await trainSmall("seed-a-2026");
  const b = await trainSmall("seed-b-2026");

  const payloadA = {
    type: "single",
    lottery: "ssq",
    key: "test-A",
    model: serializeModel(a.model),
    history: a.history,
    seqLen,
    hiddenDim: 12,
    numLayers: 1,
    savedAt: "2026-05-23T10:00:00.000Z",
  };
  const payloadB = {
    type: "single",
    lottery: "ssq",
    key: "test-B",
    model: serializeModel(b.model),
    history: b.history,
    seqLen,
    hiddenDim: 12,
    numLayers: 1,
    savedAt: "2026-05-23T11:00:00.000Z",
  };

  const html = await renderComparison(payloadA, payloadB, draws, "ssq");

  assert.ok(typeof html === "string", "返回应是 string");
  assert.ok(html.length > 1000, "HTML 至少 1KB");
  assert.ok(html.includes("VS"), "应含 'VS' 大字");
  assert.ok(html.includes("test-A"), "应含 A key");
  assert.ok(html.includes("test-B"), "应含 B key");
  assert.ok(html.includes("BSS") || html.includes("Brier Skill"), "应含 BSS");
  assert.ok(html.includes("置换") || html.includes("permut"), "应含置换检验");
  assert.ok(html.includes("svg"), "应含 SVG 曲线");
  assert.ok(html.includes("hit@6") || html.includes("Hit@6"), "应含 hit@6");
});

test("renderComparison: 跨彩种 payload 应返回报错块", async () => {
  const payloadA = { type: "single", lottery: "ssq", key: "a", model: {}, seqLen };
  const payloadB = { type: "single", lottery: "dlt", key: "b", model: {}, seqLen };

  const html = await renderComparison(payloadA, payloadB, draws, "ssq");
  assert.ok(html.includes("无法对比") || html.includes("不同彩种"));
});

test("renderComparison: 数据不足应返回提示", async () => {
  const tinyDraws = draws.slice(0, 10);
  const payloadA = { type: "single", lottery: "ssq", key: "a", model: {}, seqLen };
  const payloadB = { type: "single", lottery: "ssq", key: "b", model: {}, seqLen };

  const html = await renderComparison(payloadA, payloadB, tinyDraws, "ssq");
  assert.ok(html.includes("数据不足"));
});
