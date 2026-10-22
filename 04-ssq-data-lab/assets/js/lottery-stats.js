// 通用统计：可复用于双色球（field=reds/blue）和大乐透（field=front/back）。
//
// 与 SSQ 专用的 stats.js 相比，这里不绑定具体字段名，只接受一个 zone 描述符
// （含 key/size/isArray），统一处理"集合字段"与"单值字段"。

import { getZoneNumbers } from "./lottery-config.js";

/** zone 内每个号码的累计出现次数（1-indexed）。 */
export function zoneFreq(draws, zone) {
  const f = Array(zone.size + 1).fill(0);
  for (const d of draws) {
    const nums = getZoneNumbers(d, zone);
    for (const n of nums) {
      if (n >= 1 && n <= zone.size) f[n] += 1;
    }
  }
  return f;
}

/** 每个号码"距最近一次出现"的期数（当前遗漏）。 */
export function zoneCurrentMiss(draws, zone) {
  const lastSeen = Array(zone.size + 1).fill(null);
  const lastIndex = draws.length - 1;
  for (let i = lastIndex; i >= 0; i--) {
    const nums = getZoneNumbers(draws[i], zone);
    for (const n of nums) if (lastSeen[n] == null) lastSeen[n] = i;
  }
  const miss = Array(zone.size + 1).fill(0);
  for (let n = 1; n <= zone.size; n++) {
    miss[n] = lastSeen[n] == null ? draws.length : lastIndex - lastSeen[n];
  }
  return miss;
}

/** Top N 频次。 */
export function topNFromFreq(freq, n, size) {
  const pairs = [];
  for (let i = 1; i <= size; i++) pairs.push([i, freq[i]]);
  pairs.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return pairs.slice(0, n);
}

export function bottomNFromFreq(freq, n, size) {
  const pairs = [];
  for (let i = 1; i <= size; i++) pairs.push([i, freq[i]]);
  pairs.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return pairs.slice(0, n);
}

/** 频次/平均遗漏/最大遗漏/当前遗漏（500.com 标准走势版式右侧统计）。 */
export function zoneMissStats(draws, zone) {
  const total = draws.length;
  const stats = Array.from({ length: zone.size + 1 }, () => ({
    freq: 0, avgMiss: 0, maxMiss: 0, currentMiss: 0,
  }));
  for (let n = 1; n <= zone.size; n++) {
    let lastSeen = -1;
    let maxMiss = 0;
    let freq = 0;
    for (let i = 0; i < total; i++) {
      const nums = getZoneNumbers(draws[i], zone);
      const hit = nums.includes(n);
      if (hit) {
        const gap = i - lastSeen - 1;
        if (gap > maxMiss) maxMiss = gap;
        lastSeen = i;
        freq++;
      }
    }
    const currentMiss = lastSeen === -1 ? total : total - 1 - lastSeen;
    if (currentMiss > maxMiss) maxMiss = currentMiss;
    const avgMiss = freq === 0 ? total : total / freq - 1;
    stats[n] = { freq, avgMiss, maxMiss, currentMiss };
  }
  return stats;
}

/** 增强版：附加 χ² 显著性 + Bonferroni 修正 + 方向标记。 */
export function zoneMissStatsWithSignificance(draws, zone, alpha = 0.05) {
  const stats = zoneMissStats(draws, zone);
  const total = draws.length;
  const pPerNum = zone.pick / zone.size;
  const expected = total * pPerNum;
  const variance = total * pPerNum * (1 - pPerNum);
  const stdDev = Math.sqrt(variance);

  for (let n = 1; n <= zone.size; n++) {
    const O = stats[n].freq;
    const z = stdDev > 0 ? (O - expected) / stdDev : 0;
    const pTwo = 2 * (1 - normCdfApprox(Math.abs(z)));
    stats[n].expected = expected;
    stats[n].zScore = z;
    stats[n].pValue = pTwo;
    stats[n].isSignificant = pTwo < alpha;
    stats[n].isSignificantBonferroni = pTwo < alpha / zone.size;
    stats[n].direction = O > expected ? "hot" : O < expected ? "cold" : "neutral";
  }
  return {
    stats,
    summary: {
      total, pick: zone.pick, size: zone.size, expected, stdDev,
      alpha, bonferroniAlpha: alpha / zone.size,
      hotCount: stats.filter((s, i) => i > 0 && s.isSignificant && s.direction === "hot").length,
      coldCount: stats.filter((s, i) => i > 0 && s.isSignificant && s.direction === "cold").length,
      strictHot: stats.filter((s, i) => i > 0 && s.isSignificantBonferroni && s.direction === "hot").length,
      strictCold: stats.filter((s, i) => i > 0 && s.isSignificantBonferroni && s.direction === "cold").length,
    },
  };
}

function normCdfApprox(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const xx = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * xx);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-xx * xx);
  return 0.5 * (1.0 + sign * y);
}

/** 走势矩阵：每期 → marks。给走势图渲染器使用。 */
export function buildZoneTrend(draws, zone, windowSize = 30) {
  const slice = draws.slice(-windowSize);
  return slice.map((d) => {
    const nums = getZoneNumbers(d, zone);
    return {
      issue: d.issue,
      date: d.date,
      hit: new Set(nums),
    };
  });
}

/** 区域和值。 */
export function zoneSum(draw, zone) {
  return getZoneNumbers(draw, zone).reduce((a, b) => a + b, 0);
}

/** 区域跨度（最大值 - 最小值）。仅对 pick ≥ 2 的区域有意义。 */
export function zoneSpan(draw, zone) {
  const nums = getZoneNumbers(draw, zone);
  if (nums.length < 2) return 0;
  return Math.max(...nums) - Math.min(...nums);
}

/** 区域奇数个数。 */
export function zoneOddCount(draw, zone) {
  return getZoneNumbers(draw, zone).filter((x) => x % 2 === 1).length;
}

/** AC 值：两两差绝对值集合大小 - (k-1)。 */
export function zoneAcValue(draw, zone) {
  const nums = getZoneNumbers(draw, zone);
  if (nums.length < 2) return 0;
  const diffs = new Set();
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      diffs.add(Math.abs(nums[i] - nums[j]));
    }
  }
  return diffs.size - (nums.length - 1);
}

/** 连号组数。 */
export function zoneConsecutiveGroups(draw, zone) {
  const sorted = [...getZoneNumbers(draw, zone)].sort((a, b) => a - b);
  let groups = 0, inRun = false;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] === 1) {
      if (!inRun) groups++;
      inRun = true;
    } else inRun = false;
  }
  return groups;
}

/** 同尾号最大同号数。 */
export function zoneMaxSameTail(draw, zone) {
  const tails = Array(10).fill(0);
  for (const r of getZoneNumbers(draw, zone)) tails[r % 10]++;
  return Math.max(...tails);
}
