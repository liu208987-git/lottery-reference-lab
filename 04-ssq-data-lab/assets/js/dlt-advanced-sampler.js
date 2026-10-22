// 大乐透高级采样器：Bayes / Thompson / DPP / MCMC 全套
//
// 与双色球版本同构，但前区从 6 选 33 变成 5 选 35，后区从 1 选 16 变成 2 选 12。

import { posteriorParams, posteriorMean } from "./bayes.js";
import { buildLKernel, greedyKDPP, logDetSubmatrix } from "./dpp.js";
import { runChain, effectiveSampleSize, gelmanRubin, autocorrelation } from "./mcmc.js";
import {
  passesDltConstraints,
  analyseDltConstraintFailures,
  FRONT_SIZE,
  FRONT_PICK,
  BACK_SIZE,
  BACK_PICK,
} from "./dlt-distribution.js";
import { dltCrowdPenalty } from "./dlt-generator.js";
import {
  ticketsToFreqDist,
  jsDistance,
  wassersteinDistance,
  samplingQualityScore,
  normalize,
} from "./distance.js";
import { createRng, makeBetaSampler } from "./rng.js";
import { logDetSubmatrix as logDet } from "./dpp.js";

/** 大乐透前区先验：5/35 平均，等效观测 = 35（弱先验）。 */
export const FRONT_PRIOR = { alpha0: 5, beta0: 30 };
/** 大乐透后区先验：2/12 平均，等效观测 = 12。 */
export const BACK_PRIOR = { alpha0: 2, beta0: 10 };

export function generateDltAdvanced({
  freqFront,
  freqBack,
  totalDraws,
  method = "bayes-dpp",
  count = 5,
  constraints = {},
  includeFront = [],
  excludeFront = [],
  avoidLastFront = [],
  includeBack = [],
  excludeBack = [],
  avoidLastBack = [],
  // 算法超参
  tau = 7,
  lambdaDiv = 0.5,
  lambdaCstr = 5,
  lambdaCrowd = 0.3,
  mcmcIterations = 4000,
  mcmcBurnIn = 1000,
  mcmcThin = 4,
  mcmcChains = 3,
  seed = null,
}) {
  const rngObj = createRng(seed);
  const rand = rngObj.next;
  const betaSample = makeBetaSampler(rand);

  // 1) 候选池
  const includeF = new Set(includeFront);
  const excludeF = new Set([...excludeFront, ...avoidLastFront]);
  for (const n of includeF) excludeF.delete(n);
  if (includeF.size > FRONT_PICK) throw new Error(`前区胆码不能超过 ${FRONT_PICK} 个（当前 ${includeF.size}）`);
  const poolF = [];
  for (let n = 1; n <= FRONT_SIZE; n++) {
    if (includeF.has(n) || excludeF.has(n)) continue;
    poolF.push(n);
  }
  const includeListF = [...includeF].sort((a, b) => a - b);
  const needF = FRONT_PICK - includeListF.length;
  if (poolF.length < needF) throw new Error(`前区排除过多：还需 ${needF} 个但只剩 ${poolF.length}`);

  const includeB = new Set(includeBack);
  const excludeB = new Set([...excludeBack, ...avoidLastBack]);
  for (const n of includeB) excludeB.delete(n);
  if (includeB.size > BACK_PICK) throw new Error(`后区胆码不能超过 ${BACK_PICK} 个（当前 ${includeB.size}）`);
  const poolB = [];
  for (let n = 1; n <= BACK_SIZE; n++) {
    if (includeB.has(n) || excludeB.has(n)) continue;
    poolB.push(n);
  }
  const includeListB = [...includeB].sort((a, b) => a - b);
  const needB = BACK_PICK - includeListB.length;
  if (poolB.length < needB) throw new Error(`后区排除过多：还需 ${needB} 个但只剩 ${poolB.length}`);

  // 2) 贝叶斯后验
  const frontParams = posteriorParams(freqFront, totalDraws, FRONT_PRIOR);
  const backParams = posteriorParams(freqBack, totalDraws, BACK_PRIOR);

  // 3) 分发
  let tickets = [];
  let methodDiag = {};
  if (method === "thompson") {
    ({ tickets, methodDiag } = runThompson({
      frontParams, backParams, poolF, poolB, includeListF, includeListB,
      needF, needB, count, constraints, betaSample, rand,
    }));
  } else if (method === "mcmc") {
    ({ tickets, methodDiag } = runMcmcDlt({
      frontParams, backParams, poolF, poolB, includeListF, includeListB,
      needF, needB, count, constraints,
      tau, lambdaDiv, lambdaCstr, lambdaCrowd,
      iterations: mcmcIterations, burnIn: mcmcBurnIn, thin: mcmcThin, chains: mcmcChains,
      rand, betaSample,
    }));
  } else {
    ({ tickets, methodDiag } = runBayesDPP({
      frontParams, backParams, poolF, poolB, includeListF, includeListB,
      needF, needB, count, constraints, tau, betaSample, rand,
    }));
  }

  // 4) 后处理：与目标分布的距离
  const observed = ticketsToFrontFreqDist(tickets, FRONT_SIZE);
  const targetMeans = Array(FRONT_SIZE + 1).fill(0);
  let s = 0;
  for (let i = 1; i <= FRONT_SIZE; i++) {
    targetMeans[i] = posteriorMean(frontParams[i]);
    s += targetMeans[i];
  }
  for (let i = 1; i <= FRONT_SIZE; i++) targetMeans[i] /= s;
  const target = [0, ...targetMeans.slice(1)];

  const js = jsDistance(observed.slice(1), target.slice(1));
  const w1 = wassersteinDistance(observed.slice(1), target.slice(1));
  const score = samplingQualityScore(observed.slice(1), target.slice(1));

  return {
    tickets,
    diagnostics: {
      method,
      seed: rngObj.seed,
      ...methodDiag,
      jsDistance: js,
      wasserstein: w1,
      qualityScore: score,
      poolSize: poolF.length,
      poolBackSize: poolB.length,
      pinned: includeListF,
      pinnedBack: includeListB,
    },
  };
}

