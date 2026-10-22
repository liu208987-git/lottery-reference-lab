import { test } from "node:test";
import assert from "node:assert/strict";
import { fitMondrianConformal, mondrianPredict, evaluateMondrianCoverage, splitMondrianConformal } from "../assets/js/mondrian-conformal.js";

function makeRecord(seed, group, realSet) {
  const probs = new Float32Array(33);
  let s = seed;
  const lcg = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < 33; i++) probs[i] = lcg();
  return { probs, realSet, group };
}

test("fitMondrianConformal: 每 group 至少 10 期才有阈值", () => {
  const records = [];
  for (let i = 0; i < 5; i++) records.push(makeRecord(i, "small", [1, 2, 3, 4, 5, 6]));
  for (let i = 0; i < 30; i++) records.push(makeRecord(i + 100, "big", [1, 2, 3, 4, 5, 6]));
  const fit = fitMondrianConformal(records, 0.1);
  assert.ok(!fit.perGroup.has("small"));
  assert.ok(fit.perGroup.has("big"));
  assert.ok(fit.global.qHat > 0);
});

test("mondrianPredict: 不存在的 group 用 fallback", () => {
  const records = [];
  for (let i = 0; i < 30; i++) records.push(makeRecord(i, "g1", [1, 2, 3, 4, 5, 6]));
  const fit = fitMondrianConformal(records, 0.1);
  const probs = new Float32Array(33);
  for (let i = 0; i < 33; i++) probs[i] = 0.3;
  const pred = mondrianPredict(probs, "nonexistent", fit);
  assert.equal(pred.usedGroup, "global-fallback");
  assert.ok(pred.size > 0);
});

test("splitMondrianConformal: 完整流水线返回 perGroup map", () => {
  const records = [];
  let seed = 42;
  const lcg = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 80; i++) {
    const probs = new Float32Array(33);
    for (let j = 0; j < 33; j++) probs[j] = lcg();
    const realSet = [];
    while (realSet.length < 6) {
      const n = Math.floor(lcg() * 33) + 1;
      if (!realSet.includes(n)) realSet.push(n);
    }
    records.push({ probs, realSet, group: i < 40 ? "early" : "late" });
  }
  const r = splitMondrianConformal(records, 0.1);
  assert.ok(r.perGroup instanceof Map);
  assert.ok(typeof r.globalCoverage === "number");
  assert.ok(r.globalCoverage >= 0 && r.globalCoverage <= 1);
});

test("splitMondrianConformal: n<30 返回 warning", () => {
  const r = splitMondrianConformal([], 0.1);
  assert.ok(r.warning);
});
