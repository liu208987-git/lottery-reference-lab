// 高级采样器：把 Bayes / Thompson / DPP / MCMC 编排成一个统一接口
//
// 输出一组票，每张票携带：
//   - reds, blue
//   - score：综合质量分
//   - diagnostics：每张票的诊断（后验 logp、logDet、约束违反数、撞号惩罚）
// 总诊断：
//   - method：使用的采样方法名
//   - acceptRate：MCMC 接受率（仅 MCMC 模式）
//   - ess / tauInt / rHat：MCMC 收敛与有效样本
//   - js / wasserstein / score：与目标分布的距离
//   - reproducible：种子（复现实验用）

import { posteriorParams, posteriorMean, thompsonWeights, RED_PRIOR, BLUE_PRIOR } from "./bayes.js";
import { buildLKernel, greedyKDPP, logDetSubmatrix } from "./dpp.js";
import { runChain, energy, effectiveSampleSize, gelmanRubin, autocorrelation } from "./mcmc.js";
import { passesConstraints, analyseConstraintFailures } from "./stats.js";
import { crowdPenalty } from "./generator.js";
import {
  ticketsToFreqDist,
  jsDistance,
  wassersteinDistance,
  samplingQualityScore,
} from "./distance.js";
import { createRng, makeBetaSampler } from "./rng.js";

const RED_SIZE = 33;
const BLUE_SIZE = 16;

/** 主入口。 */
export function generateAdvanced({
  freqR,
  freqB,
  totalDraws,
  method = "bayes-dpp", // "bayes-dpp" | "mcmc" | "thompson"
  count = 5,
  constraints = {},
  includeRed = [],
  excludeRed = [],
  excludeBlue = [],
  avoidLast = [],
  // 算法超参
  tau = 6, // DPP 相似带宽
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
  const includeSet = new Set(includeRed);
  const excludeSet = new Set([...excludeRed, ...avoidLast]);
  for (const n of includeSet) excludeSet.delete(n);
  if (includeSet.size > 6) throw new Error(`胆码不能超过 6 个（当前 ${includeSet.size}）`);
  const pool = [];
  for (let n = 1; n <= RED_SIZE; n++) {
    if (includeSet.has(n) || excludeSet.has(n)) continue;
    pool.push(n);
  }
  const includeList = [...includeSet].sort((a, b) => a - b);
  const needRed = 6 - includeList.length;
  if (pool.length < needRed) throw new Error(`排除过多：还需 ${needRed} 个但只剩 ${pool.length}`);

  const blueItems = [];
  for (let n = 1; n <= BLUE_SIZE; n++) if (!excludeBlue.includes(n)) blueItems.push(n);
  if (blueItems.length === 0) throw new Error("所有蓝球都被排除了");

  // 2) 贝叶斯后验
  const redParams = posteriorParams(freqR, totalDraws, RED_PRIOR);
  const blueParams = posteriorParams(freqB, totalDraws, BLUE_PRIOR);

  // 3) 不同方法分发
  let tickets = [];
  let methodDiag = {};
  if (method === "thompson") {
    ({ tickets, methodDiag } = runThompson({
      redParams, blueParams, blueItems, includeList, pool,
      needRed, count, constraints, betaSample, rand,
    }));
  } else if (method === "mcmc") {
    ({ tickets, methodDiag } = runMcmc({
      redParams, blueParams, blueItems, includeList, pool,
      needRed, count, constraints,
      tau, lambdaDiv, lambdaCstr, lambdaCrowd,
      iterations: mcmcIterations, burnIn: mcmcBurnIn, thin: mcmcThin, chains: mcmcChains,
      rand,
    }));
  } else {
    // bayes-dpp（默认）
    ({ tickets, methodDiag } = runBayesDPP({
      redParams, blueParams, blueItems, includeList, pool,
      needRed, count, constraints, tau, betaSample, rand,
    }));
  }

  // 4) 后处理：评分 + 与目标分布的距离
  const observed = ticketsToFreqDist(tickets, RED_SIZE);
  const targetMeans = Array(RED_SIZE + 1).fill(0);
  let s = 0;
  for (let i = 1; i <= RED_SIZE; i++) {
    targetMeans[i] = posteriorMean(redParams[i]);
    s += targetMeans[i];
  }
  for (let i = 1; i <= RED_SIZE; i++) targetMeans[i] /= s;
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
      poolSize: pool.length,
      pinned: includeList,
    },
  };
}

