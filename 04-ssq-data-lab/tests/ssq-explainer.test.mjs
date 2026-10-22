import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseSsqTicket } from "../assets/js/ssq-explainer.js";

const fakeHistory = [];
for (let i = 0; i < 200; i++) {
  // 随机但确定的 history（保证 patternRarity 不会 0）
  const reds = [(i % 33) + 1, ((i + 5) % 33) + 1, ((i + 11) % 33) + 1, ((i + 17) % 33) + 1, ((i + 23) % 33) + 1, ((i + 29) % 33) + 1];
  fakeHistory.push({ reds: Array.from(new Set(reds)).slice(0, 6).sort((a, b) => a - b), blue: (i % 16) + 1 });
}

test("diagnoseSsqTicket: 极端全奇全小注 → 低分", () => {
  const r = diagnoseSsqTicket({ reds: [1, 3, 5, 7, 9, 11], blue: 1 }, fakeHistory);
  assert.ok(r.totalScore < 60, `极端注总分应 < 60，得 ${r.totalScore}`);
  assert.equal(r.healthLevel.label === "高风险" || r.healthLevel.label === "中等", true);
  assert.equal(r.dimensions.length, 6);
});

test("diagnoseSsqTicket: 均衡分布注 → 高分", () => {
  // 三区均覆盖、奇偶 3:3、AC 高
  const r = diagnoseSsqTicket({ reds: [3, 8, 14, 19, 25, 31], blue: 9 }, fakeHistory);
  assert.ok(r.totalScore > 50, `均衡注总分应 > 50，得 ${r.totalScore}`);
  assert.equal(r.dimensions.length, 6);
  // 每维都返回 0-100
  for (const d of r.dimensions) {
    assert.ok(d.score >= 0 && d.score <= 100, `${d.name} 越界 ${d.score}`);
    assert.ok(typeof d.icon === "string");
    assert.ok(Array.isArray(d.reasons));
  }
});

test("diagnoseSsqTicket: 与上期完全重叠 → overlap dim 低分", () => {
  const last = { reds: [3, 8, 14, 19, 25, 31], blue: 9 };
  const hist = [...fakeHistory, last];
  const r = diagnoseSsqTicket(last, hist);
  const overlap = r.dimensions.find((d) => d.name === "与上期错开");
  assert.ok(overlap.score < 75, `完全重叠 score 应 < 75，得 ${overlap.score}`);
});

test("diagnoseSsqTicket: 历史空 → 部分维度 placeholder", () => {
  const r = diagnoseSsqTicket({ reds: [1, 5, 10, 15, 20, 25], blue: 8 }, []);
  assert.equal(r.dimensions.length, 6);
  assert.ok(r.totalScore >= 0 && r.totalScore <= 100);
});
