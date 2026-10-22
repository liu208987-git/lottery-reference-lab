// 走势图右侧标准列：出现次数 / 平均遗漏 / 最大遗漏 / 当前遗漏
//
// "遗漏期数" 指相邻两次出现之间未出现的期数。例如号码 7 的出现序列为
// 第 [3, 10, 12] 期，则间隔为 [3, 7, 2]（3=从开始到首现; 7,2=两次相邻出现的间隔），
// 当前遗漏 = totalDraws - 12。
//
// "平均遗漏" = 期数总和 / 出现次数（即 1 / 频率，等价"周期"）。
// "最大遗漏" = 历史上最长一次未出现期数（含当前正在持续的遗漏）。

/**
 * 计算单一号码集合（reds 或 blue）下，每个号码的 freq / avgMiss / maxMiss / currentMiss。
 * @param draws 历史数据，按时间升序
 * @param size 号码空间大小（红=33，蓝=16）
 * @param field "reds" 或 "blue"
 */
export function missStats(draws, size, field = "reds") {
  const total = draws.length;
  const stats = Array.from({ length: size + 1 }, () => ({
    freq: 0,
    avgMiss: 0,
    maxMiss: 0,
    currentMiss: 0,
  }));

  for (let n = 1; n <= size; n++) {
    let lastSeen = -1; // 上次出现的索引（-1 = 从未出现）
    let maxMiss = 0;
    let freq = 0;
    for (let i = 0; i < total; i++) {
      const hit = field === "reds" ? draws[i].reds.includes(n) : draws[i].blue === n;
      if (hit) {
        const gap = i - lastSeen - 1; // 这次出现前累计未出期数
        // 首次出现前的"开局未出"也算一次遗漏（业界惯例）
        if (gap > maxMiss) maxMiss = gap;
        lastSeen = i;
        freq++;
      }
    }
    const currentMiss = lastSeen === -1 ? total : total - 1 - lastSeen;
    if (currentMiss > maxMiss) maxMiss = currentMiss;
    const avgMiss = freq === 0 ? total : total / freq - 1;
    stats[n] = { freq, avgMiss, maxMiss, currentMiss };
  }
  return stats;
}


/**
 * 增强版：返回 missStats + 每号码的 χ² p 值（"频次显著偏离均匀"的统计检验）
 *
 * 单号 χ² 用 binomial 近似：
 *   期望次数 E = totalDraws × (pick / size)
 *   观察次数 O = freq
 *   χ²₁ = (O - E)² / E + (O' - E')² / E'   其中 O' = totalDraws - O，E' = ... (片刻)
 *
 * 单 cell goodness-of-fit：
 *   χ² = (O - E)² / E（粗略）
 *   严格用 binomial test 算双侧 p 值更准。
 *
 * 这里用 z-score（连续修正的二项近似）：
 *   z = (O - E) / sqrt(E × (1 − pick/size))
 *   p_two = 2 × (1 − Φ(|z|))
 *
 * @param draws 历史
 * @param size  号码空间（33/16/35/12）
 * @param pick  每期抽几个（6/1/5/2）
 * @param field "reds"/"blue"/"front"/"back"
 * @param alpha 显著性水平（默认 0.05），用于标记 isSignificant
 * @returns 同 missStats，但每条加 { expected, zScore, pValue, isSignificant }
 */
export function missStatsWithSignificance(draws, size, pick, field = "reds", alpha = 0.05) {
  const base = missStats(draws, size, field);
  const total = draws.length;
  const pPerNum = pick / size;          // 单号每期出现概率
  const expected = total * pPerNum;
  const variance = total * pPerNum * (1 - pPerNum);
  const stdDev = Math.sqrt(variance);

  for (let n = 1; n <= size; n++) {
    const O = base[n].freq;
    // z = (O - E) / sd
    const z = stdDev > 0 ? (O - expected) / stdDev : 0;
    const pTwo = 2 * (1 - normCdf(Math.abs(z)));
    base[n].expected = expected;
    base[n].zScore = z;
    base[n].pValue = pTwo;
    base[n].isSignificant = pTwo < alpha;
    base[n].direction = O > expected ? "hot" : O < expected ? "cold" : "neutral";
  }

  // Bonferroni 修正（多重检验）：按号码数量调 alpha
  const bonferroniAlpha = alpha / size;
  for (let n = 1; n <= size; n++) {
    base[n].isSignificantBonferroni = base[n].pValue < bonferroniAlpha;
  }

  return {
    stats: base,
    summary: {
      total, pick, size, expected, stdDev,
      alpha, bonferroniAlpha,
      hotCount: base.filter((s, i) => i > 0 && s.isSignificant && s.direction === "hot").length,
      coldCount: base.filter((s, i) => i > 0 && s.isSignificant && s.direction === "cold").length,
      // Bonferroni 修正后的"真异常"
      strictHot: base.filter((s, i) => i > 0 && s.isSignificantBonferroni && s.direction === "hot").length,
      strictCold: base.filter((s, i) => i > 0 && s.isSignificantBonferroni && s.direction === "cold").length,
    },
  };
}

/** 标准正态 CDF（Abramowitz-Stegun 26.2.17）。 */
function normCdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const xx = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * xx);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-xx * xx);
  return 0.5 * (1.0 + sign * y);
}
