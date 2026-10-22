import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hitClassProbability, classifyHit,
  withPrizeProbabilities, expectedReturn, ticketsExpectedReturn,
  SSQ_PRIZES,
} from "../assets/js/ssq-prize.js";

test("hitClassProbability: 6+1 = 1/17,721,088", () => {
  const p = hitClassProbability(6, 1);
  assert.ok(Math.abs(p - 1 / 17721088) < 1e-15, `p=${p}`);
});

test("hitClassProbability: 边界值", () => {
  // 命中 6 红任意蓝（6+0 或 6+1）
  const p6_0 = hitClassProbability(6, 0);
  const p6_1 = hitClassProbability(6, 1);
  assert.ok(Math.abs((p6_0 + p6_1) - 1 / 1107568) < 1e-12, `red 全中概率 = 1/C(33,6)`);
});

test("hitClassProbability: 所有命中型态概率之和 = 1", () => {
  let s = 0;
  for (let r = 0; r <= 6; r++) {
    for (let b = 0; b <= 1; b++) {
      s += hitClassProbability(r, b);
    }
  }
  assert.ok(Math.abs(s - 1) < 1e-12, `sum=${s}`);
});

test("withPrizeProbabilities: 每级返回正概率，总和 ≈ 1/14.9", () => {
  const items = withPrizeProbabilities();
  assert.equal(items.length, 6);
  let sum = 0;
  for (const it of items) {
    assert.ok(it.probability > 0, `${it.label} 概率应 > 0`);
    sum += it.probability;
  }
  // 任意中奖概率 ≈ 6.71%
  assert.ok(sum > 0.06 && sum < 0.07, `任意中奖概率=${sum}，应在 6%-7%`);
});

test("classifyHit: 6+1 = 一等奖", () => {
  assert.equal(classifyHit(6, 1), 1);
  assert.equal(classifyHit(6, 0), 2);
  assert.equal(classifyHit(5, 1), 3);
  assert.equal(classifyHit(0, 1), 6);
  assert.equal(classifyHit(1, 0), 0); // 不中
});

test("expectedReturn: 默认 expected band，EV < 2", () => {
  const r = expectedReturn({ band: "expected" });
  assert.ok(r.ev < 2, `EV=${r.ev} 应 < 2`);
  assert.ok(r.netEv < 0);
  assert.ok(r.payoutRatio < 1);
  assert.equal(r.byLevel.length, 6);
});

test("expectedReturn: aggressive band > expected > conservative", () => {
  const cons = expectedReturn({ band: "conservative" });
  const exp = expectedReturn({ band: "expected" });
  const agg = expectedReturn({ band: "aggressive" });
  assert.ok(cons.ev < exp.ev && exp.ev < agg.ev,
    `cons=${cons.ev} exp=${exp.ev} agg=${agg.ev}`);
});

test("ticketsExpectedReturn: 100 注线性放大", () => {
  const er = expectedReturn({ band: "expected" });
  const batch = ticketsExpectedReturn(100, { band: "expected" });
  assert.equal(batch.totalCost, 200);
  assert.ok(Math.abs(batch.totalEv - 100 * er.ev) < 1e-9);
});
