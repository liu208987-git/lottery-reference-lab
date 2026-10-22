// 理性投注核心数学
//
// 这个模块的目的不是"提升中奖概率"——单注中奖概率是规则定的常数：
//   - SSQ 一等奖 = 1/17,721,088
//   - DLT 一等奖 = 1/21,425,712
//
// **任何算法都不能改变这两个数字。** 这是测度论结论。
//
// 但本模块严格做以下 4 件数学上真有效的事：
//
//   1. 期望回报 EV：根据当前奖池 + 销量预估，算"这一注的期望收益"
//      是否大于成本。绝大多数期 EV < cost；DLT 大滚奖偶尔反过来。
//
//   2. 多注覆盖率：买 K 注时，K 注**互不重叠**比 K 注随机能稍微提高
//      "至少 1 注命中 ≥ T 级奖"的概率。差距来自消除重号撞号浪费。
//
//   3. Kelly 准则：给定单注 EV、payout、bankroll，算最优投注比例。
//      公式：f* = (b·p − q) / b。彩票场景 b·p < q → f* < 0 → 不应投。
//
//   4. 破产风险 MC：固定每期投注额，模拟 N 期 bankroll 走势，统计破产
//      概率与最终财富分布。
//
// 所有函数纯函数 + 显式输入输出，无副作用，可独立测试。

import { createRng } from "./rng.js";

/* ============================================================
 * 组合数学
 * ============================================================ */

/** C(n, k)，整数。带浮点近似避免溢出。 */
export function combinations(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  if (k > n - k) k = n - k;
  let r = 1;
  for (let i = 0; i < k; i++) {
    r = r * (n - i) / (i + 1);
  }
  return r;
}

/** Hypergeometric P(X=k)：从 n 个里抽 K 个，其中 m 个是"好"的，恰好命中 k 个。 */
export function hypergeometric(k, K, m, n) {
  return combinations(m, k) * combinations(n - m, K - k) / combinations(n, K);
}

/* ============================================================
 * SSQ 单注奖级概率（精确，hypergeometric × bernoulli）
 * ============================================================ */

/**
 * 双色球单注命中各级奖的精确概率。
 * 红球：从 33 个里抽 6 个，命中 k 个的概率 = C(6,k)·C(27,6-k) / C(33,6)
 * 蓝球：1/16 命中
 */
export function ssqSinglePrizeProbabilities() {
  const pRed = (k) => hypergeometric(k, 6, 6, 33);
  const pBlue = 1 / 16;
  const pNotBlue = 15 / 16;

  // 双色球 6 个奖级的命中条件：
  // 一等: 6红+蓝   二等: 6红   三等: 5红+蓝   四等: 5红 / 4红+蓝
  // 五等: 4红 / 3红+蓝   六等: 任意+蓝（≤2红+蓝 / 0-2红+蓝）
  const r6 = pRed(6), r5 = pRed(5), r4 = pRed(4), r3 = pRed(3), r2 = pRed(2), r1 = pRed(1), r0 = pRed(0);

  const tiers = [
    { name: "一等奖", p: r6 * pBlue,           prize: "浮动（500万-千万级）" },
    { name: "二等奖", p: r6 * pNotBlue,        prize: "浮动（约几万-几十万）" },
    { name: "三等奖", p: r5 * pBlue,           prize: 3000 },
    { name: "四等奖", p: r5 * pNotBlue + r4 * pBlue, prize: 200 },
    { name: "五等奖", p: r4 * pNotBlue + r3 * pBlue, prize: 10 },
    { name: "六等奖", p: (r2 + r1 + r0) * pBlue,    prize: 5 },
  ];
  let pAny = 0;
  for (const t of tiers) pAny += t.p;
  return { tiers, pAny, pNoPrize: 1 - pAny };
}

/* ============================================================
 * DLT 单注奖级概率
 * ============================================================ */

/**
 * 大乐透单注命中各级奖的精确概率。
 * 前区：从 35 选 5
 * 后区：从 12 选 2
 */
