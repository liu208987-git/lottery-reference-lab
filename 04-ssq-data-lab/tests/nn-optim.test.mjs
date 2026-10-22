import { test } from "node:test";
import assert from "node:assert/strict";

import { createAdam } from "../assets/js/nn-optim.js";
import { makeMat, fromArray1D } from "../assets/js/nn-math.js";

test("Adam minimizes simple quadratic f(x) = (x-3)² + (y+2)²", () => {
  // 梯度 ∂f/∂x = 2(x-3), ∂f/∂y = 2(y+2)
  const params = { theta: makeMat(2, 1) };
  // 起点 (0, 0)
  const adam = createAdam(params, { lr: 0.1 });
  for (let step = 0; step < 1000; step++) {
    const x = params.theta.data[0];
    const y = params.theta.data[1];
    const grad = makeMat(2, 1);
    grad.data[0] = 2 * (x - 3);
    grad.data[1] = 2 * (y + 2);
    adam.step({ theta: grad });
  }
  assert.ok(Math.abs(params.theta.data[0] - 3) < 1e-3, `x=${params.theta.data[0]}`);
  assert.ok(Math.abs(params.theta.data[1] + 2) < 1e-3, `y=${params.theta.data[1]}`);
});

test("Adam step counter increments", () => {
  const params = { x: makeMat(1, 1) };
  const adam = createAdam(params);
  assert.equal(adam.getStep(), 0);
  adam.step({ x: makeMat(1, 1) });
  assert.equal(adam.getStep(), 1);
});

test("Adam with weight decay shrinks parameters toward zero", () => {
  const params = { x: makeMat(1, 1) };
  params.x.data[0] = 10;
  const adam = createAdam(params, { lr: 0.1, weightDecay: 0.5 });
  // 用零梯度，仅靠 weight decay 把 10 拉低
  for (let step = 0; step < 200; step++) adam.step({ x: makeMat(1, 1) });
  assert.ok(params.x.data[0] < 1, `x should shrink, got ${params.x.data[0]}`);
});

test("Adam handles negative gradients direction reverses correctly", () => {
  const params = { x: fromArray1D([5]) };
  const adam = createAdam(params, { lr: 0.1 });
  // 始终梯度 = 2 → 应当向负方向移动
  for (let step = 0; step < 50; step++) adam.step({ x: fromArray1D([2]) });
  assert.ok(params.x.data[0] < 5);
});
