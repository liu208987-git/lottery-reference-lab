import { test } from "node:test";
import assert from "node:assert/strict";

import {
  encodeDraw, encodeTarget,
  createModel, forwardModel, lossAndGrads,
  flattenParams, flattenGrads,
  topKRed, argMaxBlue,
  RED_DIM, BLUE_DIM, FEATURE_DIM,
  serializeModel, deserializeModel,
} from "../assets/js/nn-ssq-model.js";
import { createRng } from "../assets/js/rng.js";
import { trainModel, buildSamples, evaluate } from "../assets/js/nn-trainer.js";

const draw1 = { issue: "1", reds: [3, 7, 11, 18, 22, 30], blue: 5 };

test("encodeDraw produces 49-dim vector with 7 ones", () => {
  const v = encodeDraw(draw1);
  assert.equal(v.rows, FEATURE_DIM);
  let ones = 0;
  for (let i = 0; i < FEATURE_DIM; i++) if (v.data[i] === 1) ones++;
  assert.equal(ones, 7); // 6 红 + 1 蓝
  for (const r of draw1.reds) assert.equal(v.data[r - 1], 1);
  assert.equal(v.data[RED_DIM + draw1.blue - 1], 1);
});

test("encodeTarget separates red multi-hot and blue one-hot", () => {
  const t = encodeTarget(draw1);
  assert.equal(t.red.rows, 33);
  assert.equal(t.blue.rows, 16);
  let redOnes = 0;
  for (let i = 0; i < 33; i++) if (t.red.data[i] === 1) redOnes++;
  assert.equal(redOnes, 6);
  let blueOnes = 0;
  for (let i = 0; i < 16; i++) if (t.blue.data[i] === 1) blueOnes++;
  assert.equal(blueOnes, 1);
});

test("forwardModel produces valid red probs in (0,1) and blue probs sum to 1", () => {
  const rng = createRng("model-fwd").next;
  const model = createModel({ hiddenDim: 16, rng });
  const seq = [encodeDraw(draw1), encodeDraw(draw1)];
  const fwd = forwardModel(model, seq);
  for (let i = 0; i < RED_DIM; i++) {
    assert.ok(fwd.redProbs.data[i] > 0 && fwd.redProbs.data[i] < 1);
  }
  let sum = 0;
  for (let i = 0; i < BLUE_DIM; i++) sum += fwd.blueProbs.data[i];
  assert.ok(Math.abs(sum - 1) < 1e-5);
});

test("topKRed returns K numbers sorted by probability desc", () => {
  const rng = createRng("topk").next;
  const model = createModel({ hiddenDim: 8, rng });
  const seq = [encodeDraw(draw1)];
  const fwd = forwardModel(model, seq);
  const top = topKRed(fwd.redProbs, 6);
  assert.equal(top.length, 6);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1][1] >= top[i][1]);
});

test("argMaxBlue returns the highest-probability blue", () => {
  const rng = createRng("argmax").next;
  const model = createModel({ hiddenDim: 8, rng });
  const seq = [encodeDraw(draw1)];
  const fwd = forwardModel(model, seq);
  const result = argMaxBlue(fwd.blueProbs);
  let maxP = 0, maxI = 1;
  for (let i = 0; i < BLUE_DIM; i++) if (fwd.blueProbs.data[i] > maxP) { maxP = fwd.blueProbs.data[i]; maxI = i + 1; }
  assert.equal(result.num, maxI);
});

test("lossAndGrads produces non-negative loss and well-shaped gradients", () => {
  const rng = createRng("loss").next;
  const model = createModel({ hiddenDim: 8, rng });
  const seq = [encodeDraw(draw1), encodeDraw(draw1)];
  const target = encodeTarget(draw1);
  const out = lossAndGrads(model, seq, target);
  assert.ok(out.loss > 0);
  assert.ok(out.redLoss >= 0);
  assert.ok(out.blueLoss >= 0);
  // 形状（多层 stack 的第 0 层）
  assert.equal(out.grads.stack[0].dW.rows, 4 * 8);
  assert.equal(out.grads.stack[0].dW.cols, FEATURE_DIM);
  assert.equal(out.grads.redHead.dW.rows, RED_DIM);
  assert.equal(out.grads.redHead.dW.cols, 8);
});

test("model serialization round-trips", () => {
  const rng = createRng("ser").next;
  const model = createModel({ hiddenDim: 4, rng });
  const ser = serializeModel(model);
  const restored = deserializeModel(JSON.parse(JSON.stringify(ser)));
  // 比较参数
  for (let i = 0; i < model.stack.layers[0].params.W.data.length; i++) {
    assert.equal(restored.stack.layers[0].params.W.data[i], model.stack.layers[0].params.W.data[i]);
  }
  for (let i = 0; i < model.redHead.W.data.length; i++) {
    assert.equal(restored.redHead.W.data[i], model.redHead.W.data[i]);
  }
});

test("buildSamples slides a fixed-length window", () => {
  const draws = Array.from({ length: 20 }, (_, i) => ({
    issue: String(i + 1),
    reds: [1 + (i % 33), 2 + (i % 31), 3 + (i % 29), 4 + (i % 27), 5 + (i % 25), 6 + (i % 23)].map((n) => Math.min(33, n)),
    blue: 1 + (i % 16),
  }));
  const samples = buildSamples(draws, 5);
  assert.equal(samples.length, 15); // 20 - 5
  for (const s of samples) assert.equal(s.sequence.length, 5);
});

test("training reduces training loss over a small overfit set", { timeout: 60000 }, async () => {
  // 给模型 8 个固定样本，看 5 个 epoch 后训练 loss 是否下降
  const rng = createRng("train").next;
  const draws = [];
  for (let i = 0; i < 30; i++) {
    draws.push({ issue: String(i), reds: [1, 2, 3, 4, 5, 6], blue: 1 });
  }
  const samples = buildSamples(draws, 5);
  const train = samples.slice(0, 20);
  const val = samples.slice(20);
  const model = createModel({ hiddenDim: 8, rng });
  const before = evaluate(model, train);
  await trainModel(model, train, val, {
    epochs: 8, batchSize: 4, lr: 0.01, patience: 100,
  });
  const after = evaluate(model, train);
  assert.ok(after.avgLoss < before.avgLoss * 0.95,
    `loss should drop, before=${before.avgLoss} after=${after.avgLoss}`);
});

test("evaluate returns reasonable defaults on a fresh model", () => {
  const rng = createRng("eval").next;
  const model = createModel({ hiddenDim: 8, rng });
  const draws = [];
  for (let i = 0; i < 20; i++) {
    draws.push({ issue: String(i), reds: [1, 2, 3, 4, 5, 6], blue: 1 });
  }
  const samples = buildSamples(draws, 5);
  const stats = evaluate(model, samples);
  assert.ok(stats.avgLoss > 0);
  assert.ok(stats.avgRedHit6 >= 0 && stats.avgRedHit6 <= 6);
  assert.ok(stats.blueAccuracy >= 0 && stats.blueAccuracy <= 1);
});
