// Temperature Scaling 校准（Guo 2017）
//
// 问题：现代神经网络（含 LSTM）训练完成后**普遍过自信**——预测概率
// 80% 时实际命中只有 50%。这是 SGD + 强表达能力的副作用。
//
// 解法：训练后**冻结所有权重**，仅学一个标量 T > 0：
//   p_calibrated = sigmoid(z / T)        (multi-label)
//   p_calibrated = softmax(z / T)        (multi-class)
// T > 1 → 把概率往 0.5 拉近（降低自信）
// T < 1 → 推向极端（更自信）
// T = 1 → 原始
//
// 为什么单参数足够：
//   - argmax 不变（rank 不变），所以 hit@K 不变
//   - 只改变概率"分布锐度"，校准是单调变换
//   - 强凸 1D 优化，永远有全局最优
//
// 优化方法：直接 1D 黄金分割搜索 T ∈ [0.1, 10]，最小化 val 集 NLL。
// 梯度法也行（解析很简单），但 1D 搜索更稳、20 次迭代收敛。
//
// 用法：
//   const cal = fitTemperatureSigmoid(valSamples.map(s => s.logits), valSamples.map(s => s.targets));
//   const calibratedP = applyTemperatureSigmoid(rawLogits, cal.T);

/** 黄金分割搜索 1D 凸函数最小值。 */
function goldenSearch(f, lo, hi, tol = 1e-4, maxIter = 80) {
  const phi = (Math.sqrt(5) - 1) / 2; // ≈ 0.618
  let a = lo, b = hi;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = f(c), fd = f(d);
  let i = 0;
  while (b - a > tol && i++ < maxIter) {
    if (fc < fd) {
      b = d; d = c; fd = fc;
      c = b - phi * (b - a);
      fc = f(c);
    } else {
      a = c; c = d; fc = fd;
      d = a + phi * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

/** 边界扩展搜索：先在 [0.05, 50] 找；触上/下界则报 boundaryHit。
 *  另外检测 NLL plateau —— 如果 NLL(1) 与 NLL(T*) 改善 < `plateauTol`，
 *  说明该方向本来就是平的（model 对该 head 几乎没信号），强制返回 T=1。
 */
const T_LOWER = 0.05;
const T_UPPER = 50;
const T_BOUNDARY_TOL = 0.02;     // 距上下界 2% 视为触界
const NLL_PLATEAU_TOL = 1e-4;    // val NLL 改善 < 1e-4 视为 plateau

function fitTWithBoundaryCheck(nllFn) {
  const T = goldenSearch(nllFn, T_LOWER, T_UPPER);
  const nllAtT = nllFn(T);
  const nllAt1 = nllFn(1);
  const improvement = nllAt1 - nllAtT;
  let boundaryHit = null;
  if (T < T_LOWER * (1 + T_BOUNDARY_TOL)) boundaryHit = "lower";
  else if (T > T_UPPER * (1 - T_BOUNDARY_TOL)) boundaryHit = "upper";

  // 如果改善微乎其微，温度 scaling 没意义，回 T=1
  if (improvement < NLL_PLATEAU_TOL) {
    return { T: 1, nllAt1, nllAtT: nllAt1, improvement: 0, boundaryHit: "plateau" };
  }
  return { T, nllAt1, nllAtT, improvement, boundaryHit };
}

/**
 * 给一批 logits + 二元 targets，拟合最优温度 T*。
 * @param logitsList 数组，每个元素是 {data: Float32Array}（rows×cols 一维即可）
 * @param targetsList 同形状，每个元素是 0/1 二元标签
 * @returns { T, nllAt1, nllAtT, eceAt1, eceAtT, improvement }
 */
export function fitTemperatureSigmoid(logitsList, targetsList) {
  if (logitsList.length === 0) return { T: 1, nllAt1: 0, nllAtT: 0, eceAt1: 0, eceAtT: 0, improvement: 0 };

  // 把所有 logit / target 展平
  const flat = [];
  for (let i = 0; i < logitsList.length; i++) {
    const z = logitsList[i].data;
    const t = targetsList[i].data;
    for (let k = 0; k < z.length; k++) flat.push([z[k], t[k]]);
  }

  const nll = (T) => {
    let s = 0;
    const invT = 1 / T;
    for (const [z, t] of flat) {
      const x = Math.max(-50, Math.min(50, z * invT));
      const p = 1 / (1 + Math.exp(-x));
      const pSafe = Math.max(1e-12, Math.min(1 - 1e-12, p));
      s -= t * Math.log(pSafe) + (1 - t) * Math.log(1 - pSafe);
    }
    return s / flat.length;
  };

  const { T, nllAt1, nllAtT, boundaryHit, improvement } = fitTWithBoundaryCheck(nll);
  const eceAt1 = computeECE(flat, 1);
  const eceAtT = computeECE(flat, T);

  return {
    T,
    nllAt1, nllAtT,
    eceAt1, eceAtT,
    improvement: eceAt1 > 0 ? (eceAt1 - eceAtT) / eceAt1 : 0,
    boundaryHit,                       // null | "lower" | "upper" | "plateau"
    nllImprovement: improvement,
    samples: flat.length,
  };
}

/**
 * Softmax 版（用于 SSQ blue head）。同样 1D 搜索。
 * @param logitsList 每个 element shape == [K, 1]，softmax 在第 0 维
 * @param targetsList 每个 element 是 one-hot
 */
export function fitTemperatureSoftmax(logitsList, targetsList) {
  if (logitsList.length === 0) return { T: 1, nllAt1: 0, nllAtT: 0, eceAt1: 0, eceAtT: 0, improvement: 0 };

  const N = logitsList.length;
  const K = logitsList[0].rows * logitsList[0].cols;

  const nll = (T) => {
    let s = 0;
    const invT = 1 / T;
    for (let n = 0; n < N; n++) {
      const z = logitsList[n].data;
      const t = targetsList[n].data;
      // softmax with temperature
      let max = -Infinity;
      for (let k = 0; k < K; k++) if (z[k] * invT > max) max = z[k] * invT;
      let sum = 0;
      const p = new Float32Array(K);
      for (let k = 0; k < K; k++) {
        p[k] = Math.exp(z[k] * invT - max);
        sum += p[k];
      }
      sum = Math.max(1e-30, sum);
      for (let k = 0; k < K; k++) {
        if (t[k] > 0) s -= t[k] * Math.log(Math.max(1e-12, p[k] / sum));
      }
    }
    return s / N;
  };

  const { T, nllAt1, nllAtT, boundaryHit, improvement } = fitTWithBoundaryCheck(nll);

  // ECE for softmax: 取 argmax 概率为"confidence"
  const collectECE = (T_) => {
    const buckets = Array.from({ length: 10 }, () => ({ sumP: 0, sumY: 0, n: 0 }));
    const invT = 1 / T_;
    for (let n = 0; n < N; n++) {
      const z = logitsList[n].data;
      const t = targetsList[n].data;
      let max = -Infinity, argmax = 0;
      for (let k = 0; k < K; k++) {
        const v = z[k] * invT;
        if (v > max) { max = v; argmax = k; }
      }
      let sum = 0;
      const p = new Float32Array(K);
      for (let k = 0; k < K; k++) {
        p[k] = Math.exp(z[k] * invT - max);
        sum += p[k];
      }
      const conf = p[argmax] / Math.max(1e-30, sum);
      const correct = t[argmax] > 0.5 ? 1 : 0;
      let b = Math.floor(conf * 10);
      if (b > 9) b = 9;
      if (b < 0) b = 0;
      buckets[b].sumP += conf;
      buckets[b].sumY += correct;
      buckets[b].n += 1;
    }
    let ece = 0;
    for (const b of buckets) {
      if (b.n === 0) continue;
      ece += (b.n / N) * Math.abs(b.sumP / b.n - b.sumY / b.n);
    }
    return ece;
  };

  const eceAt1 = collectECE(1);
  const eceAtT = collectECE(T);

  return {
    T, nllAt1, nllAtT,
    eceAt1, eceAtT,
    improvement: eceAt1 > 0 ? (eceAt1 - eceAtT) / eceAt1 : 0,
    boundaryHit,
    nllImprovement: improvement,
    samples: N,
  };
}

/** 给定 raw logits 和 T，返回校准后的 sigmoid 概率（in place 或新建）。 */
export function applyTemperatureSigmoid(logits, T, dst = null) {
  const out = dst || { rows: logits.rows, cols: logits.cols, data: new Float32Array(logits.data.length) };
  const invT = 1 / T;
  for (let i = 0; i < logits.data.length; i++) {
    const x = Math.max(-50, Math.min(50, logits.data[i] * invT));
    out.data[i] = 1 / (1 + Math.exp(-x));
  }
  return out;
}

/** 给定 raw logits 和 T，返回校准后的 softmax 概率。 */
export function applyTemperatureSoftmax(logits, T, dst = null) {
  const out = dst || { rows: logits.rows, cols: logits.cols, data: new Float32Array(logits.data.length) };
  const invT = 1 / T;
  for (let c = 0; c < logits.cols; c++) {
    let max = -Infinity;
    for (let r = 0; r < logits.rows; r++) {
      const v = logits.data[r * logits.cols + c] * invT;
      if (v > max) max = v;
    }
    let sum = 0;
    for (let r = 0; r < logits.rows; r++) {
      const e = Math.exp(logits.data[r * logits.cols + c] * invT - max);
      out.data[r * logits.cols + c] = e;
      sum += e;
    }
    if (sum < 1e-30) sum = 1e-30;
    for (let r = 0; r < logits.rows; r++) {
      out.data[r * logits.cols + c] /= sum;
    }
  }
  return out;
}

/** 计算 ECE（多 bin 加权平均 |conf - acc|）。flat = [[logit, target], ...]。 */
function computeECE(flat, T, bins = 10) {
  const buckets = Array.from({ length: bins }, () => ({ sumP: 0, sumY: 0, n: 0 }));
  const invT = 1 / T;
  for (const [z, t] of flat) {
    const x = Math.max(-50, Math.min(50, z * invT));
    const p = 1 / (1 + Math.exp(-x));
    let b = Math.floor(p * bins);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    buckets[b].sumP += p;
    buckets[b].sumY += t;
    buckets[b].n += 1;
  }
  const total = flat.length;
  let ece = 0;
  for (const b of buckets) {
    if (b.n === 0) continue;
    ece += (b.n / total) * Math.abs(b.sumP / b.n - b.sumY / b.n);
  }
  return ece;
}

/* ============================================================
 * Confidence-aware ranking
 * ============================================================
 *
 * Ensemble 给出每个号码的均值 μ 和 std σ。一个朴素 top-K 选号
 * 只看 μ；但 σ 大表示"不同 ensemble 成员意见分歧大"，**这种号反
 * 而应该降权**。
 *
 * 简单的 lower confidence bound (LCB)：
 *   score(i) = μ_i - λ·σ_i
 * λ ∈ [0, 2]，越大越保守。我们用 λ=1.0 作为稳健默认值
 * （类似 Bayesian UCB 的镜像）。
 *
 * 注意：在 i.i.d. 抽奖上**这不会提高命中期望**，但能：
 *   1. 让多注分散覆盖更稳定（避免重押 ensemble 内部分歧大的号）
 *   2. 给用户传达"不确定性"维度，让选号决策更透明
 */
export function lcbScore(mean, std, lambda = 1.0) {
  return mean - lambda * std;
}

/** 给 ensemble 输出（means + stds）按 LCB 选 top-K。返回 [[num, score, mean, std]]。 */
export function topKByLCB(meansVec, stdsVec, k, lambda = 1.0) {
  const arr = [];
  for (let i = 0; i < meansVec.data.length; i++) {
    const m = meansVec.data[i];
    const s = stdsVec.data[i];
    arr.push([i + 1, lcbScore(m, s, lambda), m, s]);
  }
  arr.sort((a, b) => b[1] - a[1]);
  return arr.slice(0, k);
}
