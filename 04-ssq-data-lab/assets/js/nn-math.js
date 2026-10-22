// 神经网络数学基础
//
// 设计目标：
//   1. 零依赖（不引 TensorFlow.js / numjs / NDArray），纯 JS Float32Array
//   2. 数值稳定（softmax 用 max-shift，sigmoid 钳位，cross-entropy 加 ε）
//   3. 函数式 + 行优先 (row-major) 存储，便于 BPTT 中反复 transpose / outer product
//
// 矩阵约定：
//   M = { rows, cols, data: Float32Array(rows*cols) }
//   data[r*cols + c] = M[r][c]
//
// 向量 = rows×1 矩阵；数值检查走 makeMat 的 NaN 守门。

export function makeMat(rows, cols, fill = 0) {
  const data = new Float32Array(rows * cols);
  if (fill !== 0) data.fill(fill);
  return { rows, cols, data };
}

export function fromArray2D(arr) {
  const rows = arr.length;
  const cols = arr[0].length;
  const m = makeMat(rows, cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) m.data[r * cols + c] = arr[r][c];
  return m;
}

export function fromArray1D(arr, asColumn = true) {
  if (asColumn) {
    const m = makeMat(arr.length, 1);
    for (let i = 0; i < arr.length; i++) m.data[i] = arr[i];
    return m;
  }
  const m = makeMat(1, arr.length);
  for (let i = 0; i < arr.length; i++) m.data[i] = arr[i];
  return m;
}

export function clone(m) {
  return { rows: m.rows, cols: m.cols, data: new Float32Array(m.data) };
}

export function copyInto(dst, src) {
  if (dst.rows !== src.rows || dst.cols !== src.cols) throw new Error("shape mismatch");
  dst.data.set(src.data);
}

/** Xavier (Glorot) 均匀初始化：U(-a, a), a = sqrt(6/(fanIn+fanOut))。 */
export function xavierInit(rows, cols, rng = Math.random) {
  const a = Math.sqrt(6 / (rows + cols));
  const m = makeMat(rows, cols);
  for (let i = 0; i < m.data.length; i++) m.data[i] = (rng() * 2 - 1) * a;
  return m;
}

