// 红球共现 / 关联分析
//
// 一期 6 个红球，两两组合贡献一次"同期共现"。把全历史展开成 33×33 的对称矩阵，
// 对角线置 0；任何号码 n 的累计共现总和 = 5 × freq(n)（一期里它和另外 5 个号一起出现）。
//
// 应用场景：
//   - 找出某号码最强的"同伴号" — top partners
//   - 找出最强/最弱的两两组合
//   - 矩阵热力图，可视化关联结构
//
// 注意：共现频次≠条件概率。我们额外提供了 lift 指标（基于独立性假设的偏差）。

import { RED_MAX } from "./stats.js";

/** 构建 33×33 共现矩阵（对角线为 0）。 */
export function buildCooccurrenceMatrix(draws, size = RED_MAX) {
  const m = Array.from({ length: size + 1 }, () => Array(size + 1).fill(0));
  for (const d of draws) {
    const reds = d.reds;
    for (let i = 0; i < reds.length; i++) {
      for (let j = i + 1; j < reds.length; j++) {
        const a = reds[i];
        const b = reds[j];
        m[a][b] += 1;
        m[b][a] += 1;
      }
    }
  }
  return m;
}

/** 矩阵中所有上三角元素的最大值（用于热力图色阶）。 */
export function matrixMax(matrix, size = RED_MAX) {
  let max = 0;
  for (let i = 1; i <= size; i++) {
    for (let j = i + 1; j <= size; j++) {
      if (matrix[i][j] > max) max = matrix[i][j];
    }
  }
  return max;
}

/** 给定号码 n，返回前 k 个最常一起出现的号码。 */
export function topPartners(matrix, n, k = 5, size = RED_MAX) {
  const pairs = [];
  for (let m = 1; m <= size; m++) {
    if (m === n) continue;
    pairs.push([m, matrix[n][m]]);
  }
  pairs.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return pairs.slice(0, k);
}

/**
 * lift = P(a 与 b 同期) / [P(a∈draw) × P(b∈draw)]
 *   - P(a∈draw) = freq[a] / N
 *   - P(a 与 b 同期) = matrix[a][b] / N
 * lift > 1：两个号同期出现频率高于"独立"假设；< 1：低于；≈ 1：与独立性一致。
 *
 * 在严格随机的双色球里，给定 a 出现，b 出现的条件概率应趋近 5/32（剩余 32 个里抽 5 个），
 * 因此理论 lift = (5/32) / (6/33) ≈ 0.859。我们用 0.859 作为参考基线。
 */
export const INDEPENDENT_LIFT_BASELINE = (5 / 32) / (6 / 33);

export function liftOf(matrix, freqRed, totalDraws, a, b) {
  if (totalDraws === 0) return 0;
  const pa = freqRed[a] / totalDraws;
  const pb = freqRed[b] / totalDraws;
  if (pa === 0 || pb === 0) return 0;
  const pab = matrix[a][b] / totalDraws;
  return pab / (pa * pb);
}

/** 找出 lift 偏离独立基线最远的若干对。 */
export function extremePairs(matrix, freqRed, totalDraws, k = 8, size = RED_MAX) {
  const baseline = INDEPENDENT_LIFT_BASELINE;
  const out = [];
  for (let i = 1; i <= size; i++) {
    for (let j = i + 1; j <= size; j++) {
      const obs = matrix[i][j];
      if (obs === 0) continue;
      const lift = liftOf(matrix, freqRed, totalDraws, i, j);
      out.push({ a: i, b: j, count: obs, lift, deviation: lift - baseline });
    }
  }
  out.sort((x, y) => Math.abs(y.deviation) - Math.abs(x.deviation));
  return out.slice(0, k);
}
