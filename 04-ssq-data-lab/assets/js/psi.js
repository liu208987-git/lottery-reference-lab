// Population Stability Index (PSI) + KL 漂移检测
//
// 问题：训练集是 2010-2020，测试集是 2024。号码分布有没有漂移？
// 这是部署 ML 模型后最常被忽略的问题——分布漂移会让模型在新数据上失败。
//
// PSI 公式：
//   PSI = Σ_i (q_i - p_i) · log(q_i / p_i)
//   其中 p_i = 训练分布，q_i = 测试分布（每个 bin/号码的归一化频率）
//
// 解读（金融业经验值）：
//   PSI < 0.1   分布稳定
//   0.1 ≤ PSI < 0.25  轻微漂移，监控
//   PSI ≥ 0.25  显著漂移，重新训练
//
// PSI 与 KL 的关系：PSI = KL(p‖q) + KL(q‖p)，对称
//
// 在彩票场景：
//   - 双色球 33 红球频率分布 vs 不同年份 → 检测物理设备是否变了
//   - 训练 / 验证 / 测试 set 之间的分布漂移
//   - 如果 PSI 长期 > 0.1，说明模型应该用滑动窗口 train

const EPS = 1e-9;

/**
 * 计算两个频率分布之间的 PSI。
 * @param p Array<number>  分布 1（会自动归一化）
 * @param q Array<number>  分布 2
 * @param opts.smoothing  Laplace 平滑（防 0），默认 0.5
 * @returns {
 *   psi: number,
 *   contributions: Array<{i, p, q, term}>,   每 bin 贡献度（用于诊断哪些号漂移最大）
 *   verdict: "stable" | "minor" | "major"
 * }
 */
export function populationStabilityIndex(p, q, { smoothing = 0.5 } = {}) {
  if (p.length !== q.length) throw new Error(`length mismatch: ${p.length} vs ${q.length}`);
  const N = p.length;

  const sumP = p.reduce((s, v) => s + v, 0);
  const sumQ = q.reduce((s, v) => s + v, 0);
  if (sumP <= 0 || sumQ <= 0) {
    return { psi: 0, contributions: [], verdict: "undefined" };
  }
  const pn = new Array(N), qn = new Array(N);
  for (let i = 0; i < N; i++) {
    pn[i] = (p[i] + smoothing) / (sumP + smoothing * N);
    qn[i] = (q[i] + smoothing) / (sumQ + smoothing * N);
  }

  let psi = 0;
  const contributions = [];
  for (let i = 0; i < N; i++) {
    const term = (qn[i] - pn[i]) * Math.log((qn[i] + EPS) / (pn[i] + EPS));
    psi += term;
    contributions.push({ i: i + 1, p: pn[i], q: qn[i], term });
  }
  // 排序找贡献最大者
  contributions.sort((a, b) => Math.abs(b.term) - Math.abs(a.term));

  let verdict;
  if (psi < 0.1) verdict = "stable";
  else if (psi < 0.25) verdict = "minor";
  else verdict = "major";

  return { psi, contributions, verdict };
}

/**
 * 给定 draws，按某个 zone 计算频率分布。
 */
export function frequencyDist(draws, zoneKey, size) {
  const f = new Array(size).fill(0);
  for (const d of draws) {
    const v = d[zoneKey];
    if (Array.isArray(v)) {
      for (const n of v) if (n >= 1 && n <= size) f[n - 1]++;
    } else if (typeof v === "number") {
      if (v >= 1 && v <= size) f[v - 1]++;
    }
  }
  return f;
}

/**
 * 端到端：把 draws 按时间二分（早 vs 晚）算 PSI。
 * @param draws  时间正序
 * @param zoneKey "reds" | "front" | "blue" | "back"
 * @param size   N
 * @param splitRatio 默认 0.5
 */
export function temporalPSI(draws, zoneKey, size, splitRatio = 0.5) {
  if (draws.length < 50) {
    return { warning: `数据量不足（${draws.length} < 50）` };
  }
  const split = Math.floor(draws.length * splitRatio);
  const early = draws.slice(0, split);
  const late = draws.slice(split);
  const fEarly = frequencyDist(early, zoneKey, size);
  const fLate = frequencyDist(late, zoneKey, size);
  const r = populationStabilityIndex(fEarly, fLate);
  return {
    ...r,
    earlyN: early.length,
    lateN: late.length,
    earlyDist: fEarly,
    lateDist: fLate,
  };
}

/**
 * 滑动窗口 PSI：每个窗口 w 期 vs 全历史，输出 PSI 时间序列。
 * 用于检测"何时开始漂移"。
 */
export function rollingPSI(draws, zoneKey, size, windowSize = 100) {
  if (draws.length < windowSize * 2) return [];
  const fAll = frequencyDist(draws, zoneKey, size);
  const series = [];
  for (let end = windowSize; end <= draws.length; end += Math.max(1, Math.floor(windowSize / 4))) {
    const window = draws.slice(end - windowSize, end);
    const fWin = frequencyDist(window, zoneKey, size);
    const r = populationStabilityIndex(fWin, fAll);
    series.push({
      endIdx: end - 1,
      issue: draws[end - 1].issue,
      psi: r.psi,
      verdict: r.verdict,
    });
  }
  return series;
}
