// 大乐透前后区独立性 / 关联检验
//
// 大乐透是"前区 5 选 35"和"后区 2 选 12"两个独立摇奖装置。理论上这两个装置完全独立，
// 任何"前区出 X 时后区更倾向 Y"的说法应该是噪声。本模块给出几个角度的检验：
//
// 1. 前区和值 vs 后区和值的相关性（Pearson + Spearman）
// 2. 前区奇偶比 × 后区奇偶比 列联表卡方独立性检验
// 3. 前区某号码出现 vs 后区某号码出现的 lift（35×12 矩阵）
//
// 输出：所有指标 + p 值 + 一句"是否拒绝独立"判语。
// 这种"先验上必为独立"的检验非常适合做"卡方 sanity check"——
// 如果数据规模足够、检验显著拒绝独立，那一定是数据本身或抽奖装置的偏差。

import { chiSquaredPValue } from "./dlt-chi-square.js";

/** Pearson 相关系数。 */
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const denom = Math.sqrt(dx * dy);
  return denom < 1e-12 ? 0 : num / denom;
}

/** Spearman 秩相关：把 xs/ys 各自转成秩后做 Pearson。 */
export function spearman(xs, ys) {
  return pearson(rank(xs), rank(ys));
}

function rank(arr) {
  const indexed = arr.map((v, i) => [v, i]);
  indexed.sort((a, b) => a[0] - b[0]);
  const ranks = new Array(arr.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1][0] === indexed[i][0]) j++;
    // 平均秩处理同值
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[indexed[k][1]] = avgRank;
    i = j + 1;
  }
  return ranks;
}

/**
 * Fisher z 变换 → 相关系数显著性的双尾 p 值（n ≥ 30 时近似精确）。
 */
export function correlationPValue(r, n) {
  if (n < 4 || Math.abs(r) >= 1) return 0;
  const z = 0.5 * Math.log((1 + r) / (1 - r));
  const se = 1 / Math.sqrt(n - 3);
  const zStat = z / se;
  // 双尾正态 p
  const phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
  return 2 * (1 - phi(Math.abs(zStat)));
}

function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/** 前区和 vs 后区和 的相关系数 + p 值。 */
export function frontBackSumCorrelation(draws) {
  const xs = draws.map((d) => d.front.reduce((a, b) => a + b, 0));
  const ys = draws.map((d) => d.back.reduce((a, b) => a + b, 0));
  const r = pearson(xs, ys);
  const rho = spearman(xs, ys);
  const pearsonP = correlationPValue(r, xs.length);
  const spearmanP = correlationPValue(rho, xs.length);
  return { pearson: r, spearman: rho, pearsonP, spearmanP, n: xs.length };
}

/**
 * 前区奇偶 × 后区奇偶 列联表卡方独立性检验。
 * 6 行（前区 0..5 奇）× 3 列（后区 0..2 奇）。
 * H0: 前区奇数个数与后区奇数个数独立。
 */
export function oddCountIndependenceTest(draws) {
  const rows = 6, cols = 3;
  const obs = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (const d of draws) {
    const fOdd = d.front.filter((x) => x % 2 === 1).length;
    const bOdd = d.back.filter((x) => x % 2 === 1).length;
    obs[fOdd][bOdd]++;
  }
  const total = draws.length;
  const rowSum = obs.map((r) => r.reduce((a, b) => a + b, 0));
  const colSum = Array(cols).fill(0);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) colSum[c] += obs[r][c];

  let chi = 0;
  let dfReduce = 0;
  const expected = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const e = (rowSum[r] * colSum[c]) / total;
      expected[r][c] = e;
      if (e < 1e-9) { dfReduce++; continue; }
      const d = obs[r][c] - e;
      chi += (d * d) / e;
    }
  }
  // df = (rows-1)(cols-1) - 缺失格 dfReduce
  const df = Math.max(1, (rows - 1) * (cols - 1) - dfReduce);
  const p = chiSquaredPValue(chi, df);
  return { chi, df, p, observed: obs, expected, n: total };
}

/**
 * 前区号码 i × 后区号码 j 的 35×12 lift 矩阵：
 *   lift(i, j) = P(i 在前区 ∧ j 在后区) / [P(i 在前区) × P(j 在后区)]
 *   独立基线 = 1.0
 * 返回偏离最远的 K 对（按 |lift - 1| 排序）。
 */
export function frontBackPairLift(draws, { topK = 8 } = {}) {
  const N = draws.length;
  if (N === 0) return { extremes: [], baseline: 1 };
  const fProb = Array(36).fill(0); // 1..35
  const bProb = Array(13).fill(0); // 1..12
  const co = Array.from({ length: 36 }, () => Array(13).fill(0));
  for (const d of draws) {
    for (const f of d.front) fProb[f]++;
    for (const b of d.back) bProb[b]++;
    for (const f of d.front) for (const b of d.back) co[f][b]++;
  }
  const extremes = [];
  for (let i = 1; i <= 35; i++) {
    for (let j = 1; j <= 12; j++) {
      const pa = fProb[i] / N;
      const pb = bProb[j] / N;
      if (pa === 0 || pb === 0) continue;
      const pab = co[i][j] / N;
      const lift = pab / (pa * pb);
      const dev = lift - 1;
      extremes.push({ front: i, back: j, count: co[i][j], lift, deviation: dev });
    }
  }
  extremes.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));
  return {
    extremes: extremes.slice(0, topK),
    baseline: 1,
    sample: N,
  };
}

/** 综合判语：5%/1% 两道阈值。 */
export function verdictFromP(p, level = 0.05) {
  if (p < 0.001) return { reject: true, severity: "strong", text: "极强证据拒绝独立 (p < 0.001)" };
  if (p < 0.01) return { reject: true, severity: "moderate", text: "强证据拒绝独立 (p < 0.01)" };
  if (p < level) return { reject: true, severity: "weak", text: `拒绝独立 (p < ${level})` };
  return { reject: false, severity: "none", text: `不拒绝独立 (p = ${p.toFixed(4)})` };
}
