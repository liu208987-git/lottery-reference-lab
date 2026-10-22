import { clamp } from "./utils.js";
import { DLT_CONFIG } from "./lottery-config.js";
import { zoneFreq } from "./lottery-stats.js";
import { generateDltTickets } from "./dlt-generator.js";
import { generateDltAdvanced } from "./dlt-advanced-sampler.js";

const FRONT_SIZE = DLT_CONFIG.zones[0].size;
const FRONT_PICK = DLT_CONFIG.zones[0].pick;
const BACK_SIZE = DLT_CONFIG.zones[1].size;
const BACK_PICK = DLT_CONFIG.zones[1].pick;
const TICKET_PRICE = 2;
const JACKPOT_PROBABILITY = DLT_CONFIG.jackpotProbability || (1 / 21425712);

export function scoreDltTicket(ticket, draw) {
  const frontSet = new Set(draw.front);
  const backSet = new Set(draw.back);
  const frontMatched = ticket.front.filter((n) => frontSet.has(n)).sort((a, b) => a - b);
  const backMatched = ticket.back.filter((n) => backSet.has(n)).sort((a, b) => a - b);
  const frontHits = frontMatched.length;
  const backHits = backMatched.length;

  return {
    frontHits,
    backHits,
    hitClass: `${frontHits}+${backHits}`,
    frontMatched,
    backMatched,
  };
}

export function theoreticalDltHitBaseline() {
  return {
    frontAvgPerTicket: (FRONT_PICK * FRONT_PICK) / FRONT_SIZE,
    backAvgPerTicket: (BACK_PICK * BACK_PICK) / BACK_SIZE,
    jackpotProbability: JACKPOT_PROBABILITY,
  };
}

export function summarizeDltBacktest(records, options = {}) {
  const totalTickets = records.length;
  const ticketPrice = options.ticketPrice || TICKET_PRICE;
  const baseline = theoreticalDltHitBaseline();
  const hitDistribution = createHitDistribution();
  let frontSum = 0;
  let backSum = 0;
  let best = null;

  for (const r of records) {
    hitDistribution[r.hitClass] = (hitDistribution[r.hitClass] || 0) + 1;
    frontSum += r.frontHits;
    backSum += r.backHits;
    if (!best || compareHitRecord(r, best) > 0) best = r;
  }

  const avgFrontHits = totalTickets ? frontSum / totalTickets : 0;
  const avgBackHits = totalTickets ? backSum / totalTickets : 0;

  return {
    rounds: options.rounds || 0,
    ticketsPerDraw: options.ticketsPerDraw || 0,
    totalTickets,
    costYuan: totalTickets * ticketPrice,
    avgFrontHits,
    avgBackHits,
    frontLiftVsRandom: baseline.frontAvgPerTicket ? avgFrontHits / baseline.frontAvgPerTicket : 0,
    backLiftVsRandom: baseline.backAvgPerTicket ? avgBackHits / baseline.backAvgPerTicket : 0,
    hitDistribution,
    best,
    baseline,
    notableCount: records.filter((r) => r.frontHits >= 3 || (r.frontHits >= 2 && r.backHits >= 1)).length,
    jackpotHits: records.filter((r) => r.frontHits === FRONT_PICK && r.backHits === BACK_PICK).length,
  };
}

export function runDltBacktest(draws, options = {}) {
  const lookback = clamp(Number(options.lookback || 200), 2, Math.max(2, draws.length - 1));
  const requestedRounds = clamp(Number(options.rounds || 80), 1, Math.max(1, draws.length - lookback));
  const ticketsPerDraw = clamp(Number(options.ticketsPerDraw || 5), 1, 20);
  const method = options.method || "bayes-dpp";
  const constraints = options.constraints || {};
  const seed = options.seed || `dlt-backtest-${method}`;
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
      const score = scoreDltTicket(t, target);
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
    summary: summarizeDltBacktest(records, { rounds: actualRounds, ticketsPerDraw }),
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
  const freqFront = zoneFreq(history, DLT_CONFIG.zones[0]);
  const freqBack = zoneFreq(history, DLT_CONFIG.zones[1]);

  if (method === "legacy-hot" || method === "legacy-mix" || method === "legacy-uniform") {
    const strategyFront = method === "legacy-hot" ? "hot" : method === "legacy-uniform" ? "uniform" : "mix";
    const strategyBack = method === "legacy-uniform" ? "uniform" : "hot";
    return generateDltTickets({
      freqFront,
      freqBack,
      strategyFront,
      strategyBack,
      alpha: method === "legacy-uniform" ? 0 : 0.9,
      constraints,
      count: ticketsPerDraw,
      optimize: "diverse",
      rand: seededRandom(seed),
    }).tickets;
  }

  const advancedMethod = method === "thompson" || method === "mcmc" ? method : "bayes-dpp";
  return generateDltAdvanced({
    freqFront,
    freqBack,
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
  for (let f = 0; f <= FRONT_PICK; f++) {
    for (let b = 0; b <= BACK_PICK; b++) out[`${f}+${b}`] = 0;
  }
  return out;
}

function compareHitRecord(a, b) {
  const aw = a.frontHits * 10 + a.backHits;
  const bw = b.frontHits * 10 + b.backHits;
  if (aw !== bw) return aw - bw;
  return String(b.issue).localeCompare(String(a.issue));
}

function seededRandom(seed) {
  let h = 2166136261;
  const s = String(seed || "dlt-backtest");
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
