import {
  passesConstraints,
  analyseConstraintFailures,
  spanOf,
  oddCountOf,
  consecutiveGroupsOf,
} from "./stats.js";

export function makeWeightsFromFreq(freq, strategy, alpha) {
  const size = freq.length - 1;
  const maxF = Math.max(...freq.slice(1));
  const w = [];
  for (let n = 1; n <= size; n++) {
    const f = freq[n];
    let base = 1;
    if (strategy === "hot") base = f + 1;
    else if (strategy === "cold") base = maxF - f + 1;
    w.push(Math.pow(base, alpha));
  }
  return w;
}

// 真正的"混合"：几何平均。hot 极端高 / cold 极端高的号码都会被抑制，
// 让中等频次的号码有机会被采到，更符合"混合"直觉。
export function makeMixedWeights(freq, alpha) {
  const wHot = makeWeightsFromFreq(freq, "hot", alpha);
  const wCold = makeWeightsFromFreq(freq, "cold", alpha);
  return wHot.map((h, i) => Math.sqrt(h * wCold[i]));
}

export function weightedPickOne(items, weights, rand = Math.random) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(rand() * items.length)];
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export function weightedSampleWithoutReplacement(items, weights, k, rand = Math.random) {
  if (k > items.length) throw new Error(`cannot sample ${k} from ${items.length}`);
  const pool = items.slice();
  const pw = weights.slice();
  const out = [];
  for (let i = 0; i < k; i++) {
    const picked = weightedPickOne(pool, pw, rand);
    out.push(picked);
    const idx = pool.indexOf(picked);
    pool.splice(idx, 1);
    pw.splice(idx, 1);
  }
  return out;
}

function buildRedPool({ include = [], exclude = [], avoidLast = [] }) {
  const includeSet = new Set(include);
  const excludeSet = new Set([...exclude, ...avoidLast]);
  // include 与 exclude 冲突时以 include 优先
  for (const n of includeSet) excludeSet.delete(n);
  const pool = [];
  for (let n = 1; n <= 33; n++) {
    if (includeSet.has(n)) continue;
    if (excludeSet.has(n)) continue;
    pool.push(n);
  }
  return { pool, includeList: [...includeSet].sort((a, b) => a - b) };
}

function subsetWeights(sourceWeights, pool) {
  // sourceWeights[0..32] 对应号码 1..33；pool 是实际候选号码列表
  return pool.map((n) => sourceWeights[n - 1]);
}

function maxSameTailOf(reds) {
  const tails = Array(10).fill(0);
  for (const r of reds) tails[r % 10]++;
  return Math.max(...tails);
}

function hasArithmeticPattern(reds) {
  const set = new Set(reds);
  for (let i = 0; i < reds.length; i++) {
    for (let j = i + 1; j < reds.length; j++) {
      const step = reds[j] - reds[i];
      if (step <= 0) continue;
      let run = 2;
      let next = reds[j] + step;
      while (set.has(next)) {
        run++;
        next += step;
      }
      if (run >= 4) return true;
    }
  }
  return false;
}

export function crowdPenalty(reds, blue) {
  let penalty = 0;
  const birthdayReds = reds.filter((n) => n <= 31).length;
  const smallDateReds = reds.filter((n) => n <= 12).length;
  const odd = oddCountOf(reds);
  const big = reds.filter((n) => n > 16).length;
  const tailMax = maxSameTailOf(reds);
  const consecutiveGroups = consecutiveGroupsOf(reds);

  if (birthdayReds === 6) penalty += 2;
  if (smallDateReds >= 4) penalty += smallDateReds - 2;
  if (tailMax >= 3) penalty += (tailMax - 2) * 2;
  if (consecutiveGroups >= 2) penalty += consecutiveGroups * 2;
  if (spanOf(reds) < 18) penalty += 2;
  if (odd === 0 || odd === 6) penalty += 3;
  if (big === 0 || big === 6) penalty += 3;
  if (hasArithmeticPattern(reds)) penalty += 3;
  if ([6, 8, 9, 16].includes(blue)) penalty += 1;

  return penalty;
}

export function coveragePenalty(ticket, existingTickets) {
  let penalty = 0;
  for (const existing of existingTickets) {
    const overlap = ticket.reds.filter((n) => existing.reds.includes(n)).length;
    if (overlap >= 3) penalty += (overlap - 2) * 3;
    if (ticket.blue === existing.blue) penalty += 1;
  }
  return penalty;
}

export function scoreTicket(ticket, existingTickets = [], optimize = "none") {
  if (optimize !== "diverse") return 0;
  return -(crowdPenalty(ticket.reds, ticket.blue) + coveragePenalty(ticket, existingTickets));
}

export function generateTickets({
  freqR,
  freqB,
  strategyRed,
  strategyBlue,
  alpha,
  constraints,
  count,
  includeRed = [],
  excludeRed = [],
  avoidLast = [],
  excludeBlue = [],
  optimize = "none",
  candidateBatch = 40,
  maxTry = 2000,
  rand = Math.random,
}) {
  const { pool, includeList } = buildRedPool({ include: includeRed, exclude: excludeRed, avoidLast });
  if (includeList.length > 6) {
    throw new Error(`胆码不能超过 6 个（当前 ${includeList.length}）`);
  }
  const needToPick = 6 - includeList.length;
  if (pool.length < needToPick) {
    throw new Error(`排除过多：还需抽 ${needToPick} 个但只剩 ${pool.length} 个候选`);
  }

  const blueItems = [];
  for (let n = 1; n <= 16; n++) if (!excludeBlue.includes(n)) blueItems.push(n);
  if (blueItems.length === 0) throw new Error("所有蓝球都被排除了");

  const tickets = [];
  const failureReasons = Object.create(null);
  let tries = 0;

  const sourceW = strategyRed === "mix"
    ? makeMixedWeights(freqR, alpha)
    : makeWeightsFromFreq(freqR, strategyRed, alpha);
  const wBSource = makeWeightsFromFreq(freqB, strategyBlue, alpha);
  const wB = blueItems.map((n) => wBSource[n - 1]);

  const makeCandidate = () => {
    tries++;
    const picked = needToPick === 0
      ? []
      : weightedSampleWithoutReplacement(pool, subsetWeights(sourceW, pool), needToPick, rand);
    const reds = [...includeList, ...picked].sort((a, b) => a - b);
    const blue = weightedPickOne(blueItems, wB, rand);

    if (!passesConstraints(reds, constraints)) {
      for (const reason of analyseConstraintFailures(reds, constraints)) {
        failureReasons[reason] = (failureReasons[reason] || 0) + 1;
      }
      return null;
    }
    const key = `${reds.join(",")}|${blue}`;
    if (tickets.some((t) => t.key === key)) return null;
    return { key, reds, blue };
  };

  while (tickets.length < count && tries < maxTry) {
    if (optimize !== "diverse") {
      const candidate = makeCandidate();
      if (candidate) tickets.push(candidate);
      continue;
    }

    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < candidateBatch && tries < maxTry; i++) {
      const candidate = makeCandidate();
      if (!candidate) continue;
      const score = scoreTicket(candidate, tickets, optimize);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best) tickets.push(best);
  }

  return { tickets, tries, failureReasons };
}
