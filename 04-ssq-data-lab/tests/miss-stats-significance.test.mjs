import { test } from "node:test";
import assert from "node:assert/strict";
import { missStatsWithSignificance } from "../assets/js/miss-stats.js";

function fakeDraws(n, biased = false) {
  // 生成 n 期假数据；biased=true 时号码 1 出现频率明显高
  const draws = [];
  let seed = 42;
  const lcg = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    const reds = [];
    if (biased && i % 2 === 0) reds.push(1); // 让号码 1 ≈ 50% 出现
    while (reds.length < 6) {
      const r = Math.floor(lcg() * 33) + 1;
      if (!reds.includes(r)) reds.push(r);
    }
    draws.push({ reds: reds.sort((a, b) => a - b), blue: Math.floor(lcg() * 16) + 1 });
  }
  return draws;
}

test("missStatsWithSignificance: 均匀数据下大多数号 z 接近 0", () => {
  const draws = fakeDraws(500);
  const r = missStatsWithSignificance(draws, 33, 6, "reds");
  let extremeCount = 0;
  for (let n = 1; n <= 33; n++) {
    if (Math.abs(r.stats[n].zScore) > 2.5) extremeCount++;
  }
  // 33 个号里 |z| > 2.5 的应 ≤ 5 个（5σ 显著）
  assert.ok(extremeCount <= 5, `extremeCount=${extremeCount}`);
});

test("missStatsWithSignificance: 偏态数据下号码 1 显著热", () => {
  const draws = fakeDraws(300, true);
  const r = missStatsWithSignificance(draws, 33, 6, "reds");
  // 号码 1 应该是极显著热号
  assert.ok(r.stats[1].zScore > 3, `号 1 z=${r.stats[1].zScore} 应 > 3`);
  assert.equal(r.stats[1].direction, "hot");
  assert.ok(r.stats[1].pValue < 0.001);
  assert.ok(r.stats[1].isSignificantBonferroni);
});

test("missStatsWithSignificance: pValue 边界合法", () => {
  const draws = fakeDraws(200);
  const r = missStatsWithSignificance(draws, 33, 6, "reds");
  for (let n = 1; n <= 33; n++) {
    assert.ok(r.stats[n].pValue >= 0 && r.stats[n].pValue <= 1,
      `号 ${n} p=${r.stats[n].pValue}`);
  }
});

test("missStatsWithSignificance: summary 字段合理", () => {
  const draws = fakeDraws(300);
  const r = missStatsWithSignificance(draws, 33, 6, "reds");
  assert.equal(r.summary.size, 33);
  assert.equal(r.summary.pick, 6);
  assert.ok(Math.abs(r.summary.expected - 300 * 6 / 33) < 1e-9);
  assert.ok(r.summary.bonferroniAlpha > 0 && r.summary.bonferroniAlpha < 0.05);
  // 严格异常应 ≤ 总异常
  assert.ok(r.summary.strictHot <= r.summary.hotCount);
  assert.ok(r.summary.strictCold <= r.summary.coldCount);
});

test("breakeven SSQ: aggressive band 比 conservative 容易", () => {
  // 间接测试 ssq-prize.breakevenJackpot
  return import("../assets/js/ssq-prize.js").then((m) => {
    const consBe = m.breakevenJackpot({ band: "conservative" });
    const aggBe = m.breakevenJackpot({ band: "aggressive" });
    // 高 band 时其他奖项贡献多，所需一等奖少
    if (consBe.breakevenJackpot != null && aggBe.breakevenJackpot != null) {
      assert.ok(aggBe.breakevenJackpot < consBe.breakevenJackpot,
        `agg=${aggBe.breakevenJackpot} cons=${consBe.breakevenJackpot}`);
    }
    assert.ok(consBe.breakevenJackpot > 1e6, "盈亏平衡奖池应 > 100万");
  });
});

test("breakeven DLT: base mode 与 add mode", () => {
  return import("../assets/js/dlt-prize.js").then((m) => {
    const beBase = m.breakevenJackpot({ mode: "base" });
    const beAdd = m.breakevenJackpot({ mode: "add" });
    assert.ok(beBase.breakevenJackpot > 1e7, "DLT 一等盈亏平衡应 > 1000万");
    // 追加多花 1 元，但一等奖享 80% 加成
    // breakeven 不一定单调（看具体奖项贡献）
    assert.ok(beAdd.breakevenJackpot != null);
  });
});
