// 追号策略破产风险模拟器
//
// 中国彩民最大的"温水煮青蛙"误区：连续买 N 期、想"补到中为止"。
// 本模块用蒙特卡洛 + 历史回放两种方式，告诉用户：
//   - 在"完全独立同分布"假设下，追 N 期破产概率有多高
//   - 在历史 N 期回放下，等额追/倍投/Kelly 三种策略的资金曲线
//
// 三种策略：
//   1. flat       每期固定 K 注 × 2 元 = 2K 元
//   2. martingale 倍投：上期没中保本，下期翻倍（直到上限或破产）
//   3. kelly      凯利 1/4 仓：bet = bankroll × 0.25 × edge / odds（edge 永远负，所以等价于"少买"）
//
// 关键诚实声明：
//   彩票的预期回报永远 < 1，**Kelly 公式的最优解是 0 注**（不投是最优）。
//   这里实现 Kelly 不是为了"压住缩水"——而是让用户亲眼看到 Kelly 推导出"不投"。

import { hitClassProbability, classifyHit, DLT_PRIZES } from "./dlt-prize.js";
import { createRng } from "./rng.js";

/** 给定一注与一期开奖，返回中奖等级和奖金（用 expected band）。 */
export function ticketRevenue(ticket, draw, prizeBand = "expected") {
  const front = ticket.front || ticket.reds || [];
  const back = ticket.back || [];
  const fHit = front.filter((n) => draw.front.includes(n)).length;
  const bHit = back.filter((n) => draw.back.includes(n)).length;
  const lv = classifyHit(fHit, bHit);
  if (lv === 0) return { level: 0, prize: 0 };
  const def = DLT_PRIZES[lv - 1];
  const prize = def.type === "fixed" ? def.fixedPrize : def.estimateBands[prizeBand];
  return { level: lv, prize };
}

/**
 * 蒙特卡洛模拟：完全 i.i.d. 假设下，每期独立按真实概率掷 9 个奖级。
 * 不需要历史数据——直接按理论概率分布抽。
 *
 * @param opts.runs        独立模拟次数（≥ 1000 推荐）
 * @param opts.draws       每次模拟的总期数
 * @param opts.ticketsPerDraw  每期注数
 * @param opts.bankroll    初始本金
 * @param opts.strategy    flat | martingale | kelly
 * @param opts.prizeBand   conservative | expected | aggressive
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
    seed = "chase",
  } = opts;

  const rngObj = createRng(seed);
  const rand = rngObj.next;

  // 预计算 9+1 个奖级的"分桶"概率（含未中奖）
  const prizes = DLT_PRIZES.map((p) => ({
    level: p.level,
    prob: p.hits.reduce((s, h) => s + hitClassProbability(h.f, h.b), 0),
    payout: p.type === "fixed" ? p.fixedPrize : p.estimateBands[prizeBand],
  }));
  const noWinProb = 1 - prizes.reduce((s, p) => s + p.prob, 0);
  const buckets = [
    { level: 0, prob: noWinProb, payout: 0 },
    ...prizes,
  ];
  // 累积分布
  let acc = 0;
  const cum = buckets.map((b) => (acc += b.prob, { ...b, cum: acc }));

  const sampleOne = () => {
    const u = rand();
    for (const b of cum) if (u <= b.cum) return b;
    return cum[cum.length - 1];
  };

  // 三个统计：破产期数分布、最终 bankroll 分布、是否中过大奖
  const ruinAt = []; // null 或 i
  const finalBankroll = [];
  const everJackpot = [];
  const everSecond = [];
  const trajectories = []; // 仅前 N 条用于绘图

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
      // 每注独立抽
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
      // 策略调整
      if (strategy === "martingale") {
        if (bestLevel === 0) {
          consecutiveLoss++;
          curTickets = Math.min(martingaleCap, martingaleBaseTickets * (2 ** consecutiveLoss));
        } else {
          consecutiveLoss = 0;
          curTickets = martingaleBaseTickets;
        }
      } else if (strategy === "kelly") {
        // 凯利：f* = (bp - q) / b，b = (avg payout) / cost
        // 因为 EV < cost，f* < 0，最优是不投。我们让 ticketsPerDraw 保持 1 但若 bankroll < 阈值就停手。
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
