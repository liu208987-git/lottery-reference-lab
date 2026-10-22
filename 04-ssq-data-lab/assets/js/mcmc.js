// Metropolis-Hastings MCMC：在 C(33,6) ≈ 1.1M 的组合空间里按目标分布采样
//
// 数学背景：
//   目标分布 π(Y) ∝ exp(-E(Y))，能量 E(Y) 综合了：
//     -log p(Y)：贝叶斯后验联合似然（号码组合的"质量")
//     +λ_div  · -logDet(L_Y)：DPP 多样性奖励
//     +λ_cstr · 软约束惩罚（违反约束的次数）
//     +λ_crowd· 撞号风险（生日号码、同尾、连号、等差等）
//   提议分布 q(Y'|Y)：随机交换其中 1 个号码 ↔ 池外 1 个号码（对称提议）
//   接受概率 α = min(1, exp(E(Y) - E(Y')))
//
// 链的诊断：
//   - 接受率（理想 0.2~0.5）
//   - 自相关时间 τ_int → 有效样本数 ESS = N / (1 + 2 τ_int)
//   - 多链 Gelman-Rubin R̂ → 收敛性
//
// 为什么用 MCMC：
//   组合空间 110 万对枚举太大，直接重要性采样在长尾很差；
//   MCMC 自然按目标分布探索，在多目标能量下能找到"高质量+高分散"的局部模式。

import { logDetSubmatrix } from "./dpp.js";
import { passesConstraints, analyseConstraintFailures } from "./stats.js";
import { crowdPenalty } from "./generator.js";

/**
 * 计算一个红球组合的 -log 后验联合似然。
 * 这里我们把 6 个号码当作独立 Bernoulli 抽取（实际是无放回，但近似足够），
 * 然后对独立性做"惩罚式"修正：组合中相邻号码（差 1）越多，似然越低。
 *
 * @param reds 红球数组（6 个，已排序）
 * @param logQuality 长度 size+1 的数组，logQuality[i] = log q_i
 */
export function negLogLikelihood(reds, logQuality) {
  let s = 0;
  for (const r of reds) s += -logQuality[r];
  return s;
}

/** 从一个红球组合的能量函数。 */
export function energy(reds, blue, ctx) {
  const {
    logQuality, // [null, log(q1), log(q2), ...]
    L,
    constraints,
    lambdaDiv = 0.5,
    lambdaCstr = 5.0,
    lambdaCrowd = 0.3,
  } = ctx;
  let e = negLogLikelihood(reds, logQuality);
  if (lambdaDiv > 0) {
    const ld = logDetSubmatrix(L, reds);
    // logDet=-∞ 表示子矩阵退化（连号过多导致行列式为 0）
    // 用一个大正惩罚替代 +∞，使能量仍然可比，链能从退化点逃出
    if (!isFinite(ld)) {
      e += lambdaDiv * 50;
    } else {
      e -= lambdaDiv * ld;
    }
  }
  if (lambdaCstr > 0 && constraints) {
    const violations = analyseConstraintFailures(reds, constraints).length;
    e += lambdaCstr * violations;
  }
  if (lambdaCrowd > 0) {
    e += lambdaCrowd * crowdPenalty(reds, blue);
  }
  return e;
}

/** 提议算子：交换一个红球。返回新组合（保持已排序）。 */
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

/**
 * 单链 Metropolis-Hastings 采样。
 * @returns { samples, energies, acceptRate, chain }
 *   samples 包含 burnIn 之后、间隔 thin 的样本（通常每条链取 N/thin 个）
 */
export function runChain({
  initial,
  pool,
  pinned = [],
  ctx,
  iterations = 4000,
  burnIn = 1000,
  thin = 4,
  rng = Math.random,
}) {
  let cur = initial.slice().sort((a, b) => a - b);
  let curBlue = ctx.blue || 1;
  let curE = energy(cur, curBlue, ctx);
  const samples = [];
  const energies = [];
  const chainE = [];
  let accepted = 0;
  let proposals = 0;

  for (let step = 0; step < iterations; step++) {
    const next = proposeSwap(cur, pool, pinned, rng);
    if (!next) break;
    proposals++;
    const nextE = energy(next, curBlue, ctx);
    // 若当前能量是 +∞ 而 next 是有限 → 必然接受
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
      samples.push({ reds: cur.slice(), blue: curBlue, energy: curE });
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

/** 自相关函数 ACF（最多到 lagMax），用样本对的协方差估计。 */
export function autocorrelation(series, lagMax = 50) {
  const n = series.length;
  if (n < 2) return [1];
  const mean = series.reduce((a, b) => a + b, 0) / n;
  let var0 = 0;
  for (const x of series) var0 += (x - mean) * (x - mean);
  var0 /= n;
  if (var0 < 1e-18) return [1];
  const out = [1];
  const max = Math.min(lagMax, n - 1);
  for (let lag = 1; lag <= max; lag++) {
    let s = 0;
    for (let i = 0; i < n - lag; i++) s += (series[i] - mean) * (series[i + lag] - mean);
    out.push(s / ((n - lag) * var0));
  }
  return out;
}

/**
 * 综合自相关时间 τ_int：用初始正序列估计（Geyer 1992）。
 * 1 + 2·Σ ρ_t（直到 ρ_{2k}+ρ_{2k+1} 首次为负）。
 * ESS = N / (1 + 2 τ_int)。
 * 若链能量近似常数（链卡住），返回 ess=1（保守）。
 */
export function effectiveSampleSize(series) {
  if (!series || series.length < 4) return { tauInt: 0.5, ess: Math.max(1, series?.length || 1) };
  const acf = autocorrelation(series, Math.min(200, series.length - 1));
  if (acf.length <= 1) return { tauInt: 0.5, ess: 1 };
  let tau = 0;
  for (let k = 1; k + 1 < acf.length; k += 2) {
    const pair = acf[k] + acf[k + 1];
    if (pair < 0) break;
    tau += pair;
  }
  const tauInt = 0.5 + Math.max(0, tau);
  const ess = series.length / (1 + 2 * tauInt);
  return { tauInt, ess: Math.max(1, ess) };
}

/**
 * 多链 Gelman-Rubin 收敛诊断 R̂。
 * 接近 1（< 1.1）表示链已收敛；> 1.2 表示需要更多迭代。
 */
export function gelmanRubin(chains) {
  const m = chains.length;
  if (m < 2) return NaN;
  const n = Math.min(...chains.map((c) => c.length));
  if (n < 2) return NaN;
  const means = chains.map((c) => mean(c.slice(0, n)));
  const overall = mean(means);
  const B = (n / (m - 1)) * means.reduce((a, b) => a + (b - overall) ** 2, 0);
  const W = mean(chains.map((c) => variance(c.slice(0, n))));
  if (W < 1e-18) return 1;
  const varHat = ((n - 1) / n) * W + B / n;
  return Math.sqrt(varHat / W);
}

function mean(a) {
  return a.reduce((s, x) => s + x, 0) / a.length;
}
function variance(a) {
  const mu = mean(a);
  return a.reduce((s, x) => s + (x - mu) ** 2, 0) / Math.max(1, a.length - 1);
}
