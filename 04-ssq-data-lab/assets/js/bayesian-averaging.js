// Bayesian Model Averaging (BMA) for ensembles
//
// 标准 ensemble：把 K 个模型的概率简单平均 → P(y) = (1/K) Σ P_k(y)
//
// 这隐含假设"所有模型同等可靠"。但 K 个 LSTM 训练后的 val NLL 不同，
// 应该按 val 似然加权：
//
//   P_BMA(y|x) = Σ_k w_k · P_k(y|x)
//   w_k ∝ exp(-β · NLL_k)
//
// 其中 β 是温度参数（默认 1）。β → 0 退化为均值；β → ∞ 退化为最优单模型。
//
// 物理意义：在 Bayesian 框架下假设模型先验均匀，则 w_k = P(M_k|D)
// 即"给定 val 数据，模型 k 是真模型的后验概率"。
//
// 实现注意：
//   - val NLL 用每模型在 val set 上的平均 cross-entropy
//   - 用 log-sum-exp 数值稳定
//   - 可输出每模型权重 + ensemble 概率 + epistemic uncertainty (std)

/**
 * 给定 K 个模型的 val NLL，返回 BMA 权重。
 * @param valNLLs Array<number> 每模型 val 集 NLL（越低越好）
 * @param beta 温度，默认 1
 * @returns Float64Array of weights summing to 1
 */
export function bmaWeights(valNLLs, beta = 1) {
  const K = valNLLs.length;
  if (K === 0) return new Float64Array(0);
  if (K === 1) return new Float64Array([1]);

  // log w_k = -β · NLL_k - logSumExp
  const logW = new Float64Array(K);
  for (let k = 0; k < K; k++) logW[k] = -beta * valNLLs[k];

  // log-sum-exp 稳定化
  let maxLW = -Infinity;
  for (const v of logW) if (v > maxLW) maxLW = v;
  let sum = 0;
  for (let k = 0; k < K; k++) {
    logW[k] = Math.exp(logW[k] - maxLW);
    sum += logW[k];
  }
  for (let k = 0; k < K; k++) logW[k] /= sum;
  return logW;
}

/**
 * BMA forward：对 K 个模型的概率向量做加权平均。
 * @param probsList Array<Float32Array | number[]>，每个 length=N
 * @param weights Float64Array of length K
 * @returns { mean: Float64Array, std: Float64Array }
 */
export function bmaCombine(probsList, weights) {
  const K = probsList.length;
  if (K === 0) return { mean: new Float64Array(0), std: new Float64Array(0) };
  const N = probsList[0].length;

  const mean = new Float64Array(N);
  const second = new Float64Array(N);  // E[p²] for variance
  for (let k = 0; k < K; k++) {
    const w = weights[k];
    const p = probsList[k];
    for (let i = 0; i < N; i++) {
      mean[i] += w * p[i];
      second[i] += w * p[i] * p[i];
    }
  }
  const std = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const variance = Math.max(0, second[i] - mean[i] * mean[i]);
    std[i] = Math.sqrt(variance);
  }
  return { mean, std };
}

/**
 * 给定一组 ensemble member 的训练 history，提取每个的 best val loss
 * 作为 valNLL，再计算 BMA 权重。
 * @param histories Array<{ valLoss: number[] }>
 */
export function bmaFromHistories(histories, beta = 1) {
  const valNLLs = histories.map((h) => {
    if (!h?.valLoss?.length) return Infinity;
    let best = Infinity;
    for (const v of h.valLoss) if (v < best) best = v;
    return best;
  });
  return {
    weights: bmaWeights(valNLLs, beta),
    valNLLs,
  };
}

/**
 * 自适应 β 选择：用 validation set 上 BMA 概率的 negative log-likelihood
 * 黄金分割搜索 β ∈ [0, 5]。当 K 个模型差不多时 β → 0；当一个明显更好时 β → 大。
 *
 * @param valNLLs Array<number> 每模型 val NLL
 * @param valProbsList  Array<Array<Float32Array>>  每模型在 val 上每条样本的 prob 向量
 * @param valTargets    Array<number[]>  每条样本的真号 (1-indexed)
 * @returns { betaOptimal, weightsAtOptimal, nllAtOptimal }
 */
export function selectOptimalBeta(valNLLs, valProbsList, valTargets) {
  if (valProbsList.length === 0) return { betaOptimal: 1, weightsAtOptimal: new Float64Array(0), nllAtOptimal: 0 };

  const N = valProbsList[0].length;
  const targetsSets = valTargets.map((arr) => new Set(arr));

  const evalNLL = (beta) => {
    const w = bmaWeights(valNLLs, beta);
    let totalNLL = 0;
    let count = 0;
    for (let s = 0; s < N; s++) {
      // 拼装 BMA prob
      const dim = valProbsList[0][s].length;
      const merged = new Float64Array(dim);
      for (let k = 0; k < valProbsList.length; k++) {
        const p = valProbsList[k][s];
        const wk = w[k];
        for (let i = 0; i < dim; i++) merged[i] += wk * p[i];
      }
      // BCE-style NLL
      const tgt = targetsSets[s];
      for (let i = 0; i < dim; i++) {
        const p = Math.max(1e-12, Math.min(1 - 1e-12, merged[i]));
        const y = tgt.has(i + 1) ? 1 : 0;
        totalNLL -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
        count++;
      }
    }
    return totalNLL / Math.max(1, count);
  };

  // 黄金分割
  const phi = (Math.sqrt(5) - 1) / 2;
  let lo = 0, hi = 5;
  let c = hi - phi * (hi - lo);
  let d = lo + phi * (hi - lo);
  let fc = evalNLL(c), fd = evalNLL(d);
  for (let i = 0; i < 30 && (hi - lo) > 0.01; i++) {
    if (fc < fd) {
      hi = d; d = c; fd = fc;
      c = hi - phi * (hi - lo);
      fc = evalNLL(c);
    } else {
      lo = c; c = d; fc = fd;
      d = lo + phi * (hi - lo);
      fd = evalNLL(d);
    }
  }
  const betaOptimal = (lo + hi) / 2;
  return {
    betaOptimal,
    weightsAtOptimal: bmaWeights(valNLLs, betaOptimal),
    nllAtOptimal: evalNLL(betaOptimal),
    nllAtBeta1: evalNLL(1),
    nllAtBeta0: evalNLL(0), // = 均值 ensemble baseline
  };
}
