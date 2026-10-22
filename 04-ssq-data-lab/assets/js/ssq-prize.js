// 双色球 6 级奖项体系 + 命中概率 + 期望回报 EV
//
// 双色球中奖结构（截至 2024 年规则）：
//
//   等级    命中型态                       奖金             备注
//   一等   6 红 + 蓝                        浮动（500 万起）  历史最高 1500 万派奖
//   二等   6 红                              浮动              当期奖池 30%（约几万至几十万）
//   三等   5 红 + 蓝                        固定 3000 元
//   四等   5 红 / 4 红 + 蓝                 固定 200 元
//   五等   4 红 / 3 红 + 蓝                 固定 10 元
//   六等   2 红 + 蓝 / 1 红 + 蓝 / 0 红 + 蓝  固定 5 元
//
// 双色球**没有追加投注**（这是与大乐透的关键区别），所以本模块比 dlt-prize 简单。
//
// 数学常量：
//   一等命中概率 = 1 / [C(33,6) × 16] = 1 / 17,721,088
//   命中型态联合概率：参见 hitClassProbability。
//
// 与 dlt-prize.js 同构 API，方便 UI 复用。

import { combinations as C } from "./dlt-combinatorics.js";

export const RED_TOTAL = 33;
export const RED_PICK = 6;
export const BLUE_TOTAL = 16;
export const BLUE_PICK = 1;

export const TICKET_PRICE = 2;

/** 命中型态：[redHit, blueHit] → 概率（精确组合数）。 */
export function hitClassProbability(redHit, blueHit) {
  if (redHit < 0 || redHit > RED_PICK) return 0;
  if (blueHit < 0 || blueHit > BLUE_PICK) return 0;
  const num = C(RED_PICK, redHit) * C(RED_TOTAL - RED_PICK, RED_PICK - redHit) *
              C(BLUE_PICK, blueHit) * C(BLUE_TOTAL - BLUE_PICK, BLUE_PICK - blueHit);
  const denom = C(RED_TOTAL, RED_PICK) * C(BLUE_TOTAL, BLUE_PICK);
  return num / denom;
}

/**
 * 6 个奖级。每级给：
 *   - level: 1..6
 *   - label
 *   - hits: [{r, b}, ...]
 *   - type: "fixed" | "floating"
 *   - fixedPrize / estimateBands
 */
export const SSQ_PRIZES = [
  {
    level: 1,
    label: "一等奖",
    hits: [{ r: 6, b: 1 }],
    type: "floating",
    estimateBands: { conservative: 5_000_000, expected: 8_000_000, aggressive: 15_000_000 },
  },
  {
    level: 2,
    label: "二等奖",
    hits: [{ r: 6, b: 0 }],
    type: "floating",
    estimateBands: { conservative: 50_000, expected: 150_000, aggressive: 500_000 },
  },
  {
    level: 3,
    label: "三等奖",
    hits: [{ r: 5, b: 1 }],
    type: "fixed",
    fixedPrize: 3_000,
  },
  {
    level: 4,
    label: "四等奖",
    hits: [{ r: 5, b: 0 }, { r: 4, b: 1 }],
    type: "fixed",
    fixedPrize: 200,
  },
  {
    level: 5,
    label: "五等奖",
    hits: [{ r: 4, b: 0 }, { r: 3, b: 1 }],
    type: "fixed",
    fixedPrize: 10,
  },
  {
    level: 6,
    label: "六等奖",
    hits: [{ r: 2, b: 1 }, { r: 1, b: 1 }, { r: 0, b: 1 }],
    type: "fixed",
    fixedPrize: 5,
  },
];

/** 给每级奖项附带概率（命中型态求和）。 */
export function withPrizeProbabilities() {
  return SSQ_PRIZES.map((p) => {
    let prob = 0;
    for (const { r, b } of p.hits) prob += hitClassProbability(r, b);
    return { ...p, probability: prob };
  });
}

