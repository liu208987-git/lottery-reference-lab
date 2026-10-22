// Moving Block Bootstrap & Stationary Bootstrap
//
// 标准 bootstrap 假设样本 i.i.d.；如果数据有时间相关（autocorrelation），
// 朴素 bootstrap 会低估方差。Block bootstrap 通过抽连续 block 保留局部相关结构。
//
// 两种主流方法：
//   1. Moving Block Bootstrap (MBB, Künsch 1989)：固定 block 长度 L，
//      从 n−L+1 个起点随机抽 ⌈n/L⌉ 个 block 拼出新序列
//   2. Stationary Bootstrap (Politis & Romano 1994)：block 长度本身是
//      Geometric(p) 分布，期望长度 1/p，保证重采样序列严格平稳
//
// 在彩票项目里：
//   - 主要用于"如果有人觉得彩票不是 i.i.d."的稳健性分析
//   - block 长度选择：经验法则 L ≈ n^(1/3)
//
// 参考：Lahiri (2003) "Resampling Methods for Dependent Data"

import { createRng } from "./rng.js";

/**
 * Moving Block Bootstrap：
 * @param records 时间序列数据（按时间正序）
 * @param metricFn (records) => number
 * @param opts.B   重采样次数
 * @param opts.blockSize  block 长度，默认 round(n^(1/3))
 * @param opts.level 置信水平
 * @param opts.seed
 * @returns { mean, lower, upper, blockSize, B }
 */
export function movingBlockBootstrap(records, metricFn, { B = 500, blockSize = null, level = 0.95, seed = "mbb" } = {}) {
  const n = records.length;
  if (n < 4) return { mean: 0, lower: 0, upper: 0, blockSize: 0, B: 0 };

  const L = blockSize || Math.max(2, Math.round(Math.pow(n, 1 / 3)));
  if (L > n) return { mean: 0, lower: 0, upper: 0, blockSize: L, B: 0 };

  const rng = createRng(seed).next;
  const original = metricFn(records);
  const numBlocks = Math.ceil(n / L);
  const numStarts = n - L + 1;

  const bootValues = new Array(B);
  for (let b = 0; b < B; b++) {
    const sample = [];
    for (let k = 0; k < numBlocks; k++) {
      const start = Math.floor(rng() * numStarts);
      for (let j = 0; j < L && sample.length < n; j++) {
        sample.push(records[start + j]);
      }
    }
    bootValues[b] = metricFn(sample);
  }

  return summarize(bootValues, original, level, { blockSize: L, B });
}

/**
 * Stationary Bootstrap：block 长度服从 Geometric(p)，
 * 期望长度 = 1/p。p 推荐 1/L_optimal，L_optimal ≈ n^(1/3)。
 */
export function stationaryBootstrap(records, metricFn, { B = 500, p = null, level = 0.95, seed = "sb" } = {}) {
  const n = records.length;
  if (n < 4) return { mean: 0, lower: 0, upper: 0, p: 0, B: 0 };

  const pVal = p != null ? p : 1 / Math.max(2, Math.round(Math.pow(n, 1 / 3)));
  const rng = createRng(seed).next;
  const original = metricFn(records);

  const bootValues = new Array(B);
  for (let b = 0; b < B; b++) {
    const sample = new Array(n);
    let i = 0;
    let pos = Math.floor(rng() * n);
    while (i < n) {
      sample[i] = records[pos];
      i++;
      // 以概率 p 重启 block
      if (rng() < pVal) {
        pos = Math.floor(rng() * n);
      } else {
        pos = (pos + 1) % n;
      }
    }
    bootValues[b] = metricFn(sample);
  }

  return summarize(bootValues, original, level, { p: pVal, B });
}

function summarize(bootValues, original, level, extra) {
  const sorted = bootValues.slice().sort((a, b) => a - b);
  const B = bootValues.length;
  const alpha = (1 - level) / 2;
  const lo = sorted[Math.max(0, Math.floor(alpha * B))];
  const hi = sorted[Math.min(B - 1, Math.ceil((1 - alpha) * B) - 1)];
  return { mean: original, lower: lo, upper: hi, ...extra };
}
