// 离散概率分布的距离度量
//
// 用途：量化"采样器输出的频率分布"与"目标分布（如均匀/历史/后验）"的差异。
// 我们可以用这些指标在 UI 上给出采样质量的客观分数。
//
// 指标对比：
//   KL(P‖Q) - 不对称、若 Q_i=0 而 P_i>0 则发散。理论意义最强（信息论）
//   JS(P,Q) - 对称且有界（[0, log2]），KL 的对称化，适合做"分数"
//   Wasserstein-1 - 顺序敏感（号码 1 与 33 比 1 与 2 更"远"），物理直觉好

/** 把分布 p 归一化（防止累积浮点误差导致总和 ≠ 1）。 */
export function normalize(p) {
  const s = p.reduce((a, b) => a + b, 0);
  if (s <= 0) return p.map(() => 0);
  return p.map((x) => x / s);
}

/** KL(P‖Q) = Σ p_i · log(p_i/q_i)，自然对数。 */
export function klDivergence(p, q) {
  if (p.length !== q.length) throw new Error("length mismatch");
  let kl = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] <= 0) continue;
    if (q[i] <= 0) return Infinity;
    kl += p[i] * Math.log(p[i] / q[i]);
  }
  return kl;
}

/** Jensen-Shannon divergence（对称、有界、平方根可作真度量）。 */
export function jsDivergence(p, q) {
  const m = p.map((x, i) => 0.5 * (x + q[i]));
  return 0.5 * klDivergence(p, m) + 0.5 * klDivergence(q, m);
}

/** JS 距离 = sqrt(JSD)，是合法的度量（满足三角不等式）。 */
export function jsDistance(p, q) {
  return Math.sqrt(jsDivergence(p, q));
}

/**
 * Wasserstein-1（一维 EMD）。对一维序数离散分布，
 * W1 = Σ |F_p(i) - F_q(i)|，F 是 CDF。
 * 适合号码这种"有序"空间——号码 1 与 33 之间的差异 > 1 与 2。
 */
export function wassersteinDistance(p, q) {
  if (p.length !== q.length) throw new Error("length mismatch");
  let cdfP = 0;
  let cdfQ = 0;
  let w = 0;
  for (let i = 0; i < p.length; i++) {
    cdfP += p[i];
    cdfQ += q[i];
    w += Math.abs(cdfP - cdfQ);
  }
  return w;
}

/** 把"采样多注 → 数字频率"转成分布（1-indexed，size+1 长）。 */
export function ticketsToFreqDist(tickets, size) {
  const f = Array(size + 1).fill(0);
  for (const t of tickets) for (const r of t.reds) f[r] += 1;
  const slice = f.slice(1);
  return [0, ...normalize(slice)];
}

/** 期望均匀分布（红球 6/33 概率 = 1/33 归一频率；蓝球 1/16）。 */
export function uniformDist(size) {
  const p = Array(size + 1).fill(0);
  for (let i = 1; i <= size; i++) p[i] = 1 / size;
  return p;
}

/** 综合质量分（0-100），越高越接近目标分布；JS 距离低 + Wasserstein 低。 */
export function samplingQualityScore(observed, target) {
  // 把两个度量映射到 [0,1]，再加权
  const js = jsDistance(observed, target); // ∈ [0, sqrt(log2)] ≈ [0, 0.83]
  const w = wassersteinDistance(observed, target); // 这里 size=33 时上界约 8
  const jsScore = Math.max(0, 1 - js / 0.83);
  const wScore = Math.max(0, 1 - w / 8);
  return Math.round(100 * (0.6 * jsScore + 0.4 * wScore));
}
