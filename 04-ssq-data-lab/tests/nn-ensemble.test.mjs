import { test } from "node:test";
import assert from "node:assert/strict";

import { trainEnsemble, ensembleForward } from "../assets/js/nn-ensemble.js";
import { encodeDraw, RED_DIM, BLUE_DIM } from "../assets/js/nn-ssq-model.js";
import { buildSamples } from "../assets/js/nn-trainer.js";

test("trainEnsemble: K=2 produces 2 distinct members", { timeout: 90000 }, async () => {
  const draws = [];
  for (let i = 0; i < 30; i++) {
    draws.push({
      issue: String(i),
      reds: [1, 2, 3, 4, 5, 6 + (i % 5)],
      blue: 1 + (i % 8),
    });
  }
  const samples = buildSamples(draws, 5);
  const train = samples.slice(0, 18);
  const val = samples.slice(18);

  const result = await trainEnsemble(train, val, {
    K: 2,
    seedBase: "ens-test",
    modelOpts: { hiddenDim: 8, numLayers: 1 },
    trainOpts: { epochs: 2, batchSize: 4, lr: 0.01, patience: 100 },
  });
  assert.equal(result.members.length, 2);

  // 两个成员的参数应该不同（不同 seed）
  const w0 = result.members[0].stack.layers[0].params.W.data;
  const w1 = result.members[1].stack.layers[0].params.W.data;
  let diffs = 0;
  for (let i = 0; i < w0.length; i++) if (Math.abs(w0[i] - w1[i]) > 1e-6) diffs++;
  assert.ok(diffs > w0.length * 0.5, `expected most weights to differ, only ${diffs}/${w0.length} differ`);
});

test("ensembleForward: returns valid probability distributions", { timeout: 90000 }, async () => {
  const draws = [];
  for (let i = 0; i < 25; i++) {
    draws.push({
      issue: String(i),
      reds: [1, 2, 3, 4, 5, 6],
      blue: (i % 16) + 1,
    });
  }
  const samples = buildSamples(draws, 5);
  const result = await trainEnsemble(samples.slice(0, 15), samples.slice(15), {
    K: 2,
    seedBase: "ens-fwd",
    modelOpts: { hiddenDim: 8 },
    trainOpts: { epochs: 1, batchSize: 4, lr: 0.01, patience: 100 },
  });

  const seq = [encodeDraw(draws[0]), encodeDraw(draws[1])];
  const out = ensembleForward(result.members, seq);

  // 红球 prob ∈ (0, 1)
  for (let i = 0; i < RED_DIM; i++) {
    assert.ok(out.redProbs.data[i] > 0 && out.redProbs.data[i] < 1);
    assert.ok(out.redStd.data[i] >= 0);
  }
  // 蓝球 prob 归一
  let s = 0;
  for (let i = 0; i < BLUE_DIM; i++) s += out.blueProbs.data[i];
  assert.ok(Math.abs(s - 1) < 1e-5);
});
