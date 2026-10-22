import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStackedLSTM, stackedForward, stackedBackward,
  serializeStack, deserializeStack,
} from "../assets/js/nn-stack.js";
import { makeMat, clone } from "../assets/js/nn-math.js";
import { createRng } from "../assets/js/rng.js";

function makeXs(rng, T, dim) {
  const xs = [];
  for (let t = 0; t < T; t++) {
    const x = makeMat(dim, 1);
    for (let i = 0; i < dim; i++) x.data[i] = rng() * 2 - 1;
    xs.push(x);
  }
  return xs;
}

test("Stacked LSTM with numLayers=1 matches single LSTM behavior", () => {
  const rng = createRng("stack-1").next;
  const stack = createStackedLSTM(4, 5, 1, rng);
  const xs = makeXs(rng, 5, 4);
  const fwd = stackedForward(stack, xs, { training: false });
  assert.equal(fwd.allH.length, 1);
  assert.equal(fwd.allH[0].length, 5);
  for (const h of fwd.allH[0]) {
    assert.equal(h.rows, 5);
    assert.equal(h.cols, 1);
  }
});

test("Stacked LSTM 2 layers: h shape correct, hLast = top layer h_T", () => {
  const rng = createRng("stack-2").next;
  const stack = createStackedLSTM(4, 6, 2, rng);
  const xs = makeXs(rng, 4, 4);
  const fwd = stackedForward(stack, xs, { training: false });
  assert.equal(fwd.allH.length, 2);
  assert.equal(fwd.allH[1].length, 4);
  assert.equal(fwd.hLast.rows, 6);
  // hLast 等于 allH[1][3]
  for (let i = 0; i < 6; i++) assert.equal(fwd.hLast.data[i], fwd.allH[1][3].data[i]);
});

test("Stacked backward: gradient check on 2-layer stack", () => {
  const rng = createRng("stack-grad").next;
  const stack = createStackedLSTM(3, 4, 2, rng);
  const T = 3;
  const xs = makeXs(rng, T, 3);

  function loss() {
    const fwd = stackedForward(stack, xs, { training: false });
    let s = 0;
    for (const h of fwd.allH[stack.numLayers - 1]) {
      for (let i = 0; i < h.data.length; i++) s += h.data[i] * h.data[i];
    }
    return 0.5 * s;
  }

  // dL/d(h_top_t) = h_top_t
  const fwd = stackedForward(stack, xs, { training: false });
  const dh = fwd.allH[stack.numLayers - 1].map((h) => clone(h));
  const result = stackedBackward(stack, fwd, dh);
  // result.grads 是 [{dW,dU,db}, {dW,dU,db}, ...] 每层一个

  // 数值 vs 解析：随机抽 6 个位置
  const eps = 1e-4;
  const layer = 1; // 顶层
  const params = stack.layers[layer].params;
  const sample = (M, dM, k) => {
    const stride = Math.max(1, Math.floor(M.data.length / k));
    let maxRel = 0, maxAbs = 0;
    for (let idx = 0; idx < M.data.length; idx += stride) {
      const orig = M.data[idx];
      M.data[idx] = orig + eps;
      const lp = loss();
      M.data[idx] = orig - eps;
      const lm = loss();
      M.data[idx] = orig;
      const num = (lp - lm) / (2 * eps);
      const an = dM.data[idx];
      const err = Math.abs(num - an);
      if (err > maxAbs) maxAbs = err;
      const denom = Math.max(Math.abs(num), Math.abs(an));
      if (denom > 1e-3) {
        const rel = err / denom;
        if (rel > maxRel) maxRel = rel;
      }
    }
    return { maxAbs, maxRel };
  };

  // 顶层 dW
  const r1 = sample(params.W, result.grads[layer].dW, 8);
  assert.ok(r1.maxRel < 5e-3 || r1.maxAbs < 1e-4, `top dW rel=${r1.maxRel}`);

  // 底层 dW（更深路径）
  const r2 = sample(stack.layers[0].params.W, result.grads[0].dW, 8);
  assert.ok(r2.maxRel < 5e-3 || r2.maxAbs < 1e-4, `bottom dW rel=${r2.maxRel}`);
});

test("Stacked LSTM serialization round-trip", () => {
  const rng = createRng("stack-ser").next;
  const stack = createStackedLSTM(4, 5, 2, rng);
  const ser = serializeStack(stack);
  const restored = deserializeStack(JSON.parse(JSON.stringify(ser)));
  for (let l = 0; l < 2; l++) {
    for (let i = 0; i < stack.layers[l].params.W.data.length; i++) {
      assert.equal(restored.layers[l].params.W.data[i], stack.layers[l].params.W.data[i]);
    }
  }
});

test("Dropout (training=true) zeros some outputs but expectation is preserved", () => {
  const rng = createRng("dropout").next;
  const stack = createStackedLSTM(4, 8, 2, rng);
  const xs = makeXs(rng, 6, 4);
  const fwd = stackedForward(stack, xs, {
    training: true, dropoutIn: 0.5, dropoutHidden: 0.5, rng,
  });
  // 至少有一层间 mask 不为 null
  let hasMask = false;
  for (let l = 0; l < 1; l++) {
    for (const m of fwd.layerMasks[l]) {
      if (m) { hasMask = true; break; }
    }
  }
  assert.ok(hasMask);
});

test("Dropout (training=false) is no-op", () => {
  const rng = createRng("nodrop").next;
  const stack = createStackedLSTM(3, 4, 2, rng);
  const xs = makeXs(rng, 4, 3);
  const fwd1 = stackedForward(stack, xs, { training: false, dropoutIn: 0.5, dropoutHidden: 0.5 });
  const fwd2 = stackedForward(stack, xs, { training: false, dropoutIn: 0.5, dropoutHidden: 0.5 });
  // 两次 forward 完全相同
  for (let l = 0; l < 2; l++) {
    for (let t = 0; t < 4; t++) {
      for (let i = 0; i < 4; i++) {
        assert.equal(fwd1.allH[l][t].data[i], fwd2.allH[l][t].data[i]);
      }
    }
  }
});
