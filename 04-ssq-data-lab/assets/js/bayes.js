// 贝叶斯共轭先验估计号码"被摇出"的概率
//
// 模型设定：
//   每期红球独立摇 6 个；从单一号码角度看，每期"它是否被摇到"是 Bernoulli(p_i)。
//   先验 p_i ~ Beta(α0, β0)；观察到 k 次出现（k 次成功）和 N-k 次未出现，
//   后验 p_i | data ~ Beta(α0 + k, β0 + N - k)。
//
//   选 α0=6, β0=27 作为信息先验，对应"33 个号码每期均匀抽 6 个"的均匀模型期望
//   E[p] = 6/33 ≈ 0.182；这等价于"先看过一期均匀样本"的弱先验。
//
// 与裸频率（k/N）对比：
//   - 频率估计在 k=0 时给出 0，对小样本不可控
//   - 后验均值 (α0+k)/(α0+β0+N) 永远 ∈ (0, 1)，并且自带 shrinkage：
//     向先验收缩，缓解过度拟合
//   - 后验方差 = αβ / [(α+β)²·(α+β+1)]，可量化"我们有多确定"
//
// 应用：
//   - posteriorMean → 替代 freq[i]/N 喂给加权采样
//   - posteriorSample (Thompson sampling) → 每次采样从后验抽 p̂_i 再做权重
//     这是带不确定性的采样，更能反映"小样本号码"的边际分布

/** 红球默认先验：6/33 平均 + 弱强度（共 33 等效观测）。 */
export const RED_PRIOR = { alpha0: 6, beta0: 27 };
/** 蓝球默认先验：1/16 平均 + 弱强度（共 16 等效观测）。 */
export const BLUE_PRIOR = { alpha0: 1, beta0: 15 };

/**
 * 由频次数组（freq[1..size]）计算每个号码的 Beta 后验参数。
 * @param freq freq[i] = 号码 i 出现的总次数
 * @param totalDraws 总期数（红球 = N×6 次试验... 不！这里每期独立伯努利，N 次试验）
 * @param prior {alpha0, beta0}
 * @returns 数组 [{alpha, beta}], 1-indexed（[0] 占位）
 */
export function posteriorParams(freq, totalDraws, prior) {
  const size = freq.length - 1;
  const out = [null];
  const { alpha0, beta0 } = prior;
  for (let i = 1; i <= size; i++) {
    const k = freq[i];
    out.push({ alpha: alpha0 + k, beta: beta0 + totalDraws - k });
  }
  return out;
}

/** 后验均值 = α / (α+β)。 */
export function posteriorMean(params) {
  return params.alpha / (params.alpha + params.beta);
}

/** 后验方差 = αβ / [(α+β)² × (α+β+1)]。 */
export function posteriorVariance(params) {
  const s = params.alpha + params.beta;
  return (params.alpha * params.beta) / (s * s * (s + 1));
}

/**
 * 95% 可信区间（CrI），基于 Beta 分布。
 * 我们没装 jStat，用正态近似 (Wilson-style) + α,β 都不太小的前提；
 * 当 α, β ≥ 10 时与精确 Beta 分位差异 < 1%。
 */
export function posteriorCI(params, level = 0.95) {
  const mean = posteriorMean(params);
  const variance = posteriorVariance(params);
  const sd = Math.sqrt(variance);
  const z = level === 0.95 ? 1.96 : level === 0.99 ? 2.576 : 1.645;
  return {
    lower: Math.max(0, mean - z * sd),
    upper: Math.min(1, mean + z * sd),
  };
}

/** 全部号码的后验均值数组（1-indexed），可作为权重源。 */
export function posteriorMeanArray(freq, totalDraws, prior) {
  const params = posteriorParams(freq, totalDraws, prior);
  const out = Array(freq.length).fill(0);
  for (let i = 1; i < params.length; i++) out[i] = posteriorMean(params[i]);
  return out;
}

/**
 * Thompson Sampling：从每个号码的后验分布各抽一个 p̂_i，作为本轮权重。
 * 优点：自然处理"小样本不确定性"——观测少的号码后验更平坦，被选中概率波动更大；
 *      观测多且偏热的号码 p̂_i 更稳定。
 *
 * 等价于贝叶斯赌博机里的 Thompson Sampling 策略。
 *
 * @param betaSample (α,β)→[0,1) 采样函数（来自 rng.js 的 makeBetaSampler）
 */
export function thompsonWeights(params, betaSample) {
  const out = Array(params.length).fill(0);
  for (let i = 1; i < params.length; i++) {
    out[i] = betaSample(params[i].alpha, params[i].beta);
  }
  return out;
}

/**
 * 计算"是否拒绝 p_i = 1/k"假设的贝叶斯因子（粗略版）：
 * BF = posterior(p=baseline) / prior(p=baseline)，但 Beta 在单点为 0，
 * 我们用对 p 在 (baseline ± δ) 的概率比近似。
 * 这里仅返回"后验 vs 先验"在该窗口的相对支持度，便于解释。
 */
export function shrinkageStrength(params, baseline, delta = 0.02) {
  // 用累计分布近似 P(p in [baseline-δ, baseline+δ])。
  // 这里不做精确 incomplete-Beta，而是返回均值偏离基线的标准化距离：
  //   z = (mean - baseline) / sd
  // 越大表示"后验更偏离先验"。供 UI 解释 shrinkage 行为。
  const mean = posteriorMean(params);
  const sd = Math.sqrt(posteriorVariance(params));
  if (sd === 0) return 0;
  return (mean - baseline) / sd;
}