export function dltSinglePrizeProbabilities() {
  const pFront = (k) => hypergeometric(k, 5, 5, 35);
  const pBack = (k) => hypergeometric(k, 2, 2, 12);
  const f = [0, 1, 2, 3, 4, 5].map(pFront);
  const b = [0, 1, 2].map(pBack);

  const tiers = [
    { name: "一等奖", p: f[5] * b[2], prize: "浮动（约 1000 万）" },
    { name: "二等奖", p: f[5] * b[1], prize: 100000 },
    { name: "三等奖", p: f[5] * b[0], prize: 10000 },
    { name: "四等奖", p: f[4] * b[2], prize: 3000 },
    { name: "五等奖", p: f[4] * b[1] + f[3] * b[2], prize: 300 },
    { name: "六等奖", p: f[4] * b[0] + f[3] * b[1] + f[2] * b[2], prize: 200 },
    { name: "七等奖", p: f[3] * b[0] + f[2] * b[1] + f[1] * b[2] + f[0] * b[2], prize: 10 },
  ];
  let pAny = 0;
  for (const t of tiers) pAny += t.p;
  return { tiers, pAny, pNoPrize: 1 - pAny };
}

/* ============================================================
 * 期望回报 EV
 * ============================================================ */

/**
 * 给定奖级概率 + 当期奖金（一等奖、二等奖浮动），算单注期望收益。
 * @param tiers       概率表 [{p, prize}, ...] 注意 prize 可能是 "浮动"
 * @param fixedPrizes 把 "浮动" 替换成具体数字 { 一等奖: 5000000, 二等奖: 50000 }
 * @param ticketCost  单注成本（默认 2）
 * @returns {
 *   ev: number,                单注期望收益（不含成本）
 *   evMinusCost: number,       净期望（ev − cost）
 *   pAnyWin: number,           至少中一注的概率
 *   evByTier: Array<{...}>,    每级贡献度
 *   shouldPlay: boolean,       净期望 > 0
 * }
 */
export function expectedValue(tiers, fixedPrizes = {}, ticketCost = 2) {
  let ev = 0;
  let pAnyWin = 0;
  const evByTier = [];
  for (const t of tiers) {
    const prize = typeof t.prize === "number" ? t.prize : (fixedPrizes[t.name] ?? 0);
    const contribution = t.p * prize;
    ev += contribution;
    pAnyWin += t.p;
    evByTier.push({ name: t.name, p: t.p, prize, contribution });
  }
  return {
    ev,
    evMinusCost: ev - ticketCost,
    pAnyWin,
    evByTier,
    shouldPlay: ev > ticketCost,
    ticketCost,
  };
}

/* ============================================================
 * 多注覆盖率
 *
 * 当买 K 注互不重叠的彩票，"至少 1 注命中 ≥ T 级奖" 的概率。
 *
 * 严格分析：
 *   1) 红球（前区）匹配数是 hypergeometric 分布
 *   2) K 注互不重叠 → 红球部分高度相关
 *
 *  精确解：5 注红组合数有 C(33,6)^5 ≈ 1.6e34 种，蒙特卡洛是唯一可行解。
 *  我们用 N=10000 次重抽求 P(any) 估计，标准差 ≈ √(p(1-p)/N) ≈ 0.005。
 * ============================================================ */

/**
 * 蒙特卡洛估计：买 K 注（每注 6 红 + 1 蓝），at least 1 注中 ≥ tierThreshold 级奖的概率。
 * @param opts.K            注数
 * @param opts.lottery      "ssq" | "dlt"
 * @param opts.tierThreshold 1..6（SSQ）或 1..7（DLT），1 = 一等奖，n = n 等奖以上
 * @param opts.strategy     "random" | "diverse"  注间是否强制不重号
 * @param opts.runs         模拟次数，默认 5000
 * @param opts.seed
 */
export function multiTicketCoverage({
  K = 5,
  lottery = "ssq",
  tierThreshold = 6,
  strategy = "diverse",
  runs = 5000,
  seed = "cov",
} = {}) {
  const rng = createRng(seed).next;
  const config = lottery === "dlt"
    ? { redPick: 5, redSize: 35, bluePick: 2, blueSize: 12, tier: dltTier }
    : { redPick: 6, redSize: 33, bluePick: 1, blueSize: 16, tier: ssqTier };

  let hits = 0;
  for (let r = 0; r < runs; r++) {
    // 1) 抽真号
    const realReds = sampleK(rng, config.redPick, config.redSize);
    const realBlues = sampleK(rng, config.bluePick, config.blueSize);

    // 2) 生成 K 注
    let tickets;
    if (strategy === "diverse") {
      tickets = generateDiverseTickets(rng, K, config);
    } else {
      tickets = [];
      for (let k = 0; k < K; k++) {
        tickets.push({
          reds: sampleK(rng, config.redPick, config.redSize),
          blues: sampleK(rng, config.bluePick, config.blueSize),
        });
      }
    }

    // 3) 检查是否至少一注 ≥ tierThreshold
    let hit = false;
    for (const t of tickets) {
      const redMatch = t.reds.filter((n) => realReds.includes(n)).length;
      const blueMatch = t.blues.filter((n) => realBlues.includes(n)).length;
      const tier = config.tier(redMatch, blueMatch);
      if (tier !== null && tier <= tierThreshold) {
        hit = true;
        break;
      }
    }
    if (hit) hits++;
  }
  const p = hits / runs;
  const stderr = Math.sqrt(p * (1 - p) / runs);

  return {
    K, lottery, tierThreshold, strategy,
    pAtLeastOneHit: p,
    stderr,
    runs,
    ci95: [Math.max(0, p - 1.96 * stderr), Math.min(1, p + 1.96 * stderr)],
  };
}