/* ============================================================
 * 1. Bayes-Thompson Sampling（每注独立从后验抽 p̂ 后加权采样）
 * ============================================================ */
function runThompson({
  redParams, blueParams, blueItems, includeList, pool,
  needRed, count, constraints, betaSample, rand,
}) {
  const tickets = [];
  const failureReasons = Object.create(null);
  const seen = new Set();
  let tries = 0;
  const maxTry = count * 200;

  while (tickets.length < count && tries < maxTry) {
    tries++;
    // Thompson：每注从后验抽一组 p̂_i
    const wRed = Array(RED_SIZE + 1).fill(0);
    for (let i = 1; i <= RED_SIZE; i++) wRed[i] = betaSample(redParams[i].alpha, redParams[i].beta);
    const wBlueAll = Array(BLUE_SIZE + 1).fill(0);
    for (let i = 1; i <= BLUE_SIZE; i++) wBlueAll[i] = betaSample(blueParams[i].alpha, blueParams[i].beta);

    const reds = sampleRedsBySoftmax(pool, wRed, needRed, rand, includeList);
    const blue = sampleByWeights(blueItems, blueItems.map((n) => wBlueAll[n]), rand);

    if (!passesConstraints(reds, constraints)) {
      for (const r of analyseConstraintFailures(reds, constraints)) {
        failureReasons[r] = (failureReasons[r] || 0) + 1;
      }
      continue;
    }
    const key = `${reds.join(",")}|${blue}`;
    if (seen.has(key)) continue;
    seen.add(key);

    tickets.push({
      key, reds, blue,
      score: -negLogLikelihoodRedsFromMean(reds, redParams),
      diagnostics: {
        constraintViolations: 0,
        crowdPenalty: crowdPenalty(reds, blue),
      },
    });
  }
  return {
    tickets,
    methodDiag: { tries, failureReasons, samplerLabel: "Thompson Sampling (Beta posterior)" },
  };
}

/* ============================================================
 * 2. Bayes + DPP（默认）：用后验均值作 quality，DPP greedy 选 6 个，多注扰动
 * ============================================================ */
