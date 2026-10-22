import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeDltDraw, encodeDltTarget,
  createDltModel, forwardDltModel, dltLossAndGrads,
  flattenDltParams, flattenDltGrads,
  topKFront, topKBack,
  serializeDltModel, deserializeDltModel,
  FRONT_DIM, BACK_DIM, FEATURE_DIM,
} from "../assets/js/dlt-nn-model.js";

test("encodeDltDraw 产生 47 维向量，含 7 个 1（5 前 + 2 后）", () => {
  const d = { front: [1, 5, 10, 20, 30], back: [3, 11] };
  const v = encodeDltDraw(d);
  assert.equal(v.rows, FEATURE_DIM);
  assert.equal(v.cols, 1);
  let ones = 0;
  for (let i = 0; i < v.data.length; i++) if (v.data[i] === 1) ones++;
  assert.equal(ones, 7);
  // 检查具体位置
  assert.equal(v.data[0], 1);  // front 1
  assert.equal(v.data[FRONT_DIM + 2], 1);  // back 3
});

test("encodeDltTarget 分离前后区", () => {
  const d = { front: [1, 5, 10, 20, 30], back: [3, 11] };
  const t = encodeDltTarget(d);
  assert.equal(t.front.rows, FRONT_DIM);
  assert.equal(t.back.rows, BACK_DIM);
  let fOnes = 0, bOnes = 0;
  for (let i = 0; i < t.front.data.length; i++) if (t.front.data[i] === 1) fOnes++;
  for (let i = 0; i < t.back.data.length; i++) if (t.back.data[i] === 1) bOnes++;
  assert.equal(fOnes, 5);
  assert.equal(bOnes, 2);
});

test("forwardDltModel 输出 35 维 + 12 维概率，每个 ∈ (0, 1)", () => {
  const model = createDltModel({ hiddenDim: 16, numLayers: 1 });
  const seq = [];
  for (let t = 0; t < 5; t++) {
    seq.push(encodeDltDraw({
      front: [1 + t, 5 + t, 10 + t, 20, 30],
      back: [3 + (t % 4), 8],
    }));
  }
  const fwd = forwardDltModel(model, seq, { training: false });
  assert.equal(fwd.fProbs.rows, FRONT_DIM);
  assert.equal(fwd.bProbs.rows, BACK_DIM);
  for (let i = 0; i < FRONT_DIM; i++) {
    const p = fwd.fProbs.data[i];
    assert.ok(p > 0 && p < 1, `front prob ${i} = ${p}`);
  }
  for (let i = 0; i < BACK_DIM; i++) {
    const p = fwd.bProbs.data[i];
    assert.ok(p > 0 && p < 1, `back prob ${i} = ${p}`);
  }
});

test("dltLossAndGrads 输出非负 loss 和形状对的梯度", () => {
  const model = createDltModel({ hiddenDim: 12, numLayers: 1 });
  const seq = [];
  for (let t = 0; t < 4; t++) {
    seq.push(encodeDltDraw({ front: [1, 5, 10, 20, 30], back: [3, 8] }));
  }
  const target = encodeDltTarget({ front: [2, 6, 11, 21, 31], back: [4, 9] });
  const { loss, grads } = dltLossAndGrads(model, seq, target);
  assert.ok(loss > 0);
  assert.equal(grads.frontHead.dW.rows, FRONT_DIM);
  assert.equal(grads.frontHead.dW.cols, 12);
  assert.equal(grads.backHead.dW.rows, BACK_DIM);
  assert.equal(grads.stack.length, 1);
});

test("topKFront 返回前 K 个号码，按概率降序", () => {
  const fProbs = { rows: 35, cols: 1, data: new Float32Array(35) };
  for (let i = 0; i < 35; i++) fProbs.data[i] = (35 - i) / 35; // 1 号最高
  const top5 = topKFront(fProbs, 5);
  assert.equal(top5.length, 5);
  assert.equal(top5[0][0], 1);
  assert.ok(top5[0][1] >= top5[4][1]);
});

test("topKBack 返回前 K 个后区号码", () => {
  const bProbs = { rows: 12, cols: 1, data: new Float32Array(12) };
  for (let i = 0; i < 12; i++) bProbs.data[i] = (12 - i) / 12;
  const top2 = topKBack(bProbs, 2);
  assert.equal(top2.length, 2);
  assert.equal(top2[0][0], 1);
});

test("serialize / deserialize 往返保持模型不变", () => {
  const model = createDltModel({ hiddenDim: 8, numLayers: 2 });
  const obj = serializeDltModel(model);
  const restored = deserializeDltModel(obj);
  // 比较每个参数
  const orig = flattenDltParams(model);
  const rest = flattenDltParams(restored);
  for (const k of Object.keys(orig)) {
    assert.equal(orig[k].rows, rest[k].rows);
    assert.equal(orig[k].cols, rest[k].cols);
    for (let i = 0; i < orig[k].data.length; i++) {
      assert.ok(Math.abs(orig[k].data[i] - rest[k].data[i]) < 1e-10);
    }
  }
});

test("flattenDltGrads 形状与 flattenDltParams 一致", () => {
  const model = createDltModel({ hiddenDim: 8, numLayers: 2 });
  const seq = [];
  for (let t = 0; t < 3; t++) seq.push(encodeDltDraw({ front: [1, 5, 10, 20, 30], back: [3, 8] }));
  const target = encodeDltTarget({ front: [2, 6, 11, 21, 31], back: [4, 9] });
  const { grads } = dltLossAndGrads(model, seq, target);
  const flatG = flattenDltGrads(grads);
  const flatP = flattenDltParams(model);
  for (const k of Object.keys(flatP)) {
    assert.ok(flatG[k], `missing grad for ${k}`);
    assert.equal(flatG[k].rows, flatP[k].rows);
    assert.equal(flatG[k].cols, flatP[k].cols);
  }
});
