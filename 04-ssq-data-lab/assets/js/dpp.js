// k-DPP（k-Determinantal Point Process）greedy MAP 选号
//
// 数学背景：
//   DPP 在 ground set V (此处 V={1..33}) 上定义概率，对子集 Y ⊆ V 有
//     P(Y) ∝ det(L_Y)
//   其中 L 是 |V|×|V| 半正定 kernel 矩阵：
//     L_ii = q_i² （号码 i 的"质量分数"——可以用频率/后验/Thompson 权重）
//     L_ij = q_i · q_j · sim(i,j)，sim(i,j) ∈ [0,1] 表示相似度
//   det(L_Y) 越大，子集既"质量高"又"互相不相似"。
//
//   Greedy MAP（精确算法见 Chen et al. 2018, NIPS "Fast Greedy MAP for DPP"）
//   时间复杂度 O(k·|V|²)，对我们 33 个号码×6 = 198 次内积，瞬间出结果。
//
// 与"加权随机"的对比：
//   - 加权随机：每个号码独立抽，会有"密集团"（连号、同尾、同区）
//   - DPP：高质量 + 互斥，自然分散
//   - 不会改变中奖概率，但**显著降低撞号风险**（与他人重号或多注互相重叠）
//
// sim 设计：
//   sim(i, j) = exp(-|i-j|/τ)  → 数字邻近的号码更"相似"，DPP 会排斥它们
//                                τ 越大相似衰减越慢，分散度越高
//   也叠加"同尾"惩罚：tail(i)=tail(j) 时额外 +0.4 相似度
//   还叠加"同区"惩罚：zone(i)=zone(j) 时 +0.2 相似度

/**
 * 构造 33×33 的 L 矩阵（1-indexed，size×size 的 (size+1)×(size+1) 数组）。
 * @param qualities qualities[i] = q_i，号码 i 的质量分数（>0）
 * @param tau 相似性带宽（默认 5）
 */
export function buildLKernel(qualities, { tau = 5, sameTailBoost = 0.4, sameZoneBoost = 0.2, size = 33 } = {}) {
  const L = Array.from({ length: size + 1 }, () => Array(size + 1).fill(0));
  const zone = (n) => (n <= 11 ? 0 : n <= 22 ? 1 : 2);
  for (let i = 1; i <= size; i++) {
    const qi = Math.max(0, qualities[i] || 0);
    for (let j = 1; j <= size; j++) {
      if (i === j) {
        L[i][j] = qi * qi;
      } else {
        const qj = Math.max(0, qualities[j] || 0);
        let sim = Math.exp(-Math.abs(i - j) / tau);
        if (i % 10 === j % 10) sim = Math.min(1, sim + sameTailBoost);
        if (zone(i) === zone(j)) sim = Math.min(1, sim + sameZoneBoost);
        L[i][j] = qi * qj * sim;
      }
    }
  }
  return L;
}

/**
 * Greedy k-DPP MAP（Chen 2018 的快速增量算法 + 受限子集）。
 *
 * 输入：
 *   L      - (size+1)×(size+1) kernel
 *   k      - 选 k 个
 *   pool   - 候选号码列表（默认 1..size）
 *   pinned - 必含的号码（胆码），事先放进结果集
 *
 * 算法：
 *   维护每个候选 i 的 d_i² = L_ii - c_i^T c_i（c_i 是已选元素 wrt i 的投影向量）
 *   每轮取 d_i² 最大的 i 加入，更新所有未选候选的 c。
 *   d_i² 的物理意义：i 加入后子集行列式的"边际增益"。
 */
