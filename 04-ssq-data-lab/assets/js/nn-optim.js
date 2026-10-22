// Adam 优化器（Kingma & Ba, 2014）
//
// 更新规则：
//   m_t = β1·m_{t-1} + (1-β1)·g_t          一阶矩估计（梯度均值）
//   v_t = β2·v_{t-1} + (1-β2)·g_t²         二阶矩估计（梯度方差）
//   m̂_t = m_t / (1 - β1^t)                 偏差修正
//   v̂_t = v_t / (1 - β2^t)
//   θ_t = θ_{t-1} - α · m̂_t / (√v̂_t + ε)
//
// 默认值参考论文：α=1e-3, β1=0.9, β2=0.999, ε=1e-8
// 我们额外支持 weight decay（AdamW）：θ -= α·λ·θ

import { makeMat } from "./nn-math.js";

export function createAdam(params, { lr = 1e-3, beta1 = 0.9, beta2 = 0.999, eps = 1e-8, weightDecay = 0 } = {}) {
  // params 是 { name: Matrix } 字典
  const m = {};
  const v = {};
  for (const k of Object.keys(params)) {
    m[k] = makeMat(params[k].rows, params[k].cols);
    v[k] = makeMat(params[k].rows, params[k].cols);
  }
  let t = 0;

  return {
    step(grads) {
      t++;
      const correctionM = 1 - Math.pow(beta1, t);
      const correctionV = 1 - Math.pow(beta2, t);
      for (const k of Object.keys(grads)) {
        if (!params[k]) throw new Error(`unknown param ${k}`);
        const g = grads[k].data;
        const mk = m[k].data;
        const vk = v[k].data;
        const p = params[k].data;
        const len = p.length;
        for (let i = 0; i < len; i++) {
          mk[i] = beta1 * mk[i] + (1 - beta1) * g[i];
          vk[i] = beta2 * vk[i] + (1 - beta2) * g[i] * g[i];
          const mhat = mk[i] / correctionM;
          const vhat = vk[i] / correctionV;
          let update = lr * mhat / (Math.sqrt(vhat) + eps);
          if (weightDecay > 0) update += lr * weightDecay * p[i];
          p[i] -= update;
        }
      }
    },
    getStep() { return t; },
    setLr(newLr) { lr = newLr; },
    state() {
      return { lr, beta1, beta2, eps, weightDecay, t };
    },
  };
}
