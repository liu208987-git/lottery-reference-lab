// Backtest 的统计严谨性辅助
//
// 核心：把"LSTM hit@6 = 1.18，均匀基线 = 1.09"这种点值差，
// 升级成"LSTM 95% CI = [0.95, 1.42]，与基线 1.09 重叠"——一个工程师能立刻读懂的判断。
//
// 1. Bootstrap CI：样本重采样 B 次，得到 metric 的经验分布
// 2. 配对 z 检验：两组在同一期上的差值
// 3. Reliability diagram：把预测概率分桶，看每桶里"真实命中率 vs 平均预测概率"
//    完美校准 → 点在对角线 y=x 上

import { createRng } from "./rng.js";

/**
 * Bootstrap 重采样：从 records 中有放回抽样 B 次，对每次重采样计算 metric，
 * 返回 B 个 metric 值的 (lower, upper) 分位数。
 */
export function bootstrapCI(records, metricFn, { B = 500, level = 0.95, seed = "bs" } = {}) {
  const n = records.length;
  if (n === 0) return { mean: 0, lower: 0, upper: 0, samples: [] };
  const rng = createRng(seed).next;
  const samples = new Array(B);
  for (let b = 0; b < B; b++) {
    const resample = new Array(n);
    for (let i = 0; i < n; i++) resample[i] = records[Math.floor(rng() * n)];
    samples[b] = metricFn(resample);
  }
  samples.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  const loIdx = Math.max(0, Math.floor(alpha * B));
  const hiIdx = Math.min(B - 1, Math.ceil((1 - alpha) * B) - 1);
  const mean = samples.reduce((s, x) => s + x, 0) / B;
  return {
    mean,
    lower: samples[loIdx],
    upper: samples[hiIdx],
    samples,
  };
}

/** 给定两组配对样本（按相同期数），算配对差值的均值与 95% CI。 */
export function pairedBootstrap(recordsA, recordsB, metricFn, { B = 500, seed = "pbs" } = {}) {
  const n = Math.min(recordsA.length, recordsB.length);
  if (n === 0) return { mean: 0, lower: 0, upper: 0 };
  const rng = createRng(seed).next;
  const samples = new Array(B);
  for (let b = 0; b < B; b++) {
    const a = new Array(n), bb = new Array(n);
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      a[i] = recordsA[idx];
      bb[i] = recordsB[idx];
    }
    samples[b] = metricFn(a) - metricFn(bb);
  }
  samples.sort((x, y) => x - y);
  const lo = samples[Math.floor(0.025 * B)];
  const hi = samples[Math.ceil(0.975 * B) - 1];
  const mean = samples.reduce((s, x) => s + x, 0) / B;
  return { mean, lower: lo, upper: hi, samples };
}

/** Metric: average red Top-6 hit. */
export const metricAvgHit6 = (records) => {
  if (records.length === 0) return 0;
  let s = 0;
  for (const r of records) s += r.redHit6;
  return s / records.length;
};

/** Metric: blue accuracy. */
export const metricBlueAcc = (records) => {
  if (records.length === 0) return 0;
  let s = 0;
  for (const r of records) s += (typeof r.blueHit === "boolean" ? (r.blueHit ? 1 : 0) : r.blueHit);
  return s / records.length;
};

/**
 * Reliability diagram：把预测概率分到 [0, 1/N, 2/N, ...] 桶，
 * 每桶里计算 (avgPredProb, observedHitRate)。
 *
 * 完美校准的模型：avgPredProb ≈ observedHitRate。
 *
 * 输入：records，每条 record 必须含 redProbs[33] 与 realReds[6]
 *      （从 backtestModel 的输出来）
 *
 * 把全部 records × 33 个号码展开成 (prob, hit ∈ {0,1}) 大集合，再分桶。
 */
export function reliabilityDiagram(records, { bins = 10, redIndices = null } = {}) {
  const buckets = Array.from({ length: bins }, () => ({ sumP: 0, sumY: 0, count: 0 }));
  const idxList = redIndices || Array.from({ length: 33 }, (_, i) => i);
  for (const r of records) {
    if (!r.redProbs) continue;
    for (const i of idxList) {
      const p = r.redProbs[i];
      const y = r.realReds.includes(i + 1) ? 1 : 0;
      let b = Math.floor(p * bins);
      if (b >= bins) b = bins - 1;
      if (b < 0) b = 0;
      buckets[b].sumP += p;
      buckets[b].sumY += y;
      buckets[b].count += 1;
    }
  }
  const points = buckets.map((b, i) => ({
    binStart: i / bins,
    binEnd: (i + 1) / bins,
    avgPred: b.count > 0 ? b.sumP / b.count : (i + 0.5) / bins,
    observedFreq: b.count > 0 ? b.sumY / b.count : null,
    count: b.count,
  }));
  // Expected Calibration Error (ECE)
  const total = buckets.reduce((s, b) => s + b.count, 0);
  let ece = 0;
  for (const b of buckets) {
    if (b.count === 0) continue;
    const avgP = b.sumP / b.count;
    const obs = b.sumY / b.count;
    ece += (b.count / total) * Math.abs(avgP - obs);
  }
  return { points, ece };
}

