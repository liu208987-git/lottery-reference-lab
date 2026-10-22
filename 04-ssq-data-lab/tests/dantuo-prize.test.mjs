import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDantuo, analyzeComplex, singleTicketAnalysis } from "../assets/js/dantuo-prize.js";

test("analyzeDantuo: 单注（D=0, T=6, B=1）等价 SSQ 标准单注", () => {
  const r = analyzeDantuo({ danCount: 0, tuoCount: 6, blueCount: 1 });
  assert.equal(r.totalTickets, 1);
  assert.equal(r.cost, 2);
  // payback 应该 < 1（彩票 EV<cost）
  assert.ok(r.payoutRatio < 1);
  // 至少中奖率 ≈ 6.71%
  assert.ok(r.pAtLeastOneAny > 0.06 && r.pAtLeastOneAny < 0.075,
    `pAtLeastOneAny=${r.pAtLeastOneAny}`);
});

test("analyzeDantuo: 6 红复式（D=0, T=7, B=1）= 7 注", () => {
  const r = analyzeDantuo({ danCount: 0, tuoCount: 7, blueCount: 1 });
  assert.equal(r.totalTickets, 7);
  assert.equal(r.cost, 14);
  // 至少中一注的概率应该 > 单注（因为投了 7 注共享真号）
  const single = analyzeDantuo({ danCount: 0, tuoCount: 6, blueCount: 1 });
  assert.ok(r.pAtLeastOneAny > single.pAtLeastOneAny,
    `7注 ${r.pAtLeastOneAny} 应 > 1注 ${single.pAtLeastOneAny}`);
});

test("analyzeDantuo: 蓝球数 B=16 时蓝肯定中", () => {
  const r = analyzeDantuo({ danCount: 0, tuoCount: 6, blueCount: 16 });
  // 蓝必中，所以六等奖（任意红+蓝）肯定中
  assert.equal(r.totalTickets, 16);
  // 至少中一注的概率 ≈ 1（因为六等奖 = 任何红 + 蓝命中，蓝必中所以六等奖必中）
  assert.ok(r.pAtLeastOneAny > 0.99, `pAtLeastOneAny=${r.pAtLeastOneAny}`);
});

test("analyzeDantuo: 注数 = C(T, 6-D) × B", () => {
  // D=2, T=10, B=3: C(10, 4) × 3 = 210 × 3 = 630
  const r = analyzeDantuo({ danCount: 2, tuoCount: 10, blueCount: 3 });
  assert.equal(r.totalTickets, 630);
  assert.equal(r.cost, 1260);
});

test("analyzeDantuo: byLevel 期望中奖注数和概率合理", () => {
  const r = analyzeDantuo({ danCount: 0, tuoCount: 8, blueCount: 1 });
  assert.equal(r.byLevel.length, 6);
  for (const b of r.byLevel) {
    assert.ok(b.expectedTickets >= 0);
    assert.ok(b.pAtLeastOne >= 0 && b.pAtLeastOne <= 1);
    assert.ok(b.contribution >= 0);
  }
  // 一等奖期望中奖注数极小（< 1e-3）
  const lv1 = r.byLevel.find((b) => b.level === 1);
  assert.ok(lv1.expectedTickets < 1e-3, `lv1 expectedTickets=${lv1.expectedTickets}`);
});

test("analyzeDantuo: 边界错误", () => {
  assert.throws(() => analyzeDantuo({ danCount: -1, tuoCount: 7, blueCount: 1 }));
  assert.throws(() => analyzeDantuo({ danCount: 6, tuoCount: 0, blueCount: 1 }));
  assert.throws(() => analyzeDantuo({ danCount: 2, tuoCount: 3, blueCount: 1 }));  // 拖码不够
  assert.throws(() => analyzeDantuo({ danCount: 0, tuoCount: 6, blueCount: 0 }));
});

test("analyzeComplex: 等价 D=0 的 dantuo", () => {
  const a = analyzeComplex({ redCount: 8, blueCount: 2 });
  const b = analyzeDantuo({ danCount: 0, tuoCount: 8, blueCount: 2 });
  assert.equal(a.totalTickets, b.totalTickets);
  assert.ok(Math.abs(a.payoutRatio - b.payoutRatio) < 1e-9);
});

test("singleTicketAnalysis: 单注 6 级奖 + 至少中奖率 ≈ 6.7%", () => {
  const r = singleTicketAnalysis();
  assert.equal(r.byLevel.length, 6);
  assert.ok(r.pAtLeastOneAny > 0.06 && r.pAtLeastOneAny < 0.075);
  assert.ok(r.payoutRatio < 1);
});

test("analyzeDantuo: aggressive band > expected > conservative", () => {
  const cons = analyzeDantuo({ danCount: 0, tuoCount: 8, blueCount: 1, prizeBand: "conservative" });
  const exp = analyzeDantuo({ danCount: 0, tuoCount: 8, blueCount: 1, prizeBand: "expected" });
  const agg = analyzeDantuo({ danCount: 0, tuoCount: 8, blueCount: 1, prizeBand: "aggressive" });
  assert.ok(cons.payoutRatio < exp.payoutRatio && exp.payoutRatio < agg.payoutRatio);
});
