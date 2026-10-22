// Stability Selection（Meinshausen & Bühlmann 2010）
//
// 问题：单次 walk-forward 回测里，模型 top-K 选号会随机变化。如果做 100 次
// "数据子采样 → 训简化模型 → 取 top-K"，**哪些号是"反复出现的"？**
//
// 反复出现 → 该号在数据里有稳定信号（哪怕 LSTM 把它排第几）
// 极少出现 → 噪声波动，不应当真
//
// 在彩票场景下，理论上每号 stability ≈ K/N（uniform）。
// 显著偏离 K/N 的号 = 数据集偏差信号（不一定泛化）。
//
// 算法：
//   1. 对历史窗口做 B 次有放回 / 子采样
//   2. 每次基于该子样本算频率/Bayes 后验/或调用模型 forward
//   3. 取 top-K
//   4. 统计每号在 B 次里出现的频率
//
// 输出：
//   - selectionFreq[1..N]: 每号被选中频次比例
//   - stableSet: freq ≥ threshold 的号
//   - 误发现率上界（Meinshausen 公式）：
//     E[V] ≤ q² / (2θ - 1) / N
//     其中 q = 平均选中数，θ = stability threshold
//
// 这给"哪些号在数据里反复涌现"的频率主义答案。

import { createRng } from "./rng.js";

/**
 * @param data       历史 draws (≥ 30)
 * @param N          号码空间大小（SSQ 红 33 / DLT 前 35）
 * @param zoneKey    "reds" | "front" | "blue" | "back"
 * @param K          top-K 选号
 * @param opts.B     重采样次数，默认 200
 * @param opts.subsampleRatio  每次抽多大子样本，默认 0.5
 * @param opts.threshold  stable 阈值，默认 0.6（Meinshausen 推荐 [0.6, 0.9]）
 * @param opts.scoreFn (subsampleDraws) => Float32Array(N+1) 每号分数
 *                     默认用历史频率
 * @param opts.seed
 * @returns {
 *   selectionFreq: Float32Array,
 *   stableSet: number[],
 *   errorBound: number,    Meinshausen 误发现率上界
 *   B, K, threshold
 * }
 */
export function stabilitySelection({
  data, N, zoneKey, K,
  B = 200, subsampleRatio = 0.5, threshold = 0.6,
  scoreFn = null,
  seed = "stab",
} = {}) {
  if (!data || data.length < 30) {
    return { selectionFreq: new Float32Array(N + 1), stableSet: [], errorBound: 1, B: 0, K, threshold };
  }
  const rng = createRng(seed).next;
  const subsampleSize = Math.min(data.length, Math.max(20, Math.floor(data.length * subsampleRatio)));
  const counts = new Float32Array(N + 1);

  const defaultScore = (subsample) => {
    const f = new Float32Array(N + 1);
    for (const d of subsample) {
      const v = d[zoneKey];
      if (Array.isArray(v)) {
        for (const n of v) if (n >= 1 && n <= N) f[n]++;
      } else if (typeof v === "number") {
        if (v >= 1 && v <= N) f[v]++;
      }
    }
    return f;
  };
  const score = scoreFn || defaultScore;

  for (let b = 0; b < B; b++) {
    // 不放回子采样
    const idx = new Set();
    while (idx.size < subsampleSize) idx.add(Math.floor(rng() * data.length));
    const subsample = [...idx].map((i) => data[i]);

    const s = score(subsample);
    // 取 top-K
    const ranked = [];
    for (let i = 1; i <= N; i++) ranked.push([i, s[i]]);
    ranked.sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < K; i++) counts[ranked[i][0]]++;
  }

  const selectionFreq = new Float32Array(N + 1);
  for (let i = 1; i <= N; i++) selectionFreq[i] = counts[i] / B;
  const stableSet = [];
  for (let i = 1; i <= N; i++) if (selectionFreq[i] >= threshold) stableSet.push(i);

  // Meinshausen-Bühlmann 误发现率上界
  // E[V] ≤ q² / [(2θ − 1) · N]
  const q = K;  // 平均选中数
  const errorBound = (2 * threshold - 1) > 0
    ? (q * q) / ((2 * threshold - 1) * N)
    : N;

  return {
    selectionFreq,
    stableSet,
    errorBound,
    B, K, threshold,
    expectedFreqUnderUniform: K / N,
  };
}
