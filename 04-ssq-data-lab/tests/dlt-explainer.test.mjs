import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseTicket } from "../assets/js/dlt-explainer.js";

const sampleHistory = [];
let seed = 42;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
for (let i = 0; i < 500; i++) {
  const front = [];
  while (front.length < 5) {
    const n = 1 + Math.floor(rand() * 35);
    if (!front.includes(n)) front.push(n);
  }
  front.sort((a, b) => a - b);
  const back = [];
  while (back.length < 2) {
    const n = 1 + Math.floor(rand() * 12);
    if (!back.includes(n)) back.push(n);
  }
  back.sort((a, b) => a - b);
  sampleHistory.push({ issue: String(i), date: "", front, back });
}

test("健康一注（分布平衡）得分应高", () => {
  const r = diagnoseTicket({ front: [3, 11, 18, 25, 32], back: [4, 9] }, sampleHistory);
  assert.ok(r.totalScore >= 60, `score ${r.totalScore}`);
  assert.ok(r.healthLevel.label === "健康" || r.healthLevel.label === "中等");
});

test("全部生日号（≤31）得分应低", () => {
  const r = diagnoseTicket({ front: [3, 7, 12, 18, 25], back: [4, 9] }, sampleHistory);
  // 应该在撞号风险维度被扣分
  const crowd = r.dimensions.find((d) => d.name === "撞号风险");
  assert.ok(crowd.score < 90, `crowd score ${crowd.score}`);
});

test("AC=0（等差数列）拿到极低 AC 分", () => {
  // 1,2,3,4,5 的 AC = 0（diff set = {1,2,3,4}, size 4 - 4 = 0）
  const r = diagnoseTicket({ front: [1, 2, 3, 4, 5], back: [1, 2] }, sampleHistory);
  const ac = r.dimensions.find((d) => d.name === "号码多样性");
  assert.ok(ac.score <= 40, `ac score ${ac.score}`);
});

test("全奇 / 全偶 在分布散度维度被扣分", () => {
  const r = diagnoseTicket({ front: [1, 3, 5, 7, 9], back: [1, 3] }, sampleHistory);
  const dist = r.dimensions.find((d) => d.name === "分布散度");
  assert.ok(dist.score < 90);
});

test("dimensions 数量稳定（6 个）", () => {
  const r = diagnoseTicket({ front: [3, 11, 18, 25, 32], back: [4, 9] }, sampleHistory);
  assert.equal(r.dimensions.length, 6);
  for (const d of r.dimensions) {
    assert.ok(d.score >= 0 && d.score <= 100);
    assert.ok(typeof d.name === "string");
    assert.ok(Array.isArray(d.reasons));
  }
});

test("总分四舍五入到整数", () => {
  const r = diagnoseTicket({ front: [3, 11, 18, 25, 32], back: [4, 9] }, sampleHistory);
  assert.equal(r.totalScore, Math.round(r.totalScore));
});

test("空历史时仍能给出诊断（型态稀缺度回退到默认）", () => {
  const r = diagnoseTicket({ front: [3, 11, 18, 25, 32], back: [4, 9] }, []);
  assert.ok(r.totalScore >= 0 && r.totalScore <= 100);
});

test("advice 含健康或薄弱项提示", () => {
  const good = diagnoseTicket({ front: [3, 11, 18, 25, 32], back: [4, 9] }, sampleHistory);
  const bad = diagnoseTicket({ front: [1, 2, 3, 4, 5], back: [1, 2] }, sampleHistory);
  assert.ok(typeof good.advice === "string" && good.advice.length > 0);
  assert.ok(typeof bad.advice === "string" && bad.advice.length > 0);
});
