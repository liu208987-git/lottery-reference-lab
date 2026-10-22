// 卡方拟合优度检验（Chi-squared goodness-of-fit test）
//
// 用来检验"观察到的频次"与"假设的均匀分布"是否显著不同。
// 红球：自由度 df = 32，蓝球：df = 15。
// p 值越大 → 越没理由怀疑"均匀分布"。这个模块就是要给用户看：历史数据无法推翻"彩票是均匀随机"的原假设。

export function chiSquared(observed, expected) {
  if (observed.length !== expected.length) throw new Error("length mismatch");
  let chi = 0;
  for (let i = 0; i < observed.length; i++) {
    if (expected[i] <= 0) continue;
    const diff = observed[i] - expected[i];
    chi += (diff * diff) / expected[i];
  }
  return chi;
}

// 均匀分布下的期望频次：每个号码 = 总出现次数 / 号码空间大小
export function expectedUniform(totalOccurrences, space) {
  const exp = Array(space).fill(totalOccurrences / space);
  return exp;
}

// 计算红球的卡方统计量。红球是 6 选 33，每期贡献 6 次出现。
// observed[0..32] 对应号码 1..33 的出现次数
export function redChi(draws) {
  const observed = Array(33).fill(0);
  for (const d of draws) for (const r of d.reds) observed[r - 1]++;
  const total = draws.length * 6;
  const expected = expectedUniform(total, 33);
  return { chi: chiSquared(observed, expected), df: 32, observed, expected };
}

export function blueChi(draws) {
  const observed = Array(16).fill(0);
  for (const d of draws) observed[d.blue - 1]++;
  const total = draws.length;
  const expected = expectedUniform(total, 16);
  return { chi: chiSquared(observed, expected), df: 15, observed, expected };
}

// 卡方分布右尾 p 值，通过 regularized upper incomplete gamma function Q(a, x) 实现。
// 对 df = 15 或 32 足够精度（数值稳定性在 1e-12 附近）。
export function chiSquaredPValue(chi, df) {
  if (chi <= 0) return 1;
  return regularizedUpperGamma(df / 2, chi / 2);
}

// log-Gamma（Lanczos approximation）
function logGamma(x) {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// 下不完全伽马 Q(a, x) = 1 - P(a, x)，a = df/2
function regularizedUpperGamma(a, x) {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 1;
  if (x < a + 1) return 1 - gserP(a, x);
  return gcfQ(a, x);
}

// 级数展开 P(a, x)
function gserP(a, x) {
  const ITMAX = 200;
  const EPS = 3e-12;
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 1; n <= ITMAX; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) {
      return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
    }
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

// 连分式展开 Q(a, x)
function gcfQ(a, x) {
  const ITMAX = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h * Math.exp(-x + a * Math.log(x) - logGamma(a));
}
