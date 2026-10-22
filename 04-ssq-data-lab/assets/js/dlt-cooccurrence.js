// 大乐透前区共现矩阵（35×35）
//
// 大乐透每期前区 5 个号，两两组合贡献 C(5,2)=10 次共现；
// 任何号码 n 的累计共现总和 = 4 × freq(n)。
//
// 在严格随机的大乐透里，给定 a 出现，b 出现的条件概率应趋近 4/34（剩余 34 个里抽 4 个），
// 因此理论 lift = (4/34) / (5/35) ≈ 0.8235 作为独立基线。

export const FRONT_INDEPENDENT_LIFT_BASELINE = (4 / 34) / (5 / 35);

/** 35×35 共现矩阵（对角线为 0），按 d.front 累积。 */
export function buildDltCooccurrenceMatrix(draws, size = 35) {
  const m = Array.from({ length: size + 1 }, () => Array(size + 1).fill(0));
  for (const d of draws) {
    const f = d.front;
    for (let i = 0; i < f.length; i++) {
      for (let j = i + 1; j < f.length; j++) {
        const a = f[i];
        const b = f[j];
        m[a][b] += 1;
        m[b][a] += 1;
      }
    }
  }
  return m;
}

/** Top k 个最常一起出现的号码。 */
export function topDltPartners(matrix, n, k = 5, size = 35) {
  const pairs = [];
  for (let m = 1; m <= size; m++) {
    if (m === n) continue;
    pairs.push([m, matrix[n][m]]);
  }
  pairs.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return pairs.slice(0, k);
}

export function dltLiftOf(matrix, freqFront, totalDraws, a, b) {
  if (totalDraws === 0) return 0;
  const pa = freqFront[a] / totalDraws;
  const pb = freqFront[b] / totalDraws;
  if (pa === 0 || pb === 0) return 0;
  const pab = matrix[a][b] / totalDraws;
  return pab / (pa * pb);
}

/** 偏离独立基线最远的若干对。 */
export function extremeDltPairs(matrix, freqFront, totalDraws, k = 8, size = 35) {
  const baseline = FRONT_INDEPENDENT_LIFT_BASELINE;
  const out = [];
  for (let i = 1; i <= size; i++) {
    for (let j = i + 1; j <= size; j++) {
      const obs = matrix[i][j];
      if (obs === 0) continue;
      const lift = dltLiftOf(matrix, freqFront, totalDraws, i, j);
      out.push({ a: i, b: j, count: obs, lift, deviation: lift - baseline });
    }
  }
  out.sort((x, y) => Math.abs(y.deviation) - Math.abs(x.deviation));
  return out.slice(0, k);
}