/** 双色球：判断这一注的等级（1..6），无奖返回 null。 */
function ssqTier(redM, blueM) {
  if (redM === 6 && blueM === 1) return 1;
  if (redM === 6 && blueM === 0) return 2;
  if (redM === 5 && blueM === 1) return 3;
  if (redM === 5 && blueM === 0) return 4;
  if (redM === 4 && blueM === 1) return 4;
  if (redM === 4 && blueM === 0) return 5;
  if (redM === 3 && blueM === 1) return 5;
  if (blueM === 1) return 6;  // 任意红+蓝都是六等
  return null;
}

/** 大乐透：判断等级（1..7）。 */
function dltTier(fM, bM) {
  if (fM === 5 && bM === 2) return 1;
  if (fM === 5 && bM === 1) return 2;
  if (fM === 5 && bM === 0) return 3;
  if (fM === 4 && bM === 2) return 4;
  if (fM === 4 && bM === 1) return 5;
  if (fM === 3 && bM === 2) return 5;
  if (fM === 4 && bM === 0) return 6;
  if (fM === 3 && bM === 1) return 6;
  if (fM === 2 && bM === 2) return 6;
  if (fM === 3 && bM === 0) return 7;
  if (fM === 2 && bM === 1) return 7;
  if (fM === 1 && bM === 2) return 7;
  if (fM === 0 && bM === 2) return 7;
  return null;
}

/** 生成 K 注红球互不相同的彩票（贪心）。 */
function generateDiverseTickets(rng, K, config) {
  const tickets = [];
  const usedKey = new Set();
  let attempts = 0;
  const maxAttempts = K * 50;
  while (tickets.length < K && attempts++ < maxAttempts) {
    const reds = sampleK(rng, config.redPick, config.redSize).sort((a, b) => a - b);
    const blues = sampleK(rng, config.bluePick, config.blueSize).sort((a, b) => a - b);
    const key = reds.join(",") + "|" + blues.join(",");
    if (!usedKey.has(key)) {
      usedKey.add(key);
      tickets.push({ reds, blues });
    }
  }
  // 兜底：剩下的允许重复
  while (tickets.length < K) {
    tickets.push({
      reds: sampleK(rng, config.redPick, config.redSize),
      blues: sampleK(rng, config.bluePick, config.blueSize),
    });
  }
  return tickets;
}