export function greedyKDPP(L, k, { pool = null, pinned = [], size = 33 } = {}) {
  const allCandidates = pool || Array.from({ length: size }, (_, i) => i + 1);
  const candidateSet = new Set(allCandidates);
  for (const p of pinned) candidateSet.delete(p);

  const selected = [...pinned];
  const ci = new Map(); // i -> 投影向量 (数组)
  const d2 = new Map(); // i -> 当前 d_i²
  for (const i of candidateSet) {
    ci.set(i, []);
    d2.set(i, L[i][i]);
  }
  // 把 pinned 当成"已选"先初始化 c
  for (const p of pinned) {
    incrementalUpdate(L, candidateSet, ci, d2, p, selected);
  }

  while (selected.length < k && candidateSet.size > 0) {
    let bestI = -1;
    let bestD = -Infinity;
    for (const i of candidateSet) {
      const dv = d2.get(i);
      if (dv > bestD) {
        bestD = dv;
        bestI = i;
      }
    }
    // 主分支：找到正 d² → 选它
    if (bestI !== -1 && bestD > 1e-12) {
      selected.push(bestI);
      candidateSet.delete(bestI);
      incrementalUpdate(L, candidateSet, ci, d2, bestI, selected);
      continue;
    }
    // 退化分支：池子被压榨干净了（候选互相高度共线），
    // 直接按 quality (L_ii) 顺序补齐。这通常发生在 pool 很小或质量极不均匀时。
    let fallbackBest = -1;
    let fallbackQ = -Infinity;
    for (const i of candidateSet) {
      const q = L[i][i];
      if (q > fallbackQ) {
        fallbackQ = q;
        fallbackBest = i;
      }
    }
    if (fallbackBest === -1) break;
    selected.push(fallbackBest);
    candidateSet.delete(fallbackBest);
    // 不再增量更新 c/d²，因为退化模式下意义不大
    ci.delete(fallbackBest);
    d2.delete(fallbackBest);
  }
  return selected.sort((a, b) => a - b);
}

function incrementalUpdate(L, candidateSet, ci, d2, justPicked, selected) {
  // 当 selected 增加一个元素 j（justPicked），对剩余 i 更新：
  //   e_j = (L[j][i] - c_j · c_i) / sqrt(d_j²)   （注意 d_j² 是 j 加入"前"的值）
  //   c_i ← c_i ∪ {e_j}
  //   d_i² ← d_i² - e_j²
  const j = justPicked;
  // 因为我们刚把 j 加进 selected，但 d2.get(j) 还是 j 加入前的值
  // (它在循环里被取到 bestD 时还没被覆盖)，这正是我们要的
  const dj2 = d2.has(j) ? d2.get(j) : (L[j][j] - dot(ci.get(j) || [], ci.get(j) || []));
  if (dj2 <= 1e-12) {
    // 退化：j 与已选向量线性相关，跳过 c 更新（保持安全）
    ci.delete(j);
    d2.delete(j);
    return;
  }
  const sqrtDj = Math.sqrt(dj2);
  const cj = ci.get(j) || [];
  for (const i of candidateSet) {
    const cii = ci.get(i);
    const proj = (L[j][i] - dot(cj, cii)) / sqrtDj;
    cii.push(proj);
    d2.set(i, d2.get(i) - proj * proj);
  }
  ci.delete(j);
  d2.delete(j);
}

function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * 计算选定子集 Y 的 log det(L_Y)，作为 DPP 概率的对数。
 * 使用 Cholesky 分解，O(k³)。返回 -Infinity 如果矩阵退化。
 */
export function logDetSubmatrix(L, indices) {
  const k = indices.length;
  if (k === 0) return 0;
  const A = Array.from({ length: k }, (_, r) => indices.map((c) => L[indices[r]][c]));
  // Cholesky in-place
  for (let i = 0; i < k; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let p = 0; p < j; p++) sum -= A[i][p] * A[j][p];
      if (i === j) {
        if (sum <= 1e-12) return -Infinity;
        A[i][i] = Math.sqrt(sum);
      } else {
        A[i][j] = sum / A[j][j];
      }
    }
  }
  let logDet = 0;
  for (let i = 0; i < k; i++) logDet += 2 * Math.log(A[i][i]);
  return logDet;
}
