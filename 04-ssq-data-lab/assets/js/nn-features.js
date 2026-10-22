// 手工特征工程
//
// LSTM 现在的输入是 49 维（SSQ）或 47 维（DLT）的 multi-hot——网络要从这里
// 学出"和值/跨度/三区分布/奇偶/质合 ..."这些统计量。但训练数据 ~3000 期太少，
// 让网络自己学远不如直接喂手工特征。
//
// 我们追加 14 维"统计量特征"：
//
//   [0] sum / 100               归一化和值
//   [1] span / size             归一化跨度
//   [2] oddRatio                奇数比例
//   [3] bigRatio                大号比例（>= size/2）
//   [4] primeRatio              质数比例
//   [5] zone[0]                 一区比例
//   [6] zone[1]                 二区比例
//   [7] zone[2]                 三区比例
//   [8] ac / maxAC              归一化 AC 值
//   [9] consecutiveGroups / pick  归一化连号组
//   [10] missCount_max           最大遗漏（基于近 N 期）
//   [11] mean_2hot               近 2 期是否 hit 的平均
//   [12] entropy                 出现号码的"熵"近似
//   [13] freqShannonScore        最近频率分布的 Shannon 度量
//
// 这些特征在每一期都基于"截至当前那期的统计"计算，不会泄露未来。
// 训练时通过历史窗口（最近 30/100 期）算频率/遗漏。

export const FEATURE_AUG_DIM = 14;

const PRIMES_33 = new Set([2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31]);

/** 组合 SSQ 红球数组得出 14 维特征。 */
export function ssqRedFeatures(reds, history /* 当前期之前的所有历史 */) {
  const size = 33;
  return computeFeatures(reds, size, /*pick=*/6, history?.map(d => d.reds) || []);
}

/** DLT 前区数组的 14 维特征。 */
export function dltFrontFeatures(front, history) {
  const size = 35;
  return computeFeatures(front, size, /*pick=*/5, history?.map(d => d.front) || []);
}

function computeFeatures(nums, size, pick, history) {
  const sum = nums.reduce((a, b) => a + b, 0);
  const span = Math.max(...nums) - Math.min(...nums);
  const odd = nums.filter(n => n % 2 === 1).length;
  const big = nums.filter(n => n >= size / 2).length;
  const primes = nums.filter(n => isPrime(n)).length;
  const zoneSize = Math.ceil(size / 3);
  const zone = [0, 0, 0];
  for (const n of nums) {
    const idx = Math.min(2, Math.floor((n - 1) / zoneSize));
    zone[idx]++;
  }
  // AC 值
  const diffs = new Set();
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) diffs.add(Math.abs(nums[i] - nums[j]));
  }
  const ac = diffs.size - (nums.length - 1);
  // 连号组
  const sorted = [...nums].sort((a, b) => a - b);
  let consec = 0, inRun = false;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] === 1) {
      if (!inRun) consec++;
      inRun = true;
    } else inRun = false;
  }

  // 历史相关特征：当前期号在最近 30 期的累计遗漏 / 最近 2 期重复
  let missMax = 0, recentHit = 0, freqEntropy = 0;
  if (history.length > 0) {
    const recent = history.slice(-30);
    const lastSeen = new Array(size + 1).fill(-1);
    for (let i = recent.length - 1; i >= 0; i--) {
      for (const n of recent[i]) if (lastSeen[n] === -1) lastSeen[n] = i;
    }
    for (const n of nums) {
      const ls = lastSeen[n] === -1 ? recent.length : recent.length - 1 - lastSeen[n];
      if (ls > missMax) missMax = ls;
    }
    // 近 2 期重叠
    const last2 = history.slice(-2);
    let hit = 0;
    for (const h of last2) {
      for (const n of nums) if (h.includes(n)) hit++;
    }
    recentHit = hit / Math.max(1, last2.length * pick);

    // 简易 Shannon entropy of frequency distribution in last 30 draws
    const freq = new Array(size + 1).fill(0);
    let total = 0;
    for (const h of recent) {
      for (const n of h) { freq[n]++; total++; }
    }
    if (total > 0) {
      for (let n = 1; n <= size; n++) {
        if (freq[n] > 0) {
          const p = freq[n] / total;
          freqEntropy -= p * Math.log(p);
        }
      }
      // 归一化到 [0, 1]
      freqEntropy /= Math.log(size);
    }
  }

  const maxAC = (pick * (pick - 1) / 2) - (pick - 1);
  return [
    sum / 100,                      // 0
    span / size,                    // 1
    odd / pick,                     // 2
    big / pick,                     // 3
    primes / pick,                  // 4
    zone[0] / pick,                 // 5
    zone[1] / pick,                 // 6
    zone[2] / pick,                 // 7
    Math.max(0, ac / Math.max(1, maxAC)),  // 8
    consec / pick,                  // 9
    Math.min(1, missMax / 30),      // 10
    recentHit,                      // 11
    freqEntropy,                    // 12
    history.length > 0 ? Math.min(1, history.length / 3000) : 0, // 13: 数据成熟度
  ];
}

function isPrime(n) {
  if (n < 2) return false;
  if (n === 2) return true;
  if (n % 2 === 0) return false;
  for (let i = 3; i * i <= n; i += 2) if (n % i === 0) return false;
  return true;
}

/* ============================================================
 * 把特征追加到 multi-hot 向量
 * ============================================================
 *
 * 输入：原 multi-hot vector (Float32Array, length=baseDim)
 * 输出：拼接 [original ... features] (length=baseDim+14)
 *
 * 仅在样本构建时调用一次；训练时不变。
 */
export function appendFeatures(multiHot, features, baseDim) {
  const out = new Float32Array(baseDim + FEATURE_AUG_DIM);
  out.set(multiHot, 0);
  for (let i = 0; i < FEATURE_AUG_DIM; i++) out[baseDim + i] = features[i];
  return out;
}
