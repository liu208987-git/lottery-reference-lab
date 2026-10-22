// Split conformal prediction for top-K set coverage.
//
// 问题：模型给出每号 33 维概率 p_i。如果直接 top-6，没法说"红球真号有
// X% 概率出现在我的预测集里"。这是大多数概率模型的通病。
//
// Split conformal 给一个无参数 finite-sample 频率主义保证：
//   先在 calibration set 算每期 nonconformity score s_i（"真号被我排到多
//   靠后" 的程度）；α-quantile 取 q_α；预测时把所有 score(候选号) ≤ q_α
//   的号加进集合，得到的预测集大小自适应，但 marginal coverage 保证 ≥ 1−α。
//
// 与温度校准的区别：
//   - 温度校准修概率"锐度"（仍是单点估计）
//   - 共形给"集合大小自适应、覆盖率有保证"的预测集
//
// 设计选择：使用 inverse-rank score（最简单可解释）：
//   nonconformity(i) = 1 − probRank(i)
//   其中 probRank(i) 是号 i 在 33 维概率从高到低排序后的归一化排名
//   （argmax 排名 0 → score 最低；argmin → 最高）。
//   等价于"模型有多不愿意挑这个号"。
//
// 输入：
//   calibrationRecords = [{ probs: Float32Array, realSet: number[] }, ...]
//
// 输出：
//   { qHat, alpha, predict(probs): { set: number[], avgSize, indicators } }

/** 计算每个号的归一化逆 rank（高概率 → 低 score）。
 *  返回 Float32Array，length === probs.length，值域 [0, 1]。 */
export function inverseRankScore(probs) {
  const N = probs.length;
  const indexed = [];
  for (let i = 0; i < N; i++) indexed.push([i, probs[i]]);
  indexed.sort((a, b) => b[1] - a[1]); // 概率降序
  const score = new Float32Array(N);
  for (let r = 0; r < N; r++) {
    const idx = indexed[r][0];
    score[idx] = r / Math.max(1, N - 1); // [0, 1]
  }
  return score;
}

/**
 * 在 calibration set 上拟合 q_hat（共形阈值）。
 * @param records  Array<{probs: Float32Array | number[], realSet: number[]}>
 * @param alpha    显著性水平，0.1 = 90% coverage
 * @returns        { qHat, alpha, n, scores }
 */
export function fitConformalThreshold(records, alpha = 0.1) {
  if (!records || records.length < 5) {
    return { qHat: 1, alpha, n: 0, scores: [] };
  }
  const allRealScores = []; // 每期的真号 score 的最大值（覆盖最差号）
  for (const rec of records) {
    const probs = rec.probs instanceof Float32Array ? rec.probs : Float32Array.from(rec.probs);
    const score = inverseRankScore(probs);
    let maxScore = 0;
    for (const num of rec.realSet) {
      const s = score[num - 1]; // num 从 1 开始
      if (s > maxScore) maxScore = s;
    }
    allRealScores.push(maxScore);
  }
  allRealScores.sort((a, b) => a - b);
  const n = allRealScores.length;
  // 有限样本修正：取 ⌈(n+1)(1-α)⌉/n 分位
  const idx = Math.min(n - 1, Math.ceil((n + 1) * (1 - alpha)) - 1);
  const qHat = allRealScores[idx];
  return { qHat, alpha, n, scores: allRealScores };
}

/**
 * 用 q_hat 预测：返回 score ≤ q_hat 的号集合。
 * @param probs    Float32Array | number[]
 * @param qHat     fitConformalThreshold 返回的阈值
 * @returns        { set: number[], indicators: Uint8Array, size }
 */
export function conformalPredict(probs, qHat) {
  const arr = probs instanceof Float32Array ? probs : Float32Array.from(probs);
  const score = inverseRankScore(arr);
  const N = arr.length;
  const set = [];
  const indicators = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (score[i] <= qHat + 1e-9) {
      set.push(i + 1);
      indicators[i] = 1;
    }
  }
  return { set, indicators, size: set.length };
}

/**
 * 在 test set 上验证经验覆盖率 + 平均集合大小。
 * @returns { coverage, avgSize, n }
 */
export function evaluateCoverage(testRecords, qHat) {
  if (!testRecords.length) return { coverage: 0, avgSize: 0, n: 0 };
  let hits = 0, totalSize = 0;
  for (const rec of testRecords) {
    const probs = rec.probs instanceof Float32Array ? rec.probs : Float32Array.from(rec.probs);
    const { set, size } = conformalPredict(probs, qHat);
    totalSize += size;
    // 全部真号都在集合内 → covered
    const covered = rec.realSet.every((n) => set.includes(n));
    if (covered) hits++;
  }
  return {
    coverage: hits / testRecords.length,
    avgSize: totalSize / testRecords.length,
    n: testRecords.length,
  };
}

/**
 * 端到端：从一组 backtest records（含 probs + realReds/realFront）一次
 * 完成 split conformal：前 50% calibrate，后 50% evaluate。
 *
 * @param records       Array<{probs, realSet}>
 * @param alpha         显著性水平
 * @param splitRatio    calibration 占比，默认 0.5
 * @returns             { qHat, alpha, coverage, avgSize, expectedCoverage, calN, testN }
 */
export function splitConformal(records, alpha = 0.1, splitRatio = 0.5) {
  const n = records.length;
  if (n < 20) {
    return { qHat: 1, alpha, coverage: null, avgSize: null, expectedCoverage: 1 - alpha, calN: 0, testN: 0, warning: "数据不足（最少 20 期）" };
  }
  const calN = Math.floor(n * splitRatio);
  const calRecords = records.slice(0, calN);
  const testRecords = records.slice(calN);
  const fit = fitConformalThreshold(calRecords, alpha);
  const evalRes = evaluateCoverage(testRecords, fit.qHat);
  return {
    qHat: fit.qHat,
    alpha,
    coverage: evalRes.coverage,
    avgSize: evalRes.avgSize,
    expectedCoverage: 1 - alpha,
    calN,
    testN: evalRes.n,
  };
}
