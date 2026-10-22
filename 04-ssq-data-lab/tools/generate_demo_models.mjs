// 生成预训练 demo 模型，写入 data/demo-models/{ssq,dlt}-lstm.json
//
// 这些模型是"功能演示"用的，参数有意做小（H=24, L=1, ε=0.05），
// 训练 4-6 个 epoch 就够了：用户点 demo 按钮立即看到完整功能链路
// （预测 + 概率热度 + reliability + ECE）。
//
// 不构成预测能力。仍然指向同一个理论结论：i.i.d. 上 hit@K = baseline。

import fs from "node:fs";
import path from "node:path";
import { createModel } from "../assets/js/nn-ssq-model.js";
import { trainModel, buildSamples } from "../assets/js/nn-trainer.js";
import { serializeModel } from "../assets/js/nn-ssq-model.js";

import { createDltModel, serializeDltModel } from "../assets/js/dlt-nn-model.js";
import { trainDltModel, buildDltSamples } from "../assets/js/dlt-nn-trainer.js";

import { createRng } from "../assets/js/rng.js";

const OUT_DIR = "data/demo-models";
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log("=== SSQ demo model ===");
{
  const data = JSON.parse(fs.readFileSync("data/draws.json", "utf8"));
  // 用最近 500 期；少点期数训练快，效果也够展示
  const draws = data.draws.slice(-500);
  const seqLen = 12;
  const rng = createRng("demo-ssq").next;
  const samples = buildSamples(draws, seqLen);
  const split = Math.floor(samples.length * 0.85);
  const train = samples.slice(0, split);
  const val = samples.slice(split);
  console.log(`samples: ${samples.length}, train: ${train.length}, val: ${val.length}`);

  const model = createModel({
    hiddenDim: 24, numLayers: 1,
    dropoutInput: 0.1, dropoutHidden: 0.2, dropoutOutput: 0.2,
    rng,
  });
  const t0 = Date.now();
  const result = await trainModel(model, train, val, {
    epochs: 6, batchSize: 16, lr: 5e-3,
    gradClip: 5, patience: 6, weightDecay: 1e-5,
    labelSmoothing: 0.05,
    rng,
  });
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s, best val ${result.bestValLoss.toFixed(4)}`);
  if (result.calibration) {
    console.log(`  red T = ${result.calibration.redT.toFixed(3)}, ECE: ${result.calibration.redECE.before.toFixed(3)} → ${result.calibration.redECE.after.toFixed(3)}`);
    console.log(`  blue T = ${result.calibration.blueT.toFixed(3)}, ECE: ${result.calibration.blueECE.before.toFixed(3)} → ${result.calibration.blueECE.after.toFixed(3)}`);
  }

  const payload = {
    type: "single",
    lottery: "ssq",
    model: serializeModel(model),
    seqLen,
    history: result.history,
    hiddenDim: model.hiddenDim,
    numLayers: model.numLayers,
    savedAt: new Date().toISOString(),
    isDemo: true,
    trainedOnIssues: { from: draws[0].issue, to: draws[draws.length - 1].issue },
  };
  const outPath = path.join(OUT_DIR, "ssq-lstm.json");
  fs.writeFileSync(outPath, JSON.stringify(payload));
  const size = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`written ${outPath} (${size} KB)`);
}

console.log("\n=== DLT demo model ===");
{
  const data = JSON.parse(fs.readFileSync("data/dlt-draws.json", "utf8"));
  const draws = data.draws.slice(-500);
  const seqLen = 12;
  const rng = createRng("demo-dlt").next;
  const samples = buildDltSamples(draws, seqLen);
  const split = Math.floor(samples.length * 0.85);
  const train = samples.slice(0, split);
  const val = samples.slice(split);
  console.log(`samples: ${samples.length}, train: ${train.length}, val: ${val.length}`);

  const model = createDltModel({
    hiddenDim: 24, numLayers: 1,
    dropoutInput: 0.1, dropoutHidden: 0.2, dropoutOutput: 0.2,
    rng,
  });
  const t0 = Date.now();
  const result = await trainDltModel(model, train, val, {
    epochs: 6, batchSize: 16, lr: 5e-3,
    gradClip: 5, patience: 6, weightDecay: 1e-5,
    labelSmoothing: 0.05,
    rng,
  });
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s, best val ${result.bestValLoss.toFixed(4)}`);
  if (result.calibration) {
    console.log(`  front T = ${result.calibration.frontT.toFixed(3)}, ECE: ${result.calibration.frontECE.before.toFixed(3)} → ${result.calibration.frontECE.after.toFixed(3)}`);
    console.log(`  back T = ${result.calibration.backT.toFixed(3)}, ECE: ${result.calibration.backECE.before.toFixed(3)} → ${result.calibration.backECE.after.toFixed(3)}`);
  }

  const payload = {
    type: "single",
    lottery: "dlt",
    model: serializeDltModel(model),
    seqLen,
    history: result.history,
    hiddenDim: model.hiddenDim,
    numLayers: model.numLayers,
    savedAt: new Date().toISOString(),
    isDemo: true,
    trainedOnIssues: { from: draws[0].issue, to: draws[draws.length - 1].issue },
  };
  const outPath = path.join(OUT_DIR, "dlt-lstm.json");
  fs.writeFileSync(outPath, JSON.stringify(payload));
  const size = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`written ${outPath} (${size} KB)`);
}

console.log("\n✓ Demo models generated.");
