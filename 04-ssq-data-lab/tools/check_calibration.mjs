// 端到端真实数据验证 calibration：
// 1. 训练一个小 SSQ LSTM
// 2. 看是否自动 fit 出非 1 的 T，ECE 是否改善

import fs from "node:fs";
import { createModel, forwardModel } from "../assets/js/nn-ssq-model.js";
import { trainModel, buildSamples } from "../assets/js/nn-trainer.js";
import { createRng } from "../assets/js/rng.js";

const data = JSON.parse(fs.readFileSync("data/draws.json"));
const draws = data.draws.slice(-300);

const rng = createRng("calib-audit").next;
const samples = buildSamples(draws, 12);
const split = Math.floor(samples.length * 0.85);
const train = samples.slice(0, split);
const val = samples.slice(split);

console.log(`samples: ${samples.length}, train: ${train.length}, val: ${val.length}`);

const model = createModel({ hiddenDim: 24, numLayers: 1, dropoutInput: 0.1, dropoutHidden: 0.2, dropoutOutput: 0.2, rng });

const t0 = Date.now();
const result = await trainModel(model, train, val, {
  epochs: 4,
  batchSize: 16,
  lr: 5e-3,
  gradClip: 5,
  patience: 5,
  weightDecay: 1e-5,
  labelSmoothing: 0.05,    // 关键：开了 LS
  rng,
});
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log(`\n=== Calibration ===`);
const cal = result.calibration;
if (!cal) {
  console.log("calibration: NULL");
  process.exit(1);
}
console.log(`red T = ${cal.redT?.toFixed(4)}`);
console.log(`blue T = ${cal.blueT?.toFixed(4)}`);
console.log(`red ECE: ${cal.redECE.before.toFixed(4)} → ${cal.redECE.after.toFixed(4)}`);
console.log(`blue ECE: ${cal.blueECE.before.toFixed(4)} → ${cal.blueECE.after.toFixed(4)}`);
console.log(`red NLL: ${cal.redNLL.before.toFixed(4)} → ${cal.redNLL.after.toFixed(4)}`);
console.log(`blue NLL: ${cal.blueNLL.before.toFixed(4)} → ${cal.blueNLL.after.toFixed(4)}`);

const lastIdx = result.history.epochs.length - 1;
console.log(`\nval loss: ${result.history.valLoss[lastIdx].toFixed(4)}`);
console.log(`val red hit@6: ${result.history.valRedHit6[lastIdx].toFixed(3)} (baseline 1.091)`);
console.log(`val blue acc: ${(result.history.valBlueAcc[lastIdx] * 100).toFixed(2)}% (baseline 6.25%)`);

// 验证：infer with calibration vs without
console.log(`\n=== Inference 对比 ===`);
const sample = val[0];

const before = forwardModel({ ...model, calibration: null }, sample.sequence, { training: false });
const after = forwardModel(model, sample.sequence, { training: false });

console.log(`未校准 red probs (前 6): ${Array.from(before.redProbs.data.slice(0, 6)).map(p => p.toFixed(3)).join(", ")}`);
console.log(`已校准 red probs (前 6): ${Array.from(after.redProbs.data.slice(0, 6)).map(p => p.toFixed(3)).join(", ")}`);

// 验证：argmax 不变（temperature 是单调）
let aBefore = 0, aAfter = 0;
for (let i = 0; i < 33; i++) {
  if (before.redProbs.data[i] > before.redProbs.data[aBefore]) aBefore = i;
  if (after.redProbs.data[i] > after.redProbs.data[aAfter]) aAfter = i;
}
console.log(`未校准 argmax = ${aBefore + 1}, 已校准 argmax = ${aAfter + 1}, 相同 = ${aBefore === aAfter ? "✓" : "✗"}`);
