// BCa（Bias-Corrected and Accelerated）Bootstrap 置信区间
//
// 比 percentile bootstrap 更准——修两个方向的偏差：
//   1. bias correction (z0)：原始 metric 在 bootstrap 分布里的位置 vs 中位数
//   2. acceleration (a)：jackknife 估计的 skewness（分布偏度修正）
//
// 当 metric 接近正态时退化为 percentile bootstrap。
// 当 metric 有偏（如 hit@K 在小样本下右偏）时给更窄但更准的 CI。
//
// 参考：Efron & Tibshirani (1993) "An Introduction to the Bootstrap"

import { createRng } from "./rng.js";

/** 标准正态 CDF（Hastings 近似 + erfc-style 修正）。 */
function normCdf(x) {
  // Abramowitz & Stegun 26.2.17
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const xx = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * xx);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-xx * xx);
  return 0.5 * (1.0 + sign * y);
}

/** 标准正态分位数（逆 CDF），Beasley-Springer-Moro 近似。 */
function normInv(p) {
  if (p <= 0 || p >= 1) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    throw new Error(`p out of range: ${p}`);
  }
  // Acklam 算法
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
          ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/**
 * 计算 jackknife acceleration：
 *   a = Σ(θ̂_(-i) - θ̄)³ / [6 · (Σ(θ̂_(-i) - θ̄)²)^(3/2)]
 * 其中 θ̂_(-i) 是去掉第 i 个样本后重算的 metric。
 */
function jackknifeAcceleration(records, metricFn) {
  const n = records.length;
  if (n < 3) return 0;
  const looValues = new Array(n);
  for (let i = 0; i < n; i++) {
    const sub = records.slice(0, i).concat(records.slice(i + 1));
    looValues[i] = metricFn(sub);
  }
  const mean = looValues.reduce((s, v) => s + v, 0) / n;
  let num = 0, denom = 0;
  for (const v of looValues) {
    const d = mean - v;
    num += d * d * d;
    denom += d * d;
  }
  if (denom < 1e-30) return 0;
  return num / (6 * Math.pow(denom, 1.5));
}

/**
 * BCa Bootstrap CI。
 * @param records  数据数组
 * @param metricFn (records) => number
 * @param opts.B   bootstrap 重采样次数，默认 1000
 * @param opts.level 置信水平，默认 0.95
 * @param opts.seed  随机种子
 * @returns {
 *   mean: number,        原始 metric 值（θ̂）
 *   lower, upper: number BCa 区间
 *   pcLower, pcUpper:    朴素 percentile 区间（对照）
 *   z0, a: number        bias correction + acceleration
 *   B: number            实际 bootstrap 次数
 * }
 */
export function bcaBootstrap(records, metricFn, { B = 1000, level = 0.95, seed = "bca" } = {}) {
  const n = records.length;
  if (n < 3) return { mean: 0, lower: 0, upper: 0, pcLower: 0, pcUpper: 0, z0: 0, a: 0, B: 0 };

  const original = metricFn(records);
  const rng = createRng(seed).next;

  // 1) bootstrap 重采样
  const bootValues = new Array(B);
  for (let b = 0; b < B; b++) {
    const sample = new Array(n);
    for (let i = 0; i < n; i++) sample[i] = records[Math.floor(rng() * n)];
    bootValues[b] = metricFn(sample);
  }

  // 2) bias correction z0：原值在 bootstrap 分布中的位置
  let lessCount = 0;
  for (const v of bootValues) if (v < original) lessCount++;
  const propLess = lessCount / B;
  const z0 = propLess <= 0 ? -3 : propLess >= 1 ? 3 : normInv(propLess);

  // 3) acceleration：jackknife 偏度估计
  const a = jackknifeAcceleration(records, metricFn);

  // 4) 计算调整后的分位点
  const alpha = (1 - level) / 2;
  const zLo = normInv(alpha);
  const zHi = normInv(1 - alpha);
  const adjust = (z) => {
    const num = z0 + z;
    const denom = 1 - a * num;
    if (Math.abs(denom) < 1e-30) return alpha;
    return normCdf(z0 + num / denom);
  };
  const pLo = Math.max(0, Math.min(1, adjust(zLo)));
  const pHi = Math.max(0, Math.min(1, adjust(zHi)));

  // 5) 取分位数
  const sorted = bootValues.slice().sort((x, y) => x - y);
  const idxLo = Math.max(0, Math.min(B - 1, Math.floor(pLo * B)));
  const idxHi = Math.max(0, Math.min(B - 1, Math.ceil(pHi * B) - 1));
  const lower = sorted[idxLo];
  const upper = sorted[idxHi];

  // 朴素 percentile（对照）
  const pcLow = sorted[Math.max(0, Math.floor(alpha * B))];
  const pcUp = sorted[Math.min(B - 1, Math.ceil((1 - alpha) * B) - 1)];

  return {
    mean: original,
    lower, upper,
    pcLower: pcLow, pcUpper: pcUp,
    z0, a, B,
  };
}
