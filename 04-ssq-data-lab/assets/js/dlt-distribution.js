// 大乐透分布分析
//
// 大乐透 = 前区 5 选 35 + 后区 2 选 12，规则与双色球不同：
//   - 前区 5 个号 → 奇偶比 0:5..5:0；大小阈值 18（约半分）
//   - 跨度 = 最大 - 最小（4..34）
//   - AC 值范围 0..6（k=5 时 C(5,2)=10 对，去重后 -4 = 0..6）
//   - 三区分法：1-12 / 13-24 / 25-35
//   - 012 路：mod 3
//   - 后区 2 个号 → 奇偶比 0:2/1:1/2:0、和值 3..23、跨度

import { isPrime } from "./distribution.js";

export const FRONT_SIZE = 35;
export const FRONT_PICK = 5;
export const BACK_SIZE = 12;
export const BACK_PICK = 2;

export const FRONT_SUM_MIN = 1 + 2 + 3 + 4 + 5;       // 15
export const FRONT_SUM_MAX = 31 + 32 + 33 + 34 + 35;  // 165
export const FRONT_SPAN_MIN = 4;
export const FRONT_SPAN_MAX = 34;

export const BACK_SUM_MIN = 1 + 2;     // 3
export const BACK_SUM_MAX = 11 + 12;   // 23

/** 前区奇偶比，例如 "3:2"。 */
export function frontOddEvenRatio(front) {
  const odd = front.filter((x) => x % 2 === 1).length;
  return `${odd}:${FRONT_PICK - odd}`;
}

/** 前区大小比，阈值 18（>=18 为大），返回 "大:小"。 */
export function frontBigSmallRatio(front, threshold = 18) {
  const big = front.filter((x) => x >= threshold).length;
  return `${big}:${FRONT_PICK - big}`;
}

/** 前区质合比。 */
export function frontPrimeCompositeRatio(front) {
  const primes = front.filter(isPrime).length;
  return `${primes}:${FRONT_PICK - primes}`;
}

/** 前区 012 路比（mod 3）。 */
export function frontPath012Ratio(front) {
  const counts = [0, 0, 0];
  for (const r of front) counts[r % 3]++;
  return counts.join(":");
}

/** 前区三区比（1-12 / 13-24 / 25-35）。 */
export function frontZoneRatio(front) {
  const z = [0, 0, 0];
  for (const r of front) z[r <= 12 ? 0 : r <= 24 ? 1 : 2]++;
  return z.join(":");
}

export function frontZoneIndex(n) {
  if (n <= 12) return 0;
  if (n <= 24) return 1;
  return 2;
}

/** 前区 AC 值（k=5 时范围 0..6）。 */
export function frontAcValue(front) {
  if (front.length < 2) return 0;
  const diffs = new Set();
  for (let i = 0; i < front.length; i++) {
    for (let j = i + 1; j < front.length; j++) {
      diffs.add(Math.abs(front[i] - front[j]));
    }
  }
  return diffs.size - (front.length - 1);
}

/** 前区连号组数。 */
export function frontConsecutiveGroups(front) {
  const sorted = [...front].sort((a, b) => a - b);
  let groups = 0, inRun = false;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] === 1) {
      if (!inRun) groups++;
      inRun = true;
    } else inRun = false;
  }
  return groups;
}

/** 前区同尾最大次数。 */
export function frontMaxSameTail(front) {
  const tails = Array(10).fill(0);
  for (const r of front) tails[r % 10]++;
  return Math.max(...tails);
}

export function frontSum(front) {
  return front.reduce((a, b) => a + b, 0);
}
export function frontSpan(front) {
  if (front.length < 2) return 0;
  return Math.max(...front) - Math.min(...front);
}
export function frontOddCount(front) {
  return front.filter((x) => x % 2 === 1).length;
}

/** 后区奇偶比 "x:y"。 */
export function backOddEvenRatio(back) {
  const odd = back.filter((x) => x % 2 === 1).length;
  return `${odd}:${BACK_PICK - odd}`;
}

