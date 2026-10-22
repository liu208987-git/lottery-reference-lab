import { test } from "node:test";
import assert from "node:assert/strict";
import {
  trainDltEnsemble, dltEnsembleForward,
} from "../assets/js/dlt-nn-ensemble.js";
import { encodeDltDraw, FRONT_DIM, BACK_DIM } from "../assets/js/dlt-nn-model.js";
import { buildDltSamples } from "../assets/js/dlt-nn-trainer.js";

const tinyDraws = [];
for (let i = 0; i < 60; i++) {
  const front = [];
  while (front.length < 5) {
    const n = 1 + Math.floor(Math.random() * 35);
    if (!front.includes(n)) front.push(n);
  }
  const back = [];
  while (back.length < 2) {
    const n = 1 + Math.floor(Math.random() * 12);
    if (!back.includes(n)) back.push(n);
  }
  tinyDraws.push({
    issue: String(20000 + i),
    front: front.sort((a, b) => a - b),
    back: back.sort((a, b) => a - b),
  });
}

test("trainDltEnsemble: K=2 produces 2 distinct members", async () => {
  const samples = buildDltSamples(tinyDraws, 6);
  const split = Math.floor(samples.length * 0.8);
  const train = samples.slice(0, split);
  const val = samples.slice(split);

  const result = await trainDltEnsemble(train, val, {
    K: 2,
    modelOpts: { hiddenDim: 8, numLayers: 1, dropoutInput: 0.05, dropoutHidden: 0.1, dropoutOutput: 0.1 },
    trainOpts: { epochs: 2, batchSize: 8, lr: 5e-3, gradClip: 5, patience: 3, weightDecay: 1e-5 },
    seedBase: "dlt-tst",
  });

  assert.equal(result.members.length, 2);
  // 两个成员的 W 应该不同
  const w0 = result.members[0].frontHead.W.data[0];
  const w1 = result.members[1].frontHead.W.data[0];
  assert.ok(Math.abs(w0 - w1) > 1e-6, `members should differ; w0=${w0}, w1=${w1}`);
});

test("dltEnsembleForward: 返回 valid 概率分布 + std >= 0", async () => {
  const samples = buildDltSamples(tinyDraws, 6);
  const split = Math.floor(samples.length * 0.8);
  const train = samples.slice(0, split);
  const val = samples.slice(split);

  const result = await trainDltEnsemble(train, val, {
    K: 2,
    modelOpts: { hiddenDim: 8, numLayers: 1, dropoutInput: 0.05, dropoutHidden: 0.1, dropoutOutput: 0.1 },
    trainOpts: { epochs: 1, batchSize: 8, lr: 5e-3, gradClip: 5, patience: 3, weightDecay: 1e-5 },
    seedBase: "dlt-fwd",
  });

  const seq = tinyDraws.slice(-6).map(d => encodeDltDraw(d, []));
  const out = dltEnsembleForward(result.members, seq);

  assert.equal(out.fProbs.rows, FRONT_DIM);
  assert.equal(out.fStd.rows, FRONT_DIM);
  assert.equal(out.bProbs.rows, BACK_DIM);
  assert.equal(out.bStd.rows, BACK_DIM);

  for (let i = 0; i < FRONT_DIM; i++) {
    assert.ok(out.fProbs.data[i] > 0 && out.fProbs.data[i] < 1, `fProbs[${i}] = ${out.fProbs.data[i]}`);
    assert.ok(out.fStd.data[i] >= 0, `fStd[${i}] = ${out.fStd.data[i]}`);
  }
  for (let i = 0; i < BACK_DIM; i++) {
    assert.ok(out.bProbs.data[i] > 0 && out.bProbs.data[i] < 1, `bProbs[${i}] = ${out.bProbs.data[i]}`);
    assert.ok(out.bStd.data[i] >= 0);
  }
});

test("dltEnsembleForward: K=1 时 std 全为 0", async () => {
  const samples = buildDltSamples(tinyDraws, 6);
  const split = Math.floor(samples.length * 0.8);
  const train = samples.slice(0, split);
  const val = samples.slice(split);

  const result = await trainDltEnsemble(train, val, {
    K: 1,
    modelOpts: { hiddenDim: 6, numLayers: 1, dropoutInput: 0, dropoutHidden: 0, dropoutOutput: 0 },
    trainOpts: { epochs: 1, batchSize: 8, lr: 5e-3, gradClip: 5, patience: 3, weightDecay: 1e-5 },
    seedBase: "dlt-k1",
  });

  const seq = tinyDraws.slice(-6).map(d => encodeDltDraw(d, []));
  const out = dltEnsembleForward(result.members, seq);

  for (let i = 0; i < FRONT_DIM; i++) {
    assert.ok(out.fStd.data[i] < 1e-3, `K=1 std should be ~0, got ${out.fStd.data[i]}`);
  }
});
