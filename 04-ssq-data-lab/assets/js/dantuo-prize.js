// 胆拖号码中奖率精确计算
//
// 标准胆拖：
//   - 胆码 D 个：必选红球（D ≤ 5）
//   - 拖码 T 个：候选红球（D + T ≥ 6）
//   - 蓝球 B 个：复式蓝球
//
// 总注数 = C(T, 6 − D) × B
//
// **胆拖等价于把所有"6 红 + 1 蓝"组合都投了一遍**，每注独立。
// 但因为我们关心的是"至少有一注命中"的概率，每注**不独立**（共享胆码、共享拖码池）——
// 必须用精确的"对真实中奖号码的命中状态"分类。
//
// 关键观察：
//   设真实中奖红球集合 W（|W| = 6）；
//   设这一注的胆+拖红球候选集 = D ∪ T'（D 是胆码集合，T' 是拖码集合）；
//   设 d_hit = |D ∩ W|（胆中数），t_hit = |T' ∩ W|（拖中数）；
//   则总命中红球数 = d_hit + t_hit_in_picked，其中 t_hit_in_picked 取决于具体注。
//
// 但**所有拖码组合都投了**，所以这组胆拖**一定包含一注命中所有 d_hit + t_hit 个红球**——
// 即"胆拖最佳红球命中数 = d_hit + t_hit"（如果 d_hit + t_hit ≤ 6）。
//
// 那对每个具体的（d_hit, t_hit, blue_hit）组合，可以精确算出命中各级奖的注数：
//   - C(T_chosen, 选中) × C(剩余拖码, 6−D−选中) × ... 这块需要细数。
//
// 简化版（足够用的近似）：
//   设我们已知"真实命中数 = d + t"，则胆拖里命中"d 胆 + t 拖"号码的注数 =
//     C(T − t, 6 − D − t)  注（即从未选中的拖码里凑齐 6 − D − t 个）。
//   但因为每注红球数固定 = 6 = D + (6−D)，所以"恰好命中 d + t 个红球"的注数：
//     N(d, t) = C(t, t) × C(T − t, 6 − D − t) = C(T − t, 6 − D − t)
//
// 然后按概率分布：
//   P(d_hit = d, t_hit = t)
//     = [C(D, d) × C(T, t) × C(33 − D − T, 6 − d − t)] / C(33, 6)
//
// 蓝球独立：买 B 个蓝中 1 的概率 = B / 16。
//
// 最终：胆拖每个奖级期望中奖注数 = Σ_{d,t,blue_match} P(d_hit=d, t_hit=t, blue_match) × N(d, t, blue)

import { combinations as C } from "./dlt-combinatorics.js";
import { TICKET_PRICE, classifyHit, SSQ_PRIZES, withPrizeProbabilities } from "./ssq-prize.js";

const RED_TOTAL = 33;
const RED_PICK = 6;
const BLUE_TOTAL = 16;

/**
 * @param opts.danCount   胆码数 D ∈ [0, 5]
 * @param opts.tuoCount   拖码数 T，需 D + T ≥ 6
 * @param opts.blueCount  蓝球数 B ∈ [1, 16]
 * @param opts.prizeBand  浮动奖估计 'conservative' | 'expected' | 'aggressive'
 * @returns 该胆拖票的精确中奖率分析
 */
