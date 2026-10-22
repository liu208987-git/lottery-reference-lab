// 大乐透 9 级奖项体系 + 命中概率 + 期望回报
//
// 大乐透中奖结构（截至 2024 年规则）：
//
//   等级    命中型态      奖金             备注
//   一等   5+2          浮动 1000 万起  设有 1500 万派奖（基本）/ 1800 万（追加），单注最高 2400 万
//   二等   5+1          浮动              基本约 30 万，追加加 60%
//   三等   5+0          固定 10000 元
//   四等   4+2          固定 3000 元
//   五等   4+1          固定 300 元
//   六等   3+2          固定 200 元
//   七等   4+0          固定 100 元
//   八等   3+1 / 2+2    固定 15 元
//   九等   3+0 / 1+2 / 2+1 / 0+2  固定 5 元
//
// 一等/二等用"基本+追加"分别派奖，浮动来自当期奖池规模。这里我们：
//   - 用历史官方均值（采公示数据）作为浮动奖默认估计
//   - 把"追加投注"建模为"额外加 1 元，一二三等加 80% 奖金"（最新规则）
//
// 期望回报 EV：
//   EV(基本投注) = Σ p_i × prize_i × (i 是否计入)
//   EV(追加投注) = EV(基本) + 1 元成本 - 0.8 × Σ p_i × prize_i (一/二/三等)
//
// 在彩票理论里，EV 永远 < 0（运营商抽成），但精确值依赖奖池估计——这个模块给出
// "保守 / 期望 / 激进" 三档浮动奖估计，用户可以一眼看到"追加是不是更划算"。
//
// 数学常量：
//   一等命中概率 = 1 / [C(35,5) × C(12,2)] = 1 / 21,425,712
//   命中型态联合概率：参见 hitClassProbability。

import { combinations as C } from "./dlt-combinatorics.js";

export const FRONT_TOTAL = 35;
export const FRONT_PICK = 5;
export const BACK_TOTAL = 12;
export const BACK_PICK = 2;

export const TICKET_PRICE_BASE = 2;
export const TICKET_PRICE_ADD = 3;        // 基本 2 + 追加 1
export const ADD_PAYBACK_RATIO = 0.8;     // 追加投注一/二/三等多发 80%

/** 命中型态：[frontHit, backHit] → 概率（精确组合数）。 */
export function hitClassProbability(frontHit, backHit) {
  if (frontHit < 0 || frontHit > FRONT_PICK) return 0;
  if (backHit < 0 || backHit > BACK_PICK) return 0;
  const num = C(FRONT_PICK, frontHit) * C(FRONT_TOTAL - FRONT_PICK, FRONT_PICK - frontHit) *
              C(BACK_PICK, backHit) * C(BACK_TOTAL - BACK_PICK, BACK_PICK - backHit);
  const denom = C(FRONT_TOTAL, FRONT_PICK) * C(BACK_TOTAL, BACK_PICK);
  return num / denom;
}

/**
 * 9 个奖级。每级给：
 *   - level: 1..9
 *   - label
 *   - hits: [{frontHit, backHit}, ...]（命中型态可能多种）
 *   - basePrize: 基本奖金（'fixed' 或 'floating'）
 *   - addBonus:  追加加成（仅一/二/三等有效，固定 0.8）
 *   - estimateBands: 浮动奖的 [conservative, expected, aggressive] 估计
 */
export const DLT_PRIZES = [
  {
    level: 1,
    label: "一等奖",
    hits: [{ f: 5, b: 2 }],
    type: "floating",
    estimateBands: { conservative: 5_000_000, expected: 8_000_000, aggressive: 15_000_000 },
    addBonusEnabled: true,
  },
  {
    level: 2,
    label: "二等奖",
    hits: [{ f: 5, b: 1 }],
    type: "floating",
    estimateBands: { conservative: 80_000, expected: 200_000, aggressive: 500_000 },
    addBonusEnabled: true,
  },
  {
    level: 3,
    label: "三等奖",
    hits: [{ f: 5, b: 0 }],
    type: "fixed",
    fixedPrize: 10_000,
    addBonusEnabled: true,
  },
  {
    level: 4,
    label: "四等奖",
    hits: [{ f: 4, b: 2 }],
    type: "fixed",
    fixedPrize: 3_000,
    addBonusEnabled: false,
  },
  {
    level: 5,
    label: "五等奖",
    hits: [{ f: 4, b: 1 }],
    type: "fixed",
    fixedPrize: 300,
    addBonusEnabled: false,
  },
  {
    level: 6,
    label: "六等奖",
    hits: [{ f: 3, b: 2 }],
    type: "fixed",
    fixedPrize: 200,
    addBonusEnabled: false,
  },
  {
    level: 7,
    label: "七等奖",
    hits: [{ f: 4, b: 0 }],
    type: "fixed",
    fixedPrize: 100,
    addBonusEnabled: false,
  },
  {
    level: 8,
    label: "八等奖",
    hits: [{ f: 3, b: 1 }, { f: 2, b: 2 }],
    type: "fixed",
    fixedPrize: 15,
    addBonusEnabled: false,
  },
  {
    level: 9,
    label: "九等奖",
    hits: [{ f: 3, b: 0 }, { f: 1, b: 2 }, { f: 2, b: 1 }, { f: 0, b: 2 }],
    type: "fixed",
    fixedPrize: 5,
    addBonusEnabled: false,
  },
];