/** Orthogonal init（更适合 RNN 的循环权重）：QR 分解的 Q 矩阵。 */
export function orthogonalInit(rows, cols, rng = Math.random) {
  // 生成 max(rows, cols) 方阵后取前 rows×cols
  const n = Math.max(rows, cols);
  const A = makeMat(n, n);
  for (let i = 0; i < A.data.length; i++) {
    // Box-Muller
    let u1 = 0, u2 = 0;
    while (u1 < 1e-12) u1 = rng();
    u2 = rng();
    A.data[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  // Modified Gram-Schmidt 得到正交基
  const Q = clone(A);
  for (let j = 0; j < n; j++) {
    // 取出第 j 列
    let norm = 0;
    for (let i = 0; i < n; i++) norm += Q.data[i * n + j] ** 2;
    norm = Math.sqrt(norm);
    if (norm < 1e-12) norm = 1;
    for (let i = 0; i < n; i++) Q.data[i * n + j] /= norm;
    // 后续列减去投影
    for (let k = j + 1; k < n; k++) {
      let dot = 0;
      for (let i = 0; i < n; i++) dot += Q.data[i * n + j] * Q.data[i * n + k];
      for (let i = 0; i < n; i++) Q.data[i * n + k] -= dot * Q.data[i * n + j];
    }
  }
  // 取前 rows×cols
  const out = makeMat(rows, cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.data[r * cols + c] = Q.data[r * n + c];
  return out;
}

/** C = A · B  (m×k · k×n = m×n)。 */
export function matmul(A, B) {
  if (A.cols !== B.rows) throw new Error(`matmul shape ${A.rows}x${A.cols} · ${B.rows}x${B.cols}`);
  const C = makeMat(A.rows, B.cols);
  for (let i = 0; i < A.rows; i++) {
    for (let k = 0; k < A.cols; k++) {
      const a = A.data[i * A.cols + k];
      if (a === 0) continue;
      for (let j = 0; j < B.cols; j++) C.data[i * B.cols + j] += a * B.data[k * B.cols + j];
    }
  }
  return C;
}

/** C += A · B（累加版本，避免 BPTT 里的临时分配） */
export function matmulAdd(C, A, B) {
  if (A.cols !== B.rows || C.rows !== A.rows || C.cols !== B.cols) throw new Error("shape mismatch");
  for (let i = 0; i < A.rows; i++) {
    for (let k = 0; k < A.cols; k++) {
      const a = A.data[i * A.cols + k];
      if (a === 0) continue;
      for (let j = 0; j < B.cols; j++) C.data[i * B.cols + j] += a * B.data[k * B.cols + j];
    }
  }
}

/** 转置。 */
export function transpose(A) {
  const T = makeMat(A.cols, A.rows);
  for (let i = 0; i < A.rows; i++)
    for (let j = 0; j < A.cols; j++) T.data[j * A.rows + i] = A.data[i * A.cols + j];
  return T;
}

/** A + B（in-place 到 dst 或新建）。 */
export function add(A, B, dst = null) {
  if (A.rows !== B.rows || A.cols !== B.cols) throw new Error("shape mismatch");
  const out = dst || makeMat(A.rows, A.cols);
  for (let i = 0; i < A.data.length; i++) out.data[i] = A.data[i] + B.data[i];
  return out;
}

/** A *= s。 */
export function scale(A, s) {
  for (let i = 0; i < A.data.length; i++) A.data[i] *= s;
  return A;
}

/** 元素积 A ⊙ B → dst。 */
export function hadamard(A, B, dst = null) {
  if (A.rows !== B.rows || A.cols !== B.cols) throw new Error("shape mismatch");
  const out = dst || makeMat(A.rows, A.cols);
  for (let i = 0; i < A.data.length; i++) out.data[i] = A.data[i] * B.data[i];
  return out;
}

/** 列向量加偏置（每行的偏置不同）：x + b。 */
export function addBias(x, b) {
  // x 是 dim×1 列，b 是 dim×1 列。一般场合直接用 add，函数保留语义化。
  return add(x, b);
}

/** sigmoid，钳位 input ∈ [-50, 50] 防溢出。 */
export function sigmoid(A, dst = null) {
  const out = dst || makeMat(A.rows, A.cols);
  for (let i = 0; i < A.data.length; i++) {
    const x = Math.max(-50, Math.min(50, A.data[i]));
    out.data[i] = 1 / (1 + Math.exp(-x));
  }
  return out;
}

/** sigmoid 反向：σ' = σ(1-σ)。已知 sig 输出，避免重算。 */
export function sigmoidBackward(sigOut, dOut, dst = null) {
  const out = dst || makeMat(sigOut.rows, sigOut.cols);
  for (let i = 0; i < sigOut.data.length; i++) {
    const s = sigOut.data[i];
    out.data[i] = dOut.data[i] * s * (1 - s);
  }
  return out;
}

export function tanh(A, dst = null) {
  const out = dst || makeMat(A.rows, A.cols);
  for (let i = 0; i < A.data.length; i++) {
    const x = Math.max(-50, Math.min(50, A.data[i]));
    out.data[i] = Math.tanh(x);
  }
  return out;
}

export function tanhBackward(tanhOut, dOut, dst = null) {
  const out = dst || makeMat(tanhOut.rows, tanhOut.cols);
  for (let i = 0; i < tanhOut.data.length; i++) {
    const t = tanhOut.data[i];
    out.data[i] = dOut.data[i] * (1 - t * t);
  }
  return out;
}

/** Softmax（数值稳定：max-shift）。 */
export function softmax(logits, dst = null) {
  const out = dst || makeMat(logits.rows, logits.cols);
  // 一般 logits 是 dim×1 列向量
  for (let c = 0; c < logits.cols; c++) {
    let max = -Infinity;
    for (let r = 0; r < logits.rows; r++) {
      const v = logits.data[r * logits.cols + c];
      if (v > max) max = v;
    }
    let sum = 0;
    for (let r = 0; r < logits.rows; r++) {
      const e = Math.exp(logits.data[r * logits.cols + c] - max);
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

/** 交叉熵损失（softmax 输出 vs one-hot 或 multi-hot 概率分布）。 */
export function crossEntropy(probs, target) {
  let loss = 0;
  for (let i = 0; i < probs.data.length; i++) {
    if (target.data[i] > 0) {
      loss -= target.data[i] * Math.log(Math.max(1e-12, probs.data[i]));
    }
  }
  return loss;
}

/** Softmax + CE 组合反向：dL/dlogits = (probs - target)。 */
export function softmaxCEBackward(probs, target, dst = null) {
  const out = dst || makeMat(probs.rows, probs.cols);
  for (let i = 0; i < probs.data.length; i++) out.data[i] = probs.data[i] - target.data[i];
  return out;
}

/** Binary cross-entropy with sigmoid 输出（multi-label，每个号码独立 0/1）。 */
export function bceLoss(probs, target) {
  let loss = 0;
  for (let i = 0; i < probs.data.length; i++) {
    const p = Math.max(1e-12, Math.min(1 - 1e-12, probs.data[i]));
    const t = target.data[i];
    loss -= t * Math.log(p) + (1 - t) * Math.log(1 - p);
  }
  return loss;
}

/** sigmoid + BCE 反向：dL/dlogits = (probs - target)。 */
export function sigmoidBCEBackward(probs, target, dst = null) {
  const out = dst || makeMat(probs.rows, probs.cols);
  for (let i = 0; i < probs.data.length; i++) out.data[i] = probs.data[i] - target.data[i];
  return out;
}

/* =========================================================
   Label smoothing
   ─────────────────────────────────────────────────────────
   思想：把硬 target {0, 1} 替换成 {ε, 1-ε}，loss 永远不为 0，
   防止网络对训练样本过度自信。
     - 对 BCE（sigmoid，multi-label）：target' = (1-2ε)·target + ε
       i.e. 1 → 1-ε, 0 → ε
     - 对 CE（softmax，one-of-K）：target' = (1-ε)·target + ε/K
   通常 ε = 0.05 ~ 0.1。
   反向梯度仍是 (probs - target')，公式不变，只是 target 提前转过。
   ========================================================= */

/** 把 multi-label hard target {0,1} 平滑为 {ε, 1-ε}，原地修改返回。 */
export function smoothBinaryTarget(target, eps = 0.05, dst = null) {
  const out = dst || makeMat(target.rows, target.cols);
  for (let i = 0; i < target.data.length; i++) {
    out.data[i] = target.data[i] > 0.5 ? (1 - eps) : eps;
  }
  return out;
}

/** 把 one-hot 平滑为 (1-ε)·one-hot + ε/K。dst 可复用。 */
export function smoothCategoricalTarget(target, eps = 0.05, dst = null) {
  const out = dst || makeMat(target.rows, target.cols);
  const K = target.rows * target.cols;
  const off = eps / K;
  for (let i = 0; i < target.data.length; i++) {
    out.data[i] = target.data[i] * (1 - eps) + off;
  }
  return out;
}

/**
 * Label-smoothed BCE loss：
 *   L = -Σ [t' log p + (1-t') log(1-p)],  t' = (1-2ε)·t + ε
 * 等价于：L_LS = (1-2ε)·BCE(p,t) + ε·BCE(p, 0.5) + const
 * 直接计算原式更直观。
 */
export function bceLossSmoothed(probs, target, eps = 0.05) {
  let loss = 0;
  for (let i = 0; i < probs.data.length; i++) {
    const p = Math.max(1e-12, Math.min(1 - 1e-12, probs.data[i]));
    const tHard = target.data[i] > 0.5 ? 1 : 0;
    const tSoft = tHard * (1 - 2 * eps) + eps;
    loss -= tSoft * Math.log(p) + (1 - tSoft) * Math.log(1 - p);
  }
  return loss;
}

/** Label-smoothed cross entropy. */
export function crossEntropySmoothed(probs, target, eps = 0.05) {
  const K = target.rows * target.cols;
  const off = eps / K;
  let loss = 0;
  for (let i = 0; i < probs.data.length; i++) {
    const tSoft = target.data[i] * (1 - eps) + off;
    if (tSoft > 1e-12) {
      loss -= tSoft * Math.log(Math.max(1e-12, probs.data[i]));
    }
  }
  return loss;
}

/** 全局梯度裁剪：所有梯度合到一个全局 L2 范数 <= maxNorm。 */
export function clipGradGlobal(grads, maxNorm) {
  let sumSq = 0;
  for (const g of grads) for (let i = 0; i < g.data.length; i++) sumSq += g.data[i] * g.data[i];
  const norm = Math.sqrt(sumSq);
  if (norm <= maxNorm || !isFinite(norm)) return norm;
  const scaleF = maxNorm / norm;
  for (const g of grads) for (let i = 0; i < g.data.length; i++) g.data[i] *= scaleF;
  return norm;
}

/** L2 norm of a matrix. */
export function l2Norm(M) {
  let s = 0;
  for (let i = 0; i < M.data.length; i++) s += M.data[i] * M.data[i];
  return Math.sqrt(s);
}

/** 把矩阵置零。 */
export function zero(M) {
  M.data.fill(0);
  return M;
}

/** 等价性：两个矩阵差的最大绝对值。 */
export function maxAbsDiff(A, B) {
  if (A.rows !== B.rows || A.cols !== B.cols) throw new Error("shape mismatch");
  let m = 0;
  for (let i = 0; i < A.data.length; i++) {
    const d = Math.abs(A.data[i] - B.data[i]);
    if (d > m) m = d;
  }
  return m;
}

/** 是否含 NaN / Inf。 */
export function hasNaN(M) {
  for (let i = 0; i < M.data.length; i++) if (!isFinite(M.data[i])) return true;
  return false;
}


/* =========================================================
   Dropout（inverted dropout）
   - 训练时：以概率 p 把元素置 0；其余乘 1/(1-p) 保持期望不变
   - 推理时：恒等映射（无操作）
   - 反向：与 mask 同位置置 0、其余仍乘 1/(1-p)
   ========================================================= */
export function makeDropoutMask(rows, cols, p, rng = Math.random) {
  // p 是丢弃概率
  const m = makeMat(rows, cols);
  if (p <= 0) {
    for (let i = 0; i < m.data.length; i++) m.data[i] = 1;
    return m;
  }
  if (p >= 1) {
    return m; // 全 0（极端情况，正常不会发生）
  }
  const scale = 1 / (1 - p);
  for (let i = 0; i < m.data.length; i++) m.data[i] = rng() < p ? 0 : scale;
  return m;
}

export function applyDropout(x, mask, dst = null) {
  return hadamard(x, mask, dst);
}