/* ===========================================================
 *  ticket → 前区频率分布
 * =========================================================== */
function ticketsToFrontFreqDist(tickets, size) {
  const f = Array(size + 1).fill(0);
  for (const t of tickets) for (const n of t.front) f[n] += 1;
  const slice = f.slice(1);
  return [0, ...normalize(slice)];
}

/* ===========================================================
 *  1. Thompson Sampling
 * =========================================================== */
function runThompson({
  frontParams, backParams, poolF, poolB, includeListF, includeListB,
  needF, needB, count, constraints, betaSample, rand,
}) {
  const tickets = [];
  const failureReasons = Object.create(null);
  const seen = new Set();
  let tries = 0;
  const maxTry = count * 200;

  while (tickets.length < count && tries < maxTry) {
    tries++;
    const wF = Array(FRONT_SIZE + 1).fill(0);
    for (let i = 1; i <= FRONT_SIZE; i++) wF[i] = betaSample(frontParams[i].alpha, frontParams[i].beta);
    const wB = Array(BACK_SIZE + 1).fill(0);
    for (let i = 1; i <= BACK_SIZE; i++) wB[i] = betaSample(backParams[i].alpha, backParams[i].beta);

    const front = sampleSubsetByWeights(poolF, wF, needF, rand, includeListF);
    const back = sampleSubsetByWeights(poolB, wB, needB, rand, includeListB);
    if (front.length !== FRONT_PICK || back.length !== BACK_PICK) continue;

    if (!passesDltConstraints(front, constraints)) {
      for (const r of analyseDltConstraintFailures(front, constraints)) {
        failureReasons[r] = (failureReasons[r] || 0) + 1;
      }
      continue;
    }
    const key = `${front.join(",")}|${back.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);

    tickets.push({
      key, front, back,
      score: -negLogLikelihoodFromMean(front, frontParams),
      diagnostics: {
        constraintViolations: 0,
        crowdPenalty: dltCrowdPenalty(front, back),
      },
    });
  }
  return {
    tickets,
    methodDiag: { tries, failureReasons, samplerLabel: "Thompson Sampling (Beta posterior)" },
  };
}

/* ===========================================================
 *  2. Bayes + DPP（默认）
 * =========================================================== */
function runBayesDPP({
  frontParams, backParams, poolF, poolB, includeListF, includeListB,
  needF, needB, count, constraints, tau, betaSample, rand,
}) {
  const tickets = [];
  const failureReasons = Object.create(null);
  const seen = new Set();
  let tries = 0;
  const maxTry = count * 300;

  while (tickets.length < count && tries < maxTry) {
    tries++;
    const q = Array(FRONT_SIZE + 1).fill(0);
    for (let i = 1; i <= FRONT_SIZE; i++) q[i] = betaSample(frontParams[i].alpha, frontParams[i].beta);
    const qMasked = q.slice();
    for (let i = 1; i <= FRONT_SIZE; i++) {
      if (!poolF.includes(i) && !includeListF.includes(i)) qMasked[i] = 0;
    }
    const L = buildLKernel(qMasked, { tau, size: FRONT_SIZE });
    const front = greedyKDPP(L, FRONT_PICK, { pool: poolF, pinned: includeListF, size: FRONT_SIZE });
    if (front.length !== FRONT_PICK) continue;

    // 后区也用 DPP，避免类似 (1,2) 这种紧邻
    const qB = Array(BACK_SIZE + 1).fill(0);
    for (let i = 1; i <= BACK_SIZE; i++) qB[i] = betaSample(backParams[i].alpha, backParams[i].beta);
    const qBMasked = qB.slice();
    for (let i = 1; i <= BACK_SIZE; i++) {
      if (!poolB.includes(i) && !includeListB.includes(i)) qBMasked[i] = 0;
    }
    const LB = buildLKernel(qBMasked, { tau: 3, size: BACK_SIZE });
    const back = greedyKDPP(LB, BACK_PICK, { pool: poolB, pinned: includeListB, size: BACK_SIZE });
    if (back.length !== BACK_PICK) continue;

    if (!passesDltConstraints(front, constraints)) {
      for (const r of analyseDltConstraintFailures(front, constraints)) {
        failureReasons[r] = (failureReasons[r] || 0) + 1;
      }
      continue;
    }
    const key = `${front.join(",")}|${back.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const ld = logDetSubmatrix(L, front);
    tickets.push({
      key, front, back,
      score: ld - negLogLikelihoodFromMean(front, frontParams),
      diagnostics: {
        logDet: ld,
        constraintViolations: 0,
        crowdPenalty: dltCrowdPenalty(front, back),
      },
    });
  }
  return {
    tickets,
    methodDiag: { tries, failureReasons, samplerLabel: "Bayes posterior × DPP greedy MAP" },
  };
}

/* ===========================================================
 *  3. MCMC Metropolis-Hastings（多链）
 * =========================================================== */
function runMcmcDlt({
  frontParams, backParams, poolF, poolB, includeListF, includeListB,
  needF, needB, count, constraints,
  tau, lambdaDiv, lambdaCstr, lambdaCrowd,
  iterations, burnIn, thin, chains,
  rand, betaSample,
}) {
  const logQuality = Array(FRONT_SIZE + 1).fill(-Infinity);
  for (let i = 1; i <= FRONT_SIZE; i++) {
    const m = posteriorMean(frontParams[i]);
    logQuality[i] = Math.log(Math.max(1e-9, m));
  }
  const q = Array(FRONT_SIZE + 1).fill(0);
  for (let i = 1; i <= FRONT_SIZE; i++) q[i] = posteriorMean(frontParams[i]);
  const L = buildLKernel(q, { tau, size: FRONT_SIZE });

  // MCMC 在双色球的 mcmc.js 用了 ssq 专用的 energy / passesConstraints 引用，
  // 大乐透要传入"自家的能量函数"。封装一下：
  const ctx = {
    logQuality,
    L,
    constraints,
    lambdaDiv,
    lambdaCstr,
    lambdaCrowd,
    customEnergy: (front, back, c) => energyDlt(front, back, c),
  };

  // 后区独立采样（贝叶斯均值加权，不放回）
  const backWeights = Array(BACK_SIZE + 1).fill(0);
  for (let i = 1; i <= BACK_SIZE; i++) backWeights[i] = posteriorMean(backParams[i]);
  const pickBack = () => sampleSubsetByWeights(poolB, backWeights, needB, rand, includeListB);

  const chainResults = [];
  for (let c = 0; c < chains; c++) {
    const initial = randomInitial(poolF, includeListF, FRONT_PICK, rand);
    const initBack = pickBack();
    const ctxLocal = { ...ctx, blue: 1, _back: initBack };
    const res = runDltChain({
      initial,
      pool: [...poolF, ...includeListF],
      pinned: includeListF,
      ctx: ctxLocal,
      iterations,
      burnIn,
      thin,
      rng: rand,
    });
    chainResults.push(res);
  }

  // 合并样本，按能量升序选 count 个**前区不重复**的组合。
  // 不能用 "front|back" 做 key——MCMC 链停在能量低点时会输出 5 注前 3 注前区相同。
  const allSamples = [];
  for (const c of chainResults) for (const s of c.samples) allSamples.push(s);
  allSamples.sort((a, b) => a.energy - b.energy);

  const tickets = [];
  const seenFront = new Set();
  for (const s of allSamples) {
    if (tickets.length >= count) break;
    if (!passesDltConstraints(s.reds, constraints)) continue;
    const frontKey = s.reds.join(",");
    if (seenFront.has(frontKey)) continue;
    seenFront.add(frontKey);
    const back = pickBack();
    tickets.push({
      key: `${frontKey}|${back.join(",")}`,
      front: s.reds,
      back,
      score: -s.energy,
      diagnostics: {
        energy: s.energy,
        logDet: logDetSubmatrix(L, s.reds),
        crowdPenalty: dltCrowdPenalty(s.reds, back),
      },
    });
  }

  const acceptRate = mean(chainResults.map((c) => c.acceptRate));
  const essList = chainResults.map((c) => effectiveSampleSize(c.energies));
  const essMean = mean(essList.map((e) => e.ess));
  const tauIntMean = mean(essList.map((e) => e.tauInt));
  const rHat = gelmanRubin(chainResults.map((c) => c.energies));
  const acf = chainResults[0] ? autocorrelation(chainResults[0].energies, 30) : [1];

  return {
    tickets,
    methodDiag: {
      samplerLabel: `Metropolis-Hastings × ${chains} chains`,
      acceptRate,
      ess: essMean,
      tauInt: tauIntMean,
      rHat,
      acf,
      iterations,
      burnIn,
      thin,
      chains,
    },
  };
}

/** 大乐透能量函数（改造自 mcmc.js 的 energy）。 */
function energyDlt(front, back, ctx) {
  const { logQuality, L, constraints, lambdaDiv, lambdaCstr, lambdaCrowd } = ctx;
  let e = 0;
  for (const r of front) e += -logQuality[r];
  if (lambdaDiv > 0) {
    const ld = logDet(L, front);
    if (!isFinite(ld)) e += lambdaDiv * 50;
    else e -= lambdaDiv * ld;
  }
  if (lambdaCstr > 0 && constraints) {
    const violations = analyseDltConstraintFailures(front, constraints).length;
    e += lambdaCstr * violations;
  }
  if (lambdaCrowd > 0) {
    e += lambdaCrowd * dltCrowdPenalty(front, back || [1, 2]);
  }
  return e;
}

/** 大乐透 MCMC 单链。结构同 mcmc.runChain，但用 energyDlt + 5 选号空间。 */
function runDltChain({
  initial, pool, pinned = [], ctx, iterations = 4000, burnIn = 1000, thin = 4, rng = Math.random,
}) {
  let cur = initial.slice().sort((a, b) => a - b);
  const back = ctx._back || [];
  let curE = energyDlt(cur, back, ctx);
  const samples = [];
  const energies = [];
  const chainE = [];
  let accepted = 0, proposals = 0;

  for (let step = 0; step < iterations; step++) {
    const next = proposeSwap(cur, pool, pinned, rng);
    if (!next) break;
    proposals++;
    const nextE = energyDlt(next, back, ctx);
    let accept;
    if (!isFinite(curE) && isFinite(nextE)) accept = true;
    else if (isFinite(curE) && !isFinite(nextE)) accept = false;
    else if (!isFinite(curE) && !isFinite(nextE)) accept = rng() < 0.1;
    else {
      const dE = nextE - curE;
      accept = dE <= 0 || rng() < Math.exp(-dE);
    }
    if (accept) {
      cur = next;
      curE = nextE;
      accepted++;
    }
    chainE.push(curE);
    if (step >= burnIn && (step - burnIn) % thin === 0) {
      samples.push({ reds: cur.slice(), energy: curE });
      energies.push(curE);
    }
  }
  return {
    samples,
    energies,
    acceptRate: proposals === 0 ? 0 : accepted / proposals,
    chainEnergy: chainE,
    iterations: proposals,
  };
}

function proposeSwap(reds, pool, pinned, rng) {
  const movableIdx = [];
  for (let i = 0; i < reds.length; i++) if (!pinned.includes(reds[i])) movableIdx.push(i);
  if (movableIdx.length === 0) return null;
  const i = movableIdx[Math.floor(rng() * movableIdx.length)];
  const out = pool.filter((n) => !reds.includes(n));
  if (out.length === 0) return null;
  const newNum = out[Math.floor(rng() * out.length)];
  const next = reds.slice();
  next[i] = newNum;
  return next.sort((a, b) => a - b);
}

/* ===========================================================
 *  工具函数
 * =========================================================== */

function sampleSubsetByWeights(pool, weightsArr, needCount, rand, pinned = []) {
  if (needCount === 0) return [...pinned].sort((a, b) => a - b);
  const candidates = pool.slice();
  const w = candidates.map((n) => Math.max(0, weightsArr[n] || 0));
  const picked = [];
  for (let k = 0; k < needCount; k++) {
    if (candidates.length === 0) break;
    const idx = sampleIndexByWeights(w, rand);
    picked.push(candidates[idx]);
    candidates.splice(idx, 1);
    w.splice(idx, 1);
  }
  return [...pinned, ...picked].sort((a, b) => a - b);
}

function sampleIndexByWeights(w, rand) {
  let total = 0;
  for (const x of w) total += x;
  if (total <= 0) return Math.floor(rand() * w.length);
  let r = rand() * total;
  for (let i = 0; i < w.length; i++) {
    r -= w[i];
    if (r <= 0) return i;
  }
  return w.length - 1;
}

function randomInitial(pool, pinned, pickCount, rand) {
  const need = pickCount - pinned.length;
  const cand = pool.slice();
  const out = [...pinned];
  for (let i = 0; i < need; i++) {
    if (cand.length === 0) break;
    const idx = Math.floor(rand() * cand.length);
    out.push(cand[idx]);
    cand.splice(idx, 1);
  }
  return out.sort((a, b) => a - b);
}

function negLogLikelihoodFromMean(reds, params) {
  let s = 0;
  for (const r of reds) {
    const m = posteriorMean(params[r]);
    s += -Math.log(Math.max(1e-9, m));
  }
  return s;
}

function mean(a) {
  if (!a.length) return 0;
  return a.reduce((s, x) => s + x, 0) / a.length;
}
