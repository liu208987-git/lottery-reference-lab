// 双色球追号策略破产风险模拟器
//
// 与 dlt-chase.js 同构。中国彩民最大的"温水煮青蛙"误区：
//   连续买 N 期、想"补到中为止"。本模块用蒙特卡洛在完全 i.i.d. 假设下，
//   告诉用户：追 N 期破产概率有多高、最终资金分布、中过大奖的占比。
//
// 三种策略：
//   1. flat       每期固定 K 注 × 2 元
//   2. martingale 倍投：上期没中保本，下期翻倍（直到上限或破产）
//   3. kelly      凯利：bankroll 跌 50% 后停手（因为彩票 EV < 0，Kelly 推不出"投"）
//
// 关键诚实声明：
//   双色球预期回报永远 < 1，**Kelly 公式的最优解是 0 注**（不投是最优）。
//   这里实现 Kelly 不是为了"压住缩水"——而是让用户亲眼看到 Kelly 推导出"不投"。

import { hitClassProbability, classifyHit, SSQ_PRIZES } from "./ssq-prize.js";
import { createRng } from "./rng.js";

/** 给定一注与一期开奖，返回中奖等级和奖金。 */
export function ticketRevenue(ticket, draw, prizeBand = "expected") {
  const reds = ticket.reds || [];
  const blue = ticket.blue;
  const rHit = reds.filter((n) => draw.reds.includes(n)).length;
  const bHit = blue === draw.blue ? 1 : 0;
  const lv = classifyHit(rHit, bHit);
  if (lv === 0) return { level: 0, prize: 0 };
  const def = SSQ_PRIZES[lv - 1];
  const prize = def.type === "fixed" ? def.fixedPrize : def.estimateBands[prizeBand];
  return { level: lv, prize };
}

/**
 * 蒙特卡洛模拟：完全 i.i.d. 假设，每期独立按真实概率抽 6 个奖级。
 *
 * @param opts.runs              独立模拟次数（≥ 1000 推荐）
 * @param opts.draws             每次模拟的总期数
 * @param opts.ticketsPerDraw    每期注数
 * @param opts.bankroll          初始本金
 * @param opts.strategy          flat | martingale | kelly
 * @param opts.prizeBand         conservative | expected | aggressive
 * @param opts.seed
 */
export function simulateChase(opts = {}) {
  const {
    runs = 2000,
    draws = 50,
    ticketsPerDraw = 1,
    bankroll = 1000,
    strategy = "flat",
    prizeBand = "expected",
    martingaleBaseTickets = 1,
    martingaleCap = 32,
    seed = "ssq-chase",
  } = opts;

  const rngObj = createRng(seed);
  const rand = rngObj.next;

  // 预计算 6+1 个奖级的"分桶"概率（含未中奖）
  const prizes = SSQ_PRIZES.map((p) => ({
    level: p.level,
    prob: p.hits.reduce((s, h) => s + hitClassProbability(h.r, h.b), 0),
    payout: p.type === "fixed" ? p.fixedPrize : p.estimateBands[prizeBand],
  }));
  const noWinProb = 1 - prizes.reduce((s, p) => s + p.prob, 0);
  const buckets = [
    { level: 0, prob: noWinProb, payout: 0 },
    ...prizes,
  ];
  let acc = 0;
  const cum = buckets.map((b) => (acc += b.prob, { ...b, cum: acc }));

  const sampleOne = () => {
    const u = rand();
    for (const b of cum) if (u <= b.cum) return b;
    return cum[cum.length - 1];
  };

  const ruinAt = [];
  const finalBankroll = [];
  const everJackpot = [];
  const everSecond = [];
  const trajectories = [];

  for (let r = 0; r < runs; r++) {
    let bk = bankroll;
    let curTickets = ticketsPerDraw;
    let consecutiveLoss = 0;
    let ruined = false;
    let jackpot = false;
    let second = false;
    const path = r < 30 ? [bk] : null;

    for (let i = 0; i < draws; i++) {
      const cost = 2 * curTickets;
      if (bk < cost) { ruined = true; ruinAt.push(i); break; }
      bk -= cost;
      let revenue = 0;
      let bestLevel = 0;
      for (let t = 0; t < curTickets; t++) {
        const result = sampleOne();
        revenue += result.payout;
        if (result.level > 0 && (bestLevel === 0 || result.level < bestLevel)) bestLevel = result.level;
        if (result.level === 1) jackpot = true;
        if (result.level === 2) second = true;
      }
      bk += revenue;
      if (strategy === "martingale") {
        if (bestLevel === 0) {
          consecutiveLoss++;
          curTickets = Math.min(martingaleCap, martingaleBaseTickets * (2 ** consecutiveLoss));
        } else {
          consecutiveLoss = 0;
          curTickets = martingaleBaseTickets;
        }
      } else if (strategy === "kelly") {
        if (bk < bankroll * 0.5) curTickets = 0;
        else curTickets = ticketsPerDraw;
      }
      if (path) path.push(bk);
    }
    if (!ruined) ruinAt.push(null);
    finalBankroll.push(bk);
    everJackpot.push(jackpot);
    everSecond.push(second);
    if (path) trajectories.push(path);
  }

  const ruinedCount = ruinAt.filter((x) => x !== null).length;
  return {
    runs,
    draws,
    strategy,
    bankroll,
    ticketsPerDraw,
    prizeBand,
    seed: rngObj.seed,
    ruinProb: ruinedCount / runs,
    ruinAt,
    finalBankroll,
    finalMean: avg(finalBankroll),
    finalMedian: median(finalBankroll),
    finalP05: percentile(finalBankroll, 0.05),
    finalP95: percentile(finalBankroll, 0.95),
    everJackpotProb: everJackpot.filter(Boolean).length / runs,
    everSecondProb: everSecond.filter(Boolean).length / runs,
    trajectories,
  };
}

function avg(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function median(a) { return percentile(a, 0.5); }
function percentile(a, p) {
  const sorted = [...a].sort((x, y) => x - y);
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}
