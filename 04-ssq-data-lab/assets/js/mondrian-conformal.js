// Mondrian (Group-Conditional) Conformal Prediction
//
// 标准 split conformal 给"边缘覆盖率"（marginal coverage）保证：
//   P(Y ∈ Ĉ(X)) ≥ 1 - α
//
// 但这是平均到全数据上的——可能某些子群的覆盖率明显更低。比如
// "近期 1 年的期数"覆盖率 95%，"5 年前的期数"只有 60%。
//
// Mondrian 共形按预先定义的"taxonomy"（分组）分别校准 q̂_g：
//   ∀ g, P(Y ∈ Ĉ(X) | X ∈ g) ≥ 1 - α
//
// 这给 group-conditional 覆盖率保证。实现上：
//   - 每条 record 带一个 group id（年份 / zone / month / year-half）
//   - 在每个 group 内单独跑 split conformal 算 q̂_g
//   - 预测时根据当前 group 用对应阈值
//
// 当某个 group 样本太少（< 10）就 fallback 到全局 q̂。
//
// 参考：Vovk et al. (2003) "Mondrian Confidence Machine"

import { inverseRankScore, fitConformalThreshold, conformalPredict } from "./conformal.js";

const MIN_GROUP_SIZE = 10;

/**
 * @param records   Array<{probs, realSet, group: string}>
 * @param alpha     significance level
 * @returns         { perGroup: Map<groupId, {qHat, n}>, global: {qHat, n} }
 */
export function fitMondrianConformal(records, alpha = 0.1) {
  if (!records || records.length < 10) {
    return { perGroup: new Map(), global: { qHat: 1, n: 0 }, alpha };
  }
  const byGroup = new Map();
  for (const r of records) {
    const g = r.group ?? "default";
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(r);
  }

  const perGroup = new Map();
  for (const [g, recs] of byGroup) {
    if (recs.length < MIN_GROUP_SIZE) continue;
    const fit = fitConformalThreshold(recs, alpha);
    perGroup.set(g, { qHat: fit.qHat, n: recs.length });
  }
  const global = fitConformalThreshold(records, alpha);
  return { perGroup, global: { qHat: global.qHat, n: records.length }, alpha };
}

/**
 * 用 group 阈值预测；group 不存在或样本太少时 fallback 到全局。
 */
export function mondrianPredict(probs, group, fitResult) {
  const grp = fitResult.perGroup.get(group);
  const qHat = grp ? grp.qHat : fitResult.global.qHat;
  const result = conformalPredict(probs, qHat);
  return {
    ...result,
    qHat,
    usedGroup: grp ? group : "global-fallback",
  };
}

/**
 * 评估每 group 覆盖率：返回 Map<group, {coverage, avgSize, n}>
 */
export function evaluateMondrianCoverage(testRecords, fitResult) {
  const byGroup = new Map();
  for (const r of testRecords) {
    const g = r.group ?? "default";
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(r);
  }
  const result = new Map();
  for (const [g, recs] of byGroup) {
    let hits = 0, totalSize = 0;
    for (const r of recs) {
      const probs = r.probs instanceof Float32Array ? r.probs : Float32Array.from(r.probs);
      const { set, size } = mondrianPredict(probs, g, fitResult);
      totalSize += size;
      if (r.realSet.every((n) => set.includes(n))) hits++;
    }
    result.set(g, {
      coverage: hits / recs.length,
      avgSize: totalSize / recs.length,
      n: recs.length,
    });
  }
  return result;
}

/**
 * 端到端：mondrian split conformal。前一半 calibrate，后一半 evaluate。
 */
export function splitMondrianConformal(records, alpha = 0.1, splitRatio = 0.5) {
  const n = records.length;
  if (n < 30) {
    return { warning: `Mondrian 共形需要至少 30 期，当前 ${n}`, alpha };
  }
  const calN = Math.floor(n * splitRatio);
  const calRecs = records.slice(0, calN);
  const testRecs = records.slice(calN);
  const fit = fitMondrianConformal(calRecs, alpha);
  const evalResult = evaluateMondrianCoverage(testRecs, fit);

  // 全局对照
  const globalCovered = (() => {
    let hits = 0, total = 0;
    for (const r of testRecs) {
      const probs = r.probs instanceof Float32Array ? r.probs : Float32Array.from(r.probs);
      const { set } = mondrianPredict(probs, "__nonexistent__", fit); // 用全局兜底
      if (r.realSet.every((n) => set.includes(n))) hits++;
      total++;
    }
    return total > 0 ? hits / total : 0;
  })();

  return {
    perGroup: evalResult,
    globalCoverage: globalCovered,
    perGroupQHat: fit.perGroup,
    globalQHat: fit.global.qHat,
    alpha,
    expectedCoverage: 1 - alpha,
    calN,
    testN: testRecs.length,
  };
}
