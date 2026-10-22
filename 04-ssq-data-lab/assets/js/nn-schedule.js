// Learning rate schedules
//
// 现代深度学习的两个关键技巧：
//
// 1. Warmup
//    最初几个 step 把 lr 从 0 线性升到 lrPeak，避免初始大梯度把权重炸坏
//    （特别是大 batch / Transformer / Adam 的偏差未稳定时）。
//
// 2. Cosine annealing
//    warmup 之后用 cos 曲线把 lr 从 lrPeak 平滑降到 lrMin。
//    这是论文界的事实标准（SGDR / DETR / GPT-x 都用），比线性衰减
//    在最后几个 epoch 更稳定，不会因 lr 还偏大而 loss 反弹。
//
// 公式：
//   if step < warmupSteps:
//     lr = lrPeak * step / warmupSteps
//   else:
//     progress = (step - warmupSteps) / (totalSteps - warmupSteps)
//     lr = lrMin + 0.5 * (lrPeak - lrMin) * (1 + cos(π * progress))

/**
 * @param step       当前 step（从 0 开始）
 * @param totalSteps 总 step 数（不含 warmup）
 * @param opts.lrPeak       峰值 lr
 * @param opts.lrMin        谷底 lr（默认 lrPeak * 0.01）
 * @param opts.warmupSteps  线性 warmup 的 step 数（默认 0）
 */
export function cosineWithWarmup(step, totalSteps, { lrPeak, lrMin = null, warmupSteps = 0 } = {}) {
  if (lrMin == null) lrMin = lrPeak * 0.01;
  if (warmupSteps > 0 && step < warmupSteps) {
    return lrPeak * (step + 1) / warmupSteps;
  }
  const t = totalSteps - warmupSteps;
  if (t <= 0) return lrPeak;
  const progress = Math.max(0, Math.min(1, (step - warmupSteps) / t));
  return lrMin + 0.5 * (lrPeak - lrMin) * (1 + Math.cos(Math.PI * progress));
}

/** 简单 step decay：每 stepEpochs 个 epoch lr×=gamma。 */
export function stepDecay(epoch, lrPeak, { stepEpochs = 5, gamma = 0.5 } = {}) {
  return lrPeak * Math.pow(gamma, Math.floor(epoch / stepEpochs));
}

/** Constant：永远 lrPeak（基线）。 */
export function constantLR(_step, _total, { lrPeak }) {
  return lrPeak;
}

/**
 * 工厂：根据 schedule 名拿一个 (step, total) → lr 的函数。
 *
 * @param name "cosine" | "constant" | "step"
 * @param opts {lrPeak, lrMin, warmupSteps, stepEpochs, gamma}
 */
export function makeSchedule(name, opts) {
  if (name === "cosine") return (step, total) => cosineWithWarmup(step, total, opts);
  if (name === "step") return (epoch, _total) => stepDecay(epoch, opts.lrPeak, opts);
  return (_step, _total) => opts.lrPeak;
}