/** 二项均匀基线对应的 hit@K：K * 6 / 33。 */
export function uniformBaselineHitK(K) {
  return K * 6 / 33;
}

/** 计算两组样本的 Brier score 差异 + paired bootstrap CI。 */
export const metricAvgBrier = (records) => {
  if (records.length === 0) return 0;
  let s = 0; let n = 0;
  for (const r of records) if (r.brier != null) { s += r.brier; n++; }
  return n === 0 ? 0 : s / n;
};


/* =========================================================
   Brier Skill Score (BSS)
   ─────────────────────────────────────────────────────────
   BSS = 1 - BS_model / BS_ref
     - BS_ref：参考预测器的 Brier 分数（一般用"气候平均"——所有号码 = 6/33）
     - BSS > 0 表示优于参考；BSS < 0 表示劣于参考；BSS = 1 表示完美
   BSS 比 raw Brier 更直观，因为它把"基线难度"折算掉了。
   ========================================================= */

/**
 * 给 records 列表（含 redProbs[size] 和 realReds），计算 BSS。
 * @param records
 * @param size 号码空间大小（SSQ 红 33，DLT 前 35）
 * @param pick 每期摇出几个（SSQ 红 6，DLT 前 5）
 *             — 用来定 climatology baseline = pick / size
 */
export function brierSkillScore(records, size = 33, pick = 6) {
  if (!records || records.length === 0) return { bss: 0, bsModel: 0, bsRef: 0 };
  const baseline = pick / size;
  let bsModel = 0, bsRef = 0;
  let n = 0;
  for (const r of records) {
    if (!r.redProbs || !r.realReds) continue;
    for (let i = 0; i < size; i++) {
      const p = r.redProbs[i];
      const y = r.realReds.includes(i + 1) ? 1 : 0;
      bsModel += (p - y) ** 2;
      bsRef += (baseline - y) ** 2;
    }
    n++;
  }
  if (n === 0 || bsRef === 0) return { bss: 0, bsModel: 0, bsRef: 0 };
  bsModel /= (n * size);
  bsRef /= (n * size);
  return {
    bss: 1 - bsModel / bsRef,
    bsModel, bsRef,
    n, size, pick, baseline,
  };
}

/* =========================================================
   Permutation test
   ─────────────────────────────────────────────────────────
   对"模型 vs 基线"的 metric 差，做 paired permutation test：
     - 配对：第 i 期模型分数 m_i 和基线分数 b_i
     - 原始观察 d_obs = mean(m - b)
     - 置换：随机翻转每个 (m_i, b_i) 的"配对身份"，重算 d_perm
     - p 值 = #{|d_perm| >= |d_obs|} / B
   这是比 paired bootstrap 更严格的"无分布假设"显著性检验。
   ========================================================= */

/**
 * 配对置换检验：对"模型 vs 基线"的 metric 差，做 paired permutation test。
 *
 * @param recordsA / recordsB 必须等长且 i 期对 i 期
 * @param metricFn(record) → number  把单个 record 映射成标量
 * @param B 重复次数（默认 1000）
 * @param seed 重现用
 * @returns { meanDiff, pTwoSided, observed, distribution }
 *
 * 兼容性：如果 metricFn 是"records[] → number"形式（如 metricAvgHit6），
 * 我们也支持 — 通过 `(record) => metricFn([record])` 来包装。
 */
export function permutationTest(recordsA, recordsB, metricFn, { B = 1000, seed = "perm" } = {}) {
  const n = Math.min(recordsA.length, recordsB.length);
  if (n === 0) return { meanDiff: 0, pTwoSided: 1, observed: 0, distribution: [] };

  // 统一 metric 调用方式：先尝试当 per-record；如果抛错或返回非有限数，
  // 退化成 batch 版本（包成单元素数组）。
  let toScalar;
  try {
    const probe = metricFn(recordsA[0]);
    if (Number.isFinite(probe)) {
      toScalar = (rec) => metricFn(rec);
    } else {
      toScalar = (rec) => metricFn([rec]);
    }
  } catch {
    toScalar = (rec) => metricFn([rec]);
  }

  const a = recordsA.slice(0, n).map(toScalar);
  const b = recordsB.slice(0, n).map(toScalar);
  let observed = 0;
  for (let i = 0; i < n; i++) observed += a[i] - b[i];
  observed /= n;

  // 用简单 LCG 做种子可重现
  let state = 0;
  for (let i = 0; i < seed.length; i++) state = (state * 31 + seed.charCodeAt(i)) >>> 0;
  const rng = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };

  let extreme = 0;
  const distribution = [];
  for (let r = 0; r < B; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      // 按 50% 概率交换 a[i] 和 b[i]
      const swap = rng() < 0.5;
      s += swap ? (b[i] - a[i]) : (a[i] - b[i]);
    }
    s /= n;
    distribution.push(s);
    if (Math.abs(s) >= Math.abs(observed) - 1e-12) extreme++;
  }

  return {
    observed,
    pTwoSided: extreme / B,
    meanDiff: observed,
    distribution,
    samples: B,
  };
}