/** 后区和值。 */
export function backSum(back) {
  return back.reduce((a, b) => a + b, 0);
}

/** 后区跨度。 */
export function backSpan(back) {
  if (back.length < 2) return 0;
  return Math.max(...back) - Math.min(...back);
}

/** 把历史按某个特征分桶。 */
export function groupByRatio(draws, fn) {
  const map = new Map();
  for (const d of draws) {
    const key = fn(d);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return String(a[0]).localeCompare(String(b[0]), "zh", { numeric: true });
  });
}

/* ===========================================================
 *  约束系统（用于号码生成器的过滤）
 * =========================================================== */

/** 大乐透前区默认推荐和值带：基于历史 95% 分位区间（约 60-130）。 */
export const FRONT_SUM_RECOMMEND = { min: 60, max: 130 };
/** 默认推荐奇数个数 1-4（即排除全奇/全偶）。 */
export const FRONT_ODD_RECOMMEND = { min: 1, max: 4 };
/** 默认推荐跨度 ≥ 14（k=5 时全密集组合的跨度大约从 4 起）。 */
export const FRONT_SPAN_RECOMMEND = 14;
/** 单区不超过 4 个（即不允许 5:0:0 这种极端集中）。 */
export const FRONT_ZONE_MAX_PER = 4;
/** AC 值推荐 ≥ 3（更"散"）。 */
export const FRONT_AC_RECOMMEND = 3;

/** 大乐透约束检测，c 是布尔配置对象。 */
export function passesDltConstraints(front, c) {
  if (c.sum) {
    const s = frontSum(front);
    if (s < FRONT_SUM_RECOMMEND.min || s > FRONT_SUM_RECOMMEND.max) return false;
  }
  if (c.odd) {
    const oc = frontOddCount(front);
    if (oc < FRONT_ODD_RECOMMEND.min || oc > FRONT_ODD_RECOMMEND.max) return false;
  }
  if (c.span && frontSpan(front) < FRONT_SPAN_RECOMMEND) return false;
  if (c.zone) {
    const z = [0, 0, 0];
    for (const r of front) z[frontZoneIndex(r)]++;
    if (Math.max(...z) > FRONT_ZONE_MAX_PER) return false;
  }
  if (c.ac && frontAcValue(front) < FRONT_AC_RECOMMEND) return false;
  if (c.noConsec && frontConsecutiveGroups(front) > 1) return false;
  return true;
}

export function analyseDltConstraintFailures(front, c) {
  const reasons = [];
  if (c.sum) {
    const s = frontSum(front);
    if (s < FRONT_SUM_RECOMMEND.min || s > FRONT_SUM_RECOMMEND.max) {
      reasons.push(`和值 ${s} 不在 ${FRONT_SUM_RECOMMEND.min}-${FRONT_SUM_RECOMMEND.max}`);
    }
  }
  if (c.odd) {
    const oc = frontOddCount(front);
    if (oc < FRONT_ODD_RECOMMEND.min || oc > FRONT_ODD_RECOMMEND.max) {
      reasons.push(`奇数 ${oc} 不在 ${FRONT_ODD_RECOMMEND.min}-${FRONT_ODD_RECOMMEND.max}`);
    }
  }
  if (c.span && frontSpan(front) < FRONT_SPAN_RECOMMEND) {
    reasons.push(`跨度 ${frontSpan(front)} < ${FRONT_SPAN_RECOMMEND}`);
  }
  if (c.zone) {
    const z = [0, 0, 0];
    for (const r of front) z[frontZoneIndex(r)]++;
    if (Math.max(...z) > FRONT_ZONE_MAX_PER) reasons.push(`单区超 ${FRONT_ZONE_MAX_PER} 个`);
  }
  if (c.ac && frontAcValue(front) < FRONT_AC_RECOMMEND) {
    reasons.push(`AC 值 ${frontAcValue(front)} < ${FRONT_AC_RECOMMEND}`);
  }
  if (c.noConsec && frontConsecutiveGroups(front) > 1) {
    reasons.push(`连号组 ${frontConsecutiveGroups(front)} > 1`);
  }
  return reasons;
}
