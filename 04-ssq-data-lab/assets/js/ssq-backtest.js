// 双色球历史回测（Walk-forward audit）
//
// 与 dlt-backtest.js 同构。每轮只用目标期之前的历史窗口生成号码，
// 与下一期开奖对照，避免偷看未来数据。
//
// 输出：每注的命中型态 + 总览统计 + 命中分布矩阵 + 最好轮次。

import { clamp } from "./utils.js";
import { freqFromDraws, RED_MAX, BLUE_MAX } from "./stats.js";
import { generateTickets } from "./generator.js";
import { generateAdvanced } from "./advanced-sampler.js";

const RED_SIZE = 33;
const RED_PICK = 6;
const BLUE_SIZE = 16;
const BLUE_PICK = 1;
const TICKET_PRICE = 2;
const JACKPOT_PROBABILITY = 1 / 17721088;

export function scoreSsqTicket(ticket, draw) {
  const redSet = new Set(draw.reds);
  const redMatched = ticket.reds.filter((n) => redSet.has(n)).sort((a, b) => a - b);
  const blueHit = ticket.blue === draw.blue ? 1 : 0;
  const redHits = redMatched.length;
  return {
    redHits,
    blueHits: blueHit,
    hitClass: `${redHits}+${blueHit}`,
    redMatched,
    blueMatched: blueHit ? [draw.blue] : [],
  };
}

export function theoreticalSsqHitBaseline() {
  return {
    redAvgPerTicket: (RED_PICK * RED_PICK) / RED_SIZE,   // = 1.0909
    blueAvgPerTicket: (BLUE_PICK * BLUE_PICK) / BLUE_SIZE, // = 0.0625
    jackpotProbability: JACKPOT_PROBABILITY,
  };
}

export function summarizeSsqBacktest(records, options = {}) {
  const totalTickets = records.length;
  const ticketPrice = options.ticketPrice || TICKET_PRICE;
  const baseline = theoreticalSsqHitBaseline();
  const hitDistribution = createHitDistribution();
  let redSum = 0;
  let blueSum = 0;
  let best = null;

  for (const r of records) {
    hitDistribution[r.hitClass] = (hitDistribution[r.hitClass] || 0) + 1;
    redSum += r.redHits;
    blueSum += r.blueHits;
    if (!best || compareHitRecord(r, best) > 0) best = r;
  }

  const avgRedHits = totalTickets ? redSum / totalTickets : 0;
  const avgBlueHits = totalTickets ? blueSum / totalTickets : 0;

  return {
    rounds: options.rounds || 0,
    ticketsPerDraw: options.ticketsPerDraw || 0,
    totalTickets,
    costYuan: totalTickets * ticketPrice,
    avgRedHits,
    avgBlueHits,
    redLiftVsRandom: baseline.redAvgPerTicket ? avgRedHits / baseline.redAvgPerTicket : 0,
    blueLiftVsRandom: baseline.blueAvgPerTicket ? avgBlueHits / baseline.blueAvgPerTicket : 0,
    hitDistribution,
    best,
    baseline,
    notableCount: records.filter((r) => r.redHits >= 4 || (r.redHits >= 3 && r.blueHits >= 1)).length,
    jackpotHits: records.filter((r) => r.redHits === RED_PICK && r.blueHits === BLUE_PICK).length,
  };
}

export function runSsqBacktest(draws, options = {}) {
  const lookback = clamp(Number(options.lookback || 200), 2, Math.max(2, draws.length - 1));
  const requestedRounds = clamp(Number(options.rounds || 80), 1, Math.max(1, draws.length - lookback));
  const ticketsPerDraw = clamp(Number(options.ticketsPerDraw || 5), 1, 20);
  const method = options.method || "bayes-dpp";
  const constraints = options.constraints || {};
  const seed = options.seed || `ssq-backtest-${method}`;
  const sampler = options.sampler || defaultBacktestSampler;
  const startIndex = Math.max(lookback, draws.length - requestedRounds);
  const records = [];
  let actualRounds = 0;

  for (let i = startIndex; i < draws.length; i++) {
    const history = draws.slice(Math.max(0, i - lookback), i);
    if (!history.length) continue;
    const target = draws[i];
    const roundIndex = actualRounds;
    const tickets = sampler({
      history,
      target,
      index: i,
      roundIndex,
      method,
      ticketsPerDraw,
      constraints,
      seed: `${seed}:${target.issue}:${roundIndex}`,
    }).slice(0, ticketsPerDraw);

    tickets.forEach((t, ticketIndex) => {
      const score = scoreSsqTicket(t, target);
      records.push({
        issue: target.issue,
        date: target.date || "",
        target,
        ticket: t,
        ticketIndex,
        ...score,
      });
    });
    actualRounds++;
  }

  return {
    records,
    summary: summarizeSsqBacktest(records, { rounds: actualRounds, ticketsPerDraw }),
    options: {
      lookback,
      rounds: actualRounds,
      ticketsPerDraw,
      method,
      constraints,
      seed,
    },
  };
}

function defaultBacktestSampler({
  history,
  method,
  ticketsPerDraw,
  constraints,
  seed,
}) {
  const freqR = freqFromDraws(history, "reds", RED_SIZE);
  const freqB = freqFromDraws(history, "blue", BLUE_SIZE);

  if (method === "legacy-hot" || method === "legacy-mix" || method === "legacy-uniform") {
    const strategyRed = method === "legacy-hot" ? "hot" : method === "legacy-uniform" ? "uniform" : "mix";
    const strategyBlue = method === "legacy-uniform" ? "uniform" : "hot";
    return generateTickets({
      freqR,
      freqB,
      strategyRed,
      strategyBlue,
      alpha: method === "legacy-uniform" ? 0 : 0.9,
      constraints,
      count: ticketsPerDraw,
      optimize: "diverse",
      rand: seededRandom(seed),
    }).tickets;
  }

  const advancedMethod = method === "thompson" || method === "mcmc" ? method : "bayes-dpp";
  return generateAdvanced({
    freqR,
    freqB,
    totalDraws: history.length,
    method: advancedMethod,
    count: ticketsPerDraw,
    constraints,
    seed,
    mcmcIterations: 1600,
    mcmcBurnIn: 400,
    mcmcThin: 4,
    mcmcChains: 2,
  }).tickets;
}

function createHitDistribution() {
  const out = {};
  for (let r = 0; r <= RED_PICK; r++) {
    for (let b = 0; b <= BLUE_PICK; b++) out[`${r}+${b}`] = 0;
  }
  return out;
}

function compareHitRecord(a, b) {
  // 排序权重：红命中数 × 10 + 蓝命中（与 DLT 同构）
  const aw = a.redHits * 10 + a.blueHits;
  const bw = b.redHits * 10 + b.blueHits;
  if (aw !== bw) return aw - bw;
  return String(b.issue).localeCompare(String(a.issue));
}

function seededRandom(seed) {
  let h = 2166136261;
  const s = String(seed || "ssq-backtest");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6D2B79F5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