/** 给每级奖项附带概率（命中型态求和）。 */
export function withPrizeProbabilities() {
  return DLT_PRIZES.map((p) => {
    let prob = 0;
    for (const { f, b } of p.hits) prob += hitClassProbability(f, b);
    return { ...p, probability: prob };
  });
}

/**
 * 计算一注的中奖等级（命中型态 → 奖项 level，未中返回 0）。
 */
export function classifyHit(frontHit, backHit) {
  for (const p of DLT_PRIZES) {
    for (const h of p.hits) {
      if (h.f === frontHit && h.b === backHit) return p.level;
    }
  }
  return 0;
}

/**
 * 给出在某种"奖池估计带"下的单注期望回报 EV。
 * @param band 'conservative' | 'expected' | 'aggressive'
 * @param mode 'base' | 'add'
 * @returns { ev, evPerYuan, byLevel: [{level, prob, prize, contribution}], cost }
 */
export function expectedReturn({ band = "expected", mode = "base" } = {}) {
  const items = withPrizeProbabilities();
  const cost = mode === "add" ? TICKET_PRICE_ADD : TICKET_PRICE_BASE;
  const breakdown = [];
  let ev = 0;
  for (const it of items) {
    let prize = it.type === "fixed" ? it.fixedPrize : it.estimateBands[band];
    if (mode === "add" && it.addBonusEnabled) prize *= (1 + ADD_PAYBACK_RATIO);
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
    mode,
    cost,
    ev,
    netEv: ev - cost,
    evPerYuan: ev / cost,
    payoutRatio: ev / cost, // payback ratio
    byLevel: breakdown,
  };
}

/**
 * 把单注的"基本 vs 追加"做对比：
 *   - 增量成本 = 1 元
 *   - 增量收益 = 0.8 × Σ p_i × basePrize_i (一/二/三等)
 *   - 增量 EV = 增量收益 - 增量成本
 */
export function additionalBetEdge(band = "expected") {
  const items = withPrizeProbabilities().filter((p) => p.addBonusEnabled);
  let extraGain = 0;
  const detail = [];
  for (const it of items) {
    const base = it.type === "fixed" ? it.fixedPrize : it.estimateBands[band];
    const add = base * ADD_PAYBACK_RATIO;
    const contribution = it.probability * add;
    extraGain += contribution;
    detail.push({
      level: it.level, label: it.label,
      probability: it.probability,
      baseBonus: base,
      addBonus: add,
      contribution,
    });
  }
  return {
    band,
    extraCost: TICKET_PRICE_ADD - TICKET_PRICE_BASE,
    extraGain,
    edge: extraGain - (TICKET_PRICE_ADD - TICKET_PRICE_BASE),
    edgePerYuan: extraGain / (TICKET_PRICE_ADD - TICKET_PRICE_BASE),
    detail,
  };
}

/** 一组票的总期望回报（每注独立同分布累加）。 */
export function ticketsExpectedReturn(ticketsCount, options = {}) {
  const er = expectedReturn(options);
  return {
    ...er,
    tickets: ticketsCount,
    totalCost: er.cost * ticketsCount,
    totalEv: er.ev * ticketsCount,
    totalNetEv: er.netEv * ticketsCount,
  };
}

/** 给定历史 N 期数据，匹配每个奖项实际出现次数（用于校准）。 */
export function historicalPrizeCounts(draws, getTickets) {
  const counts = new Array(10).fill(0); // 0..9
  let totalTickets = 0;
  for (const d of draws) {
    const tickets = getTickets(d) || [];
    for (const t of tickets) {
      const front = t.front || t.reds || [];
      const back = t.back || [];
      const fHit = front.filter((n) => d.front.includes(n)).length;
      const bHit = back.filter((n) => d.back.includes(n)).length;
      const lv = classifyHit(fHit, bHit);
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
 * @param mode "base" | "add"
 * @param secondPrize 二等奖金额（不传用 expected band）
 */
export function breakevenJackpot({ band = "expected", mode = "base", secondPrize = null } = {}) {
  const items = withPrizeProbabilities();
  const cost = mode === "add" ? TICKET_PRICE_ADD : TICKET_PRICE_BASE;
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
    if (mode === "add" && it.addBonusEnabled) prize *= (1 + ADD_PAYBACK_RATIO);
    nonJackpotContribution += it.probability * prize;
  }
  const remaining = cost - nonJackpotContribution;
  if (remaining <= 0) return { breakevenJackpot: 0, currentBand: band, mode, nonJackpotContribution };
  if (pJackpot <= 0) return { breakevenJackpot: null, currentBand: band, mode, nonJackpotContribution };
  // 加 mode：一等奖也享受 80% 加成
  const jackpotMultiplier = (mode === "add" && SSQ_LIKE_ADD_FOR_JACKPOT(items)) ? (1 + ADD_PAYBACK_RATIO) : 1;
  const effectivePJackpot = pJackpot * jackpotMultiplier;
  return {
    breakevenJackpot: remaining / effectivePJackpot,
    currentBand: band,
    mode,
    nonJackpotContribution,
    pJackpot,
  };
}

function SSQ_LIKE_ADD_FOR_JACKPOT(items) {
  // DLT 一等奖享受追加 80% 加成
  const lv1 = items.find((i) => i.level === 1);
  return lv1 ? lv1.addBonusEnabled : false;
}