function runBayesDPP({
  redParams, blueParams, blueItems, includeList, pool,
  needRed, count, constraints, tau, betaSample, rand,
}) {
  const tickets = [];
  const failureReasons = Object.create(null);
  const seen = new Set();
  let tries = 0;
  const maxTry = count * 300;

  while (tickets.length < count && tries < maxTry) {
    tries++;
    // 每注用 Thompson 抽样的 p̂ 作 quality（注间扰动）
    const q = Array(RED_SIZE + 1).fill(0);
    for (let i = 1; i <= RED_SIZE; i++) q[i] = betaSample(redParams[i].alpha, redParams[i].beta);
    // 排除/胆码：把 quality 修剪为 0
    const qMasked = q.slice();
    for (let i = 1; i <= RED_SIZE; i++) {
      if (!pool.includes(i) && !includeList.includes(i)) qMasked[i] = 0;
    }
    const L = buildLKernel(qMasked, { tau, size: RED_SIZE });
    const reds = greedyKDPP(L, 6, { pool, pinned: includeList, size: RED_SIZE });
    if (reds.length !== 6) continue;

    // 蓝球：直接 Thompson + 加权
    const wB = blueItems.map((n) => betaSample(blueParams[n].alpha, blueParams[n].beta));
    const blue = sampleByWeights(blueItems, wB, rand);

    if (!passesConstraints(reds, constraints)) {
      for (const r of analyseConstraintFailures(reds, constraints)) {
        failureReasons[r] = (failureReasons[r] || 0) + 1;
      }
      continue;
    }
    const key = `${reds.join(",")}|${blue}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const ld = logDetSubmatrix(L, reds);
    tickets.push({
      key, reds, blue,
      score: ld - negLogLikelihoodRedsFromMean(reds, redParams),
      diagnostics: {
        logDet: ld,
        constraintViolations: 0,
        crowdPenalty: crowdPenalty(reds, blue),
      },
    });
  }
  return {
    tickets,
    methodDiag: { tries, failureReasons, samplerLabel: "Bayes posterior × DPP greedy MAP" },
  };
}

/* ============================================================
 * 3. MCMC：多链 Metropolis-Hastings，按目标能量采样
 * ============================================================ */
function runMcmc({
  redParams, blueParams, blueItems, includeList, pool,
  needRed, count, constraints,
  tau, lambdaDiv, lambdaCstr, lambdaCrowd,
  iterations, burnIn, thin, chains,
  rand,
}) {
  // logQuality：用后验均值的对数
  const logQuality = Array(RED_SIZE + 1).fill(-Infinity);
  for (let i = 1; i <= RED_SIZE; i++) {
    const m = posteriorMean(redParams[i]);
    logQuality[i] = Math.log(Math.max(1e-9, m));
  }
  // 用后验均值平方作 quality
  const q = Array(RED_SIZE + 1).fill(0);
  for (let i = 1; i <= RED_SIZE; i++) q[i] = posteriorMean(redParams[i]);
  const L = buildLKernel(q, { tau, size: RED_SIZE });

  // 蓝球独立采样（Thompson 风格）
  const blueLogQ = Array(BLUE_SIZE + 1).fill(0);
  for (let i = 1; i <= BLUE_SIZE; i++) blueLogQ[i] = posteriorMean(blueParams[i]);
  const pickBlue = () => sampleByWeights(blueItems, blueItems.map((n) => blueLogQ[n]), rand);

  // 多链：每链用不同初始点
  const chainResults = [];
  for (let c = 0; c < chains; c++) {
    const initial = randomInitial(pool, includeList, rand);
    const blue = pickBlue();
    const ctx = { logQuality, L, constraints, lambdaDiv, lambdaCstr, lambdaCrowd, blue };
    const res = runChain({
      initial,
      pool: [...pool, ...includeList],
      pinned: includeList,
      ctx,
      iterations, burnIn, thin,
      rng: rand,
    });
    chainResults.push(res);
  }

  // 合并所有链的样本，按能量升序选 count 个**前区不重复**的组合
  // 注意：去重 key 只看红球组合，否则 MCMC 链停留在能量低点时只靠"换蓝"凑唯一性，
  // 5 注里会出现前 3 注红球完全相同的退化情况，破坏"低撞号 + 分散覆盖"。
  const allSamples = [];
  for (const c of chainResults) for (const s of c.samples) allSamples.push(s);
  allSamples.sort((a, b) => a.energy - b.energy);

  const tickets = [];
  const seenReds = new Set();
  for (const s of allSamples) {
    if (tickets.length >= count) break;
    if (!passesConstraints(s.reds, constraints)) continue;
    const redKey = s.reds.join(",");
    if (seenReds.has(redKey)) continue;
    seenReds.add(redKey);
    // 蓝球：每张票独立采（让蓝球多样）
    const blue = pickBlue();
    tickets.push({
      key: `${redKey}|${blue}`, reds: s.reds, blue,
      score: -s.energy,
      diagnostics: {
        energy: s.energy,
        logDet: logDetSubmatrix(L, s.reds),
        crowdPenalty: crowdPenalty(s.reds, blue),
      },
    });
  }

  // 收敛诊断
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

/* ============================================================
 * 工具函数
 * ============================================================ */
function sampleByWeights(items, weights, rand) {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  if (total <= 0) return items[Math.floor(rand() * items.length)];
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(0, weights[i]);
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** 不放回加权采样 needRed 个红球，加上胆码后排序。 */
function sampleRedsBySoftmax(pool, weightsArr, needRed, rand, pinned) {
  if (needRed === 0) return [...pinned].sort((a, b) => a - b);
  const candidates = pool.slice();
  const w = candidates.map((n) => Math.max(0, weightsArr[n] || 0));
  const picked = [];
  for (let k = 0; k < needRed; k++) {
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

function randomInitial(pool, pinned, rand) {
  const need = 6 - pinned.length;
  const cand = pool.slice();
  const out = [...pinned];
  for (let i = 0; i < need; i++) {
    const idx = Math.floor(rand() * cand.length);
    out.push(cand[idx]);
    cand.splice(idx, 1);
  }
  return out.sort((a, b) => a - b);
}

function negLogLikelihoodRedsFromMean(reds, params) {
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