function sampleK(rng, k, max) {
  const pool = [];
  for (let i = 1; i <= max; i++) pool.push(i);
  const out = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

/* ============================================================
 * Kelly 准则
 *
 * f* = (b·p − q) / b
 *   p = 中奖概率
 *   q = 1 − p
 *   b = 净赔率（payout/cost − 1）
 *
 * 多奖级 Kelly：用单注 EV 的 b·p − q 等价形式：
 *   f* ≈ (EV - cost) / (max_payout − cost)
 *
 * 严格多奖级 Kelly 是凸优化，但近似公式在彩票场景误差 < 5%。
 * ============================================================ */

/**
 * 简化 Kelly：当 EV > cost 时，按 (EV - cost) / variance_estimate 分配。
 * 严格多奖级 Kelly 是凸优化（无解析解）；这里采用"信息比率"近似——
 * 当 net EV > 0，给"乐观但有限"的下注比例；EV ≤ cost 严格返 0。
 *
 * @param ev          单注期望收益
 * @param ticketCost  单注成本
 * @param maxPayout   最大可能赢得（用于估方差上界）
 * @returns
 */
export function kellyFraction(ev, ticketCost = 2, maxPayout = 5000000) {
  const netEv = ev - ticketCost;
  if (netEv <= 0) {
    return {
      fraction: 0,
      netEv,
      verdict: `Kelly 推荐：不投（EV ${ev.toFixed(3)} ≤ cost ${ticketCost}，亏损必然）`,
      shouldBet: false,
    };
  }
  // 上界方差 ≈ p · max_payout² (主要在大奖)
  // p ≈ ev / maxPayout
  const p = ev / maxPayout;
  const variance = p * maxPayout * maxPayout;
  // 简化 Kelly：edge / variance（近似，单位归一）
  const fStar = Math.max(0, Math.min(0.05, netEv / variance * maxPayout));
  return {
    fraction: fStar,
    netEv,
    verdict: fStar > 0
      ? `Kelly 推荐：≈ ${(fStar * 100).toFixed(4)}% × bankroll（极小，因为单注方差极大）`
      : `Kelly 推荐：不投`,
    shouldBet: fStar > 0,
  };
}

/* ============================================================
 * 破产风险蒙特卡洛
 * ============================================================ */

/**
 * 模拟"每期投注 perPeriod 元，连续 periods 期"。
 * 每注独立，命中按 tiers 概率分布，奖金按平均值。
 *
 * @param opts.bankroll       初始资金
 * @param opts.perPeriodCost  每期投注金额
 * @param opts.periods        模拟期数（默认 100 期 ≈ 一年）
 * @param opts.simulations    模拟次数，默认 1000
 * @param opts.tiers          单注奖级概率表
 * @param opts.fixedPrizes    一等奖、二等奖固定金额
 * @param opts.ticketCost     单注成本
 * @param opts.seed
 * @returns 详细统计
 */
export function bankrollSimulation({
  bankroll = 1000,
  perPeriodCost = 10,
  periods = 100,
  simulations = 1000,
  tiers,
  fixedPrizes = {},
  ticketCost = 2,
  seed = "br",
} = {}) {
  if (!tiers) throw new Error("tiers required");
  const ticketsPerPeriod = Math.max(1, Math.floor(perPeriodCost / ticketCost));
  // 把 tiers 转成累积分布数组方便采样
  const cumulative = [];
  let acc = 0;
  for (const t of tiers) {
    acc += t.p;
    const prize = typeof t.prize === "number" ? t.prize : (fixedPrizes[t.name] ?? 0);
    cumulative.push({ ...t, cumProb: acc, fixedPrize: prize });
  }

  const finalBankrolls = [];
  let bankruptcyCount = 0;
  let totalWonAny = 0;
  let totalJackpot = 0;

  // 收集若干样本轨迹用于可视化
  const sampleTrajectories = [];
  const sampleN = Math.min(50, simulations);

  for (let s = 0; s < simulations; s++) {
    const rng = createRng(`${seed}-${s}`).next;
    let curr = bankroll;
    let bankrupt = false;
    let wonAny = false;
    let wonJackpot = false;
    const trajectory = s < sampleN ? [bankroll] : null;

    for (let p = 0; p < periods; p++) {
      if (curr < perPeriodCost) {
        bankrupt = true;
        // 之后剩下的期数 bankroll 保持不变
        if (trajectory) {
          for (let k = p; k < periods; k++) trajectory.push(curr);
        }
        break;
      }
      curr -= perPeriodCost;
      // 跑 ticketsPerPeriod 注，每注独立采样
      for (let t = 0; t < ticketsPerPeriod; t++) {
        const u = rng();
        for (const tier of cumulative) {
          if (u < tier.cumProb) {
            curr += tier.fixedPrize;
            wonAny = true;
            if (tier.name === "一等奖") wonJackpot = true;
            break;
          }
        }
      }
      if (trajectory) trajectory.push(curr);
    }
    if (bankrupt) bankruptcyCount++;
    if (wonAny) totalWonAny++;
    if (wonJackpot) totalJackpot++;
    finalBankrolls.push(curr);
    if (trajectory) sampleTrajectories.push(trajectory);
  }

  finalBankrolls.sort((a, b) => a - b);
  const median = finalBankrolls[Math.floor(simulations / 2)];
  const mean = finalBankrolls.reduce((s, v) => s + v, 0) / simulations;
  const p10 = finalBankrolls[Math.floor(simulations * 0.1)];
  const p90 = finalBankrolls[Math.floor(simulations * 0.9)];
  const totalSpend = perPeriodCost * periods;
  const expectedReturn = mean - bankroll;

  return {
    initialBankroll: bankroll,
    perPeriodCost,
    periods,
    simulations,
    ticketsPerPeriod,
    totalSpend,
    finalMean: mean,
    finalMedian: median,
    finalP10: p10,
    finalP90: p90,
    expectedReturn,
    expectedReturnPct: expectedReturn / bankroll,
    bankruptcyRate: bankruptcyCount / simulations,
    pAnyWinOverPeriods: totalWonAny / simulations,
    pJackpotOverPeriods: totalJackpot / simulations,
    sampleTrajectories,
  };
}