/**
 * 计算一注的中奖等级（命中型态 → 奖项 level，未中返回 0）。
 */
export function classifyHit(redHit, blueHit) {
  for (const p of SSQ_PRIZES) {
    for (const h of p.hits) {
      if (h.r === redHit && h.b === blueHit) return p.level;
    }
  }
  return 0;
}

/**
 * 给出在某种"奖池估计带"下的单注期望回报 EV。
 * @param band 'conservative' | 'expected' | 'aggressive'
 * @returns { ev, evPerYuan, byLevel: [{level, prob, prize, contribution}], cost }
 */
export function expectedReturn({ band = "expected" } = {}) {
  const items = withPrizeProbabilities();
  const cost = TICKET_PRICE;
  const breakdown = [];
  let ev = 0;
  for (const it of items) {
    const prize = it.type === "fixed" ? it.fixedPrize : it.estimateBands[band];
    const contribution = it.probability * prize;
    ev += contribution;
    breakdown.push({
      level: it.level,
      label: it.label,
      probability: it.probability,
      oneIn: it.probability > 0 ? 1 / it.probability : Infinity,
      prize,
      contribution,
    });
  }
  return {
    band,
    cost,
    ev,
    netEv: ev - cost,
    evPerYuan: ev / cost,
    payoutRatio: ev / cost,
    byLevel: breakdown,
  };
}

/** 一组票的总期望回报。 */
export function ticketsExpectedReturn(ticketsCount, options = {}) {
  const er = expectedReturn(options);
  return {
    ticketsCount,
    band: er.band,
    totalCost: ticketsCount * er.cost,
    totalEv: ticketsCount * er.ev,
    netEv: ticketsCount * er.netEv,
    payoutRatio: er.payoutRatio,
  };
}

/** 给定历史 N 期 + tickets 生成器函数，统计实际命中分布（用于校准）。 */
export function historicalPrizeCounts(draws, getTickets) {
  const counts = new Array(7).fill(0); // 0..6
  let totalTickets = 0;
  for (const d of draws) {
    const tickets = getTickets(d) || [];
    for (const t of tickets) {
      const reds = t.reds || [];
      const blue = t.blue;
      const rHit = reds.filter((n) => d.reds.includes(n)).length;
      const bHit = blue === d.blue ? 1 : 0;
      const lv = classifyHit(rHit, bHit);
      counts[lv]++;
      totalTickets++;
    }
  }
  return { counts, totalTickets };
}


/**
 * 反推：保持其他奖项 EV 贡献固定，让 EV ≥ cost 所需的"一等奖最低金额"。
 * 用于"盈亏平衡奖池"提示。
 *
 * 用 expected band 算非一等奖固定贡献 → 反推一等奖。
 * @returns { breakevenJackpot: number | null, currentBand: string }
 *   null 表示数学上不可能（其他奖项已经足够，但实际不会发生）
 */
export function breakevenJackpot({ band = "expected", secondPrize = null } = {}) {
  const items = withPrizeProbabilities();
  const cost = TICKET_PRICE;
  let nonJackpotContribution = 0;
  let pJackpot = 0;
  for (const it of items) {
    if (it.level === 1) {
      pJackpot = it.probability;
      continue;
    }
    let prize;
    if (it.level === 2 && secondPrize != null) {
      prize = secondPrize;
    } else {
      prize = it.type === "fixed" ? it.fixedPrize : it.estimateBands[band];
    }
    nonJackpotContribution += it.probability * prize;
  }
  const remaining = cost - nonJackpotContribution;
  if (remaining <= 0) return { breakevenJackpot: 0, currentBand: band, nonJackpotContribution };
  if (pJackpot <= 0) return { breakevenJackpot: null, currentBand: band, nonJackpotContribution };
  return {
    breakevenJackpot: remaining / pJackpot,
    currentBand: band,
    nonJackpotContribution,
    pJackpot,
  };
}