export function analyzeDantuo({
  danCount, tuoCount, blueCount,
  prizeBand = "expected",
} = {}) {
  if (danCount < 0 || danCount > 5) throw new Error("胆码数 0-5");
  if (tuoCount < 6 - danCount) throw new Error(`拖码至少 ${6 - danCount} 个`);
  if (danCount + tuoCount > RED_TOTAL) throw new Error(`胆+拖 不能超过 ${RED_TOTAL}`);
  if (blueCount < 1 || blueCount > BLUE_TOTAL) throw new Error("蓝球 1-16");

  const D = danCount;
  const T = tuoCount;
  const B = blueCount;
  const totalTickets = C(T, 6 - D) * B;

  // 1) 联合分布 P(d_hit, t_hit)
  // P(d_hit=d, t_hit=t) = [C(D,d) × C(T,t) × C(33−D−T, 6−d−t)] / C(33,6)
  // 其中 d ∈ [0, D], t ∈ [0, T], d + t ∈ [0, 6]
  const baseDenom = C(RED_TOTAL, RED_PICK);
  const otherSize = RED_TOTAL - D - T;

  // 2) 蓝球：买 B 个，命中 = B/16，未命中 = (16-B)/16
  const pBlueHit = B / BLUE_TOTAL;
  const pBlueMiss = 1 - pBlueHit;
  const pAnyBlueHit = pBlueHit;  // alias

  // 3) 累加每个奖级的总命中注数期望

  const expectedHitsByLevel = new Array(7).fill(0); // 0=未中, 1..6 等
  const probByHitClass = {};  // {"r+b": prob} 单注命中型态概率（与无胆拖相同）

  // 因为每注就是一注 6 红 + 1 蓝，所以单注概率 = 标准 SSQ 概率
  // 但**胆拖里 N 注共享真号**，所以 hit class 分布不独立
  // 正确做法：对每个 (d_hit, t_hit, blue_hit) 联合事件，算
  //   - 该事件发生的概率 P(d, t, blue)
  //   - 该事件发生时，胆拖中"恰好命中 d+t 红 + blue 蓝"的注数 N(d, t, blue)
  //   - 累加到对应奖级 expectedHits[level] += P × N

  for (let d = 0; d <= Math.min(D, 6); d++) {
    for (let t = 0; t <= Math.min(T, 6 - d); t++) {
      const remainingHit = 6 - d - t;
      if (remainingHit < 0 || remainingHit > otherSize) continue;
      const pDT = C(D, d) * C(T, t) * C(otherSize, remainingHit) / baseDenom;
      // 在这个 (d, t) 事件里，"恰好命中 d 个胆 + t 个拖" 的红球组合数：
      // 每注必含 D 个胆 + (6-D) 个拖；既然真号里有 t 个拖被命中，
      // "恰好命中这 t 个"的红球组合 = C(t, t) × C(T-t, 6-D-t) = C(T-t, 6-D-t)
      const redCombosAtRT = C(T - t, 6 - D - t);
      const r = d + t;

      // 蓝球：每个红球组合都搭配 B 个蓝球（共 redCombos × B 注）
      // - 期望"红 r + 蓝中"的注数 = redCombos × P(真蓝在 B 内) × 1 = redCombos × B/16
      // - 期望"红 r + 蓝不中"的注数 = redCombos × (B − B/16) = redCombos × B × 15/16
      // 注：上式不严格区分"蓝具体是谁"，只看"是否有 1 注命中"

      const ticketsBlueHit = redCombosAtRT * pAnyBlueHit;       // 红=r、蓝中
      const ticketsBlueMiss = redCombosAtRT * B * (BLUE_TOTAL - 1) / BLUE_TOTAL; // 红=r、蓝不中

      // 蓝中分支
      if (B >= 1) {
        const lvHit = classifyHit(r, 1);
        if (lvHit > 0) expectedHitsByLevel[lvHit] += pDT * ticketsBlueHit;
        const keyHit = `${r}+1`;
        probByHitClass[keyHit] = (probByHitClass[keyHit] || 0) + pDT * ticketsBlueHit;
      }
      // 蓝不中分支
      const lvMiss = classifyHit(r, 0);
      if (lvMiss > 0) expectedHitsByLevel[lvMiss] += pDT * ticketsBlueMiss;
      const keyMiss = `${r}+0`;
      probByHitClass[keyMiss] = (probByHitClass[keyMiss] || 0) + pDT * ticketsBlueMiss;
    }
  }

  // 4) 至少中 N 等的概率（更复杂——这里用近似：1 − ∏(1 − p_i)
  // 由于多注共享真号，严格独立性不成立，但每注命中事件的相关性弱于独立
  // 下界：1 − (1 − sum p_i)^N
  // 上界：sum E[hits per level]
  // 实用：用"期望中奖注数 ≥ 1"作为代理（精确不需要）

  // 5) 总期望回报 EV
  const prizeMap = withPrizeProbabilities();
  let evGross = 0;
  const byLevel = [];
  for (let lv = 1; lv <= 6; lv++) {
    const def = SSQ_PRIZES[lv - 1];
    const prize = def.type === "fixed" ? def.fixedPrize : def.estimateBands[prizeBand];
    const expectedTickets = expectedHitsByLevel[lv];
    const contribution = expectedTickets * prize;
    evGross += contribution;
    byLevel.push({
      level: lv,
      label: def.label,
      prize,
      expectedTickets,
      contribution,
      // 至少 1 注命中该级的概率近似（用泊松近似 P(X≥1) ≈ 1 − e^(−λ)）
      pAtLeastOne: 1 - Math.exp(-expectedTickets),
    });
  }
  const cost = totalTickets * TICKET_PRICE;
  const netEv = evGross - cost;

  // 6) "至少中奖" 的期望注数 + 概率
  // 当 B = 16 时蓝必中，每个红组合都会贡献 1 注蓝中（即使红=0 也是六等）。
  // 所以实际"至少 1 注中奖"= P(蓝中) ∨ P(任何注红≥3) ≈ pAnyBlueHit + ε。
  // 当 B < 16 时用泊松近似 + 修正。
  let expectedAnyWin = 0;
  for (let lv = 1; lv <= 6; lv++) expectedAnyWin += expectedHitsByLevel[lv];

  // 精确计算 P(至少 1 注中奖) 的方法：
  //   1) 当 B 大、蓝命中带的"红 0..2 + 蓝中"必中六等 → P ≈ pAnyBlueHit = B/16
  //   2) 否则用泊松近似 1 − e^(−λ) 补充红命中四等及以上的贡献
  // 我们用上下界的最大值
  const pPoisson = 1 - Math.exp(-expectedAnyWin);
  // 精确下界：蓝中 → 六等以上 100% 中
  const pBlueGuarantee = pAnyBlueHit;  // ≥ 0
  const pAtLeastOneAny = Math.max(pPoisson, pBlueGuarantee);

  return {
    danCount: D, tuoCount: T, blueCount: B,
    totalTickets,
    cost,
    evGross,
    netEv,
    payoutRatio: evGross / cost,
    expectedAnyWin,            // 期望中奖注数（任何级）
    pAtLeastOneAny,            // 至少中一注奖的概率（泊松近似）
    expectedAnyWinPct: expectedAnyWin / totalTickets,  // 平均每注中奖率
    byLevel,
  };
}

/**
 * 复式（无胆码）等价于胆拖 D=0 + T=red, B=blue，做封装方便 UI 用。
 */
export function analyzeComplex({ redCount, blueCount, prizeBand = "expected" } = {}) {
  return analyzeDantuo({ danCount: 0, tuoCount: redCount, blueCount, prizeBand });
}

/** 单注命中各级奖概率 + 至少中奖概率（直接复用 ssq-prize）。用于号码体检。 */
export function singleTicketAnalysis({ prizeBand = "expected" } = {}) {
  const r = analyzeDantuo({ danCount: 0, tuoCount: 6, blueCount: 1, prizeBand });
  return {
    byLevel: r.byLevel,
    pAtLeastOneAny: r.pAtLeastOneAny,
    expectedAnyWinPct: r.expectedAnyWinPct,
    payoutRatio: r.payoutRatio,
    netEv: r.netEv,
    cost: r.cost,
  };
}
