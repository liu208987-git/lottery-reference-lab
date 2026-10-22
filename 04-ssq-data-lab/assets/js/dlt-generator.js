// 大乐透号码生成器（经典加权随机）
//
// 与双色球生成器同构，但前区 5 选 35、后区 2 选 12。
// 复用了 generator.js 里的 makeWeightsFromFreq / makeMixedWeights / weightedPickOne / weightedSampleWithoutReplacement。

import {
  makeWeightsFromFreq,
  makeMixedWeights,
  weightedPickOne,
  weightedSampleWithoutReplacement,
} from "./generator.js";
import {
  passesDltConstraints,
  analyseDltConstraintFailures,
  frontSpan,
  frontOddCount,
  frontConsecutiveGroups,
  frontMaxSameTail,
  frontZoneIndex,
  FRONT_SIZE,
  FRONT_PICK,
  BACK_SIZE,
  BACK_PICK,
} from "./dlt-distribution.js";

/* ============================================================
 * 撞号惩罚（DLT 版本）
 * ============================================================ */

function hasArithmeticPattern(nums) {
  const set = new Set(nums);
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      const step = nums[j] - nums[i];
      if (step <= 0) continue;
      let run = 2;
      let next = nums[j] + step;
      while (set.has(next)) {
        run++;
        next += step;
      }
      if (run >= 4) return true;
    }
  }
  return false;
}

/** 大乐透撞号惩罚：组合越"集中/可预测"惩罚越高（生日号、同尾、连号、等差、全奇/偶等）。 */
export function dltCrowdPenalty(front, back) {
  let penalty = 0;
  const birthdayCount = front.filter((n) => n <= 31).length;
  const smallDate = front.filter((n) => n <= 12).length;
  const odd = frontOddCount(front);
  const big = front.filter((n) => n >= 18).length;
  const tailMax = frontMaxSameTail(front);
  const consec = frontConsecutiveGroups(front);

  if (birthdayCount === 5) penalty += 2;
  if (smallDate >= 4) penalty += smallDate - 2;
  if (tailMax >= 3) penalty += (tailMax - 2) * 2;
  if (consec >= 2) penalty += consec * 2;
  if (frontSpan(front) < 14) penalty += 2;
  if (odd === 0 || odd === FRONT_PICK) penalty += 3;
  if (big === 0 || big === FRONT_PICK) penalty += 3;
  if (hasArithmeticPattern(front)) penalty += 3;
  // 后区"老彩民"偏好
  if (back.includes(7) && back.includes(12)) penalty += 1;
  if (back[0] === back[1] - 1) penalty += 1;
  return penalty;
}

export function dltCoveragePenalty(ticket, existingTickets) {
  let penalty = 0;
  for (const ex of existingTickets) {
    const overlapF = ticket.front.filter((n) => ex.front.includes(n)).length;
    if (overlapF >= 3) penalty += (overlapF - 2) * 3;
    const overlapB = ticket.back.filter((n) => ex.back.includes(n)).length;
    if (overlapB === 2) penalty += 2;
    else if (overlapB === 1) penalty += 1;
  }
  return penalty;
}

export function dltScoreTicket(ticket, existing = [], optimize = "none") {
  if (optimize !== "diverse") return 0;
  return -(dltCrowdPenalty(ticket.front, ticket.back) + dltCoveragePenalty(ticket, existing));
}

/* ============================================================
 * 候选池构建
 * ============================================================ */

function buildPool({ size, include = [], exclude = [], avoidLast = [] }) {
  const includeSet = new Set(include);
  const excludeSet = new Set([...exclude, ...avoidLast]);
  for (const n of includeSet) excludeSet.delete(n);
  const pool = [];
  for (let n = 1; n <= size; n++) {
    if (includeSet.has(n) || excludeSet.has(n)) continue;
    pool.push(n);
  }
  return { pool, includeList: [...includeSet].sort((a, b) => a - b) };
}

function subsetWeights(sourceWeights, pool) {
  return pool.map((n) => sourceWeights[n - 1]);
}

/* ============================================================
 * 主入口
 * ============================================================ */

/**
 * 大乐透经典生成器：每注独立加权采样。
 *
 * @param freqFront [0..FRONT_SIZE] 前区频次
 * @param freqBack  [0..BACK_SIZE]  后区频次
 */
export function generateDltTickets({
  freqFront,
  freqBack,
  strategyFront,
  strategyBack,
  alpha,
  constraints,
  count,
  includeFront = [],
  excludeFront = [],
  avoidLastFront = [],
  includeBack = [],
  excludeBack = [],
  avoidLastBack = [],
  optimize = "none",
  candidateBatch = 40,
  maxTry = 2000,
  rand = Math.random,
}) {
  const front = buildPool({
    size: FRONT_SIZE,
    include: includeFront,
    exclude: excludeFront,
    avoidLast: avoidLastFront,
  });
  if (front.includeList.length > FRONT_PICK) {
    throw new Error(`前区胆码不能超过 ${FRONT_PICK} 个（当前 ${front.includeList.length}）`);
  }
  const needFront = FRONT_PICK - front.includeList.length;
  if (front.pool.length < needFront) {
    throw new Error(`前区排除过多：还需 ${needFront} 个但只剩 ${front.pool.length}`);
  }

  const back = buildPool({
    size: BACK_SIZE,
    include: includeBack,
    exclude: excludeBack,
    avoidLast: avoidLastBack,
  });
  if (back.includeList.length > BACK_PICK) {
    throw new Error(`后区胆码不能超过 ${BACK_PICK} 个（当前 ${back.includeList.length}）`);
  }
  const needBack = BACK_PICK - back.includeList.length;
  if (back.pool.length < needBack) {
    throw new Error(`后区排除过多：还需 ${needBack} 个但只剩 ${back.pool.length}`);
  }

  const tickets = [];
  const failureReasons = Object.create(null);
  let tries = 0;

  const wFrontSrc = strategyFront === "mix"
    ? makeMixedWeights(freqFront, alpha)
    : makeWeightsFromFreq(freqFront, strategyFront, alpha);
  const wBackSrc = strategyBack === "mix"
    ? makeMixedWeights(freqBack, alpha)
    : makeWeightsFromFreq(freqBack, strategyBack, alpha);

  const makeCandidate = () => {
    tries++;
    const pickedF = needFront === 0
      ? []
      : weightedSampleWithoutReplacement(
          front.pool, subsetWeights(wFrontSrc, front.pool), needFront, rand);
    const fr = [...front.includeList, ...pickedF].sort((a, b) => a - b);

    const pickedB = needBack === 0
      ? []
      : weightedSampleWithoutReplacement(
          back.pool, subsetWeights(wBackSrc, back.pool), needBack, rand);
    const bk = [...back.includeList, ...pickedB].sort((a, b) => a - b);

    if (!passesDltConstraints(fr, constraints)) {
      for (const reason of analyseDltConstraintFailures(fr, constraints)) {
        failureReasons[reason] = (failureReasons[reason] || 0) + 1;
      }
      return null;
    }
    const key = `${fr.join(",")}|${bk.join(",")}`;
    if (tickets.some((t) => t.key === key)) return null;
    return { key, front: fr, back: bk };
  };

  while (tickets.length < count && tries < maxTry) {
    if (optimize !== "diverse") {
      const c = makeCandidate();
      if (c) tickets.push(c);
      continue;
    }
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < candidateBatch && tries < maxTry; i++) {
      const c = makeCandidate();
      if (!c) continue;
      const score = dltScoreTicket(c, tickets, optimize);
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    if (best) tickets.push(best);
  }
  return { tickets, tries, failureReasons };
}
