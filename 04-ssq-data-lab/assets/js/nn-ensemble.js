// Deep Ensemble：训练 K 个不同初始化的 LSTM，预测时取概率均值
//
// 这是工业界给神经网络估计预测不确定性的标准手段（Lakshminarayanan 2017）：
//   - 每个成员独立用不同 seed 初始化权重 + 不同 mini-batch 顺序
//   - 推理时 P_ensemble(y) = (1/K) Σ_k P_k(y)
//   - 单个号码的 std 表征 epistemic uncertainty（"我们对它的预测有多确定"）
//
// 与 dropout 推理（MC Dropout）相比：
//   - Ensemble 准确性更稳定，但 K 倍训练成本
//   - 适合在浏览器里跑 K=3~5（每个模型 H=32~64 还可接受）

import { createModel, forwardModel, encodeSequence, RED_DIM, BLUE_DIM } from "./nn-ssq-model.js";
import { trainModel } from "./nn-trainer.js";
import { createRng } from "./rng.js";
import { makeMat } from "./nn-math.js";

/**
 * 训练 K 个 LSTM 成员，返回 ensemble 对象。
 *
 * @param trainSamples / valSamples
 * @param opts.K              成员数，3-5 推荐
 * @param opts.modelOpts      传给 createModel
 * @param opts.trainOpts      传给 trainModel
 * @param opts.seedBase       构造每个成员 seed: `${seedBase}-${k}`
 * @param opts.onMember(k, history)  每个成员训练完成回调
 */
export async function trainEnsemble(trainSamples, valSamples, opts = {}) {
  const {
    K = 3,
    modelOpts = {},
    trainOpts = {},
    seedBase = "ensemble",
    onMember,
    shouldStop,
  } = opts;
  const members = [];
  const histories = [];
  for (let k = 0; k < K; k++) {
    if (shouldStop && shouldStop()) break;
    const seed = `${seedBase}-${k}`;
    const memberRng = createRng(seed).next;
    const model = createModel({ ...modelOpts, rng: memberRng });
    const result = await trainModel(model, trainSamples, valSamples, {
      ...trainOpts,
      rng: memberRng,
      onEpoch: (e) => {
        if (trainOpts.onEpoch) trainOpts.onEpoch({ ...e, member: k, totalMembers: K });
      },
      onBatch: (b) => {
        if (trainOpts.onBatch) trainOpts.onBatch({ ...b, member: k, totalMembers: K });
      },
      shouldStop,
    });
    members.push(model);
    histories.push(result.history);
    if (onMember) await onMember(k, result.history, model);
  }
  return { members, histories };
}

/**
 * 推理：返回 K 个模型概率的平均 + 每个号码的 std（epistemic uncertainty 估计）。
 */
export function ensembleForward(members, sequence) {
  if (members.length === 0) throw new Error("empty ensemble");
  const K = members.length;
  const sumRed = makeMat(RED_DIM, 1);
  const sumRed2 = makeMat(RED_DIM, 1);
  const sumBlue = makeMat(BLUE_DIM, 1);
  const sumBlue2 = makeMat(BLUE_DIM, 1);

  for (const m of members) {
    const fwd = forwardModel(m, sequence, { training: false });
    for (let i = 0; i < RED_DIM; i++) {
      const p = fwd.redProbs.data[i];
      sumRed.data[i] += p;
      sumRed2.data[i] += p * p;
    }
    for (let i = 0; i < BLUE_DIM; i++) {
      const p = fwd.blueProbs.data[i];
      sumBlue.data[i] += p;
      sumBlue2.data[i] += p * p;
    }
  }

  const redMean = makeMat(RED_DIM, 1);
  const redStd = makeMat(RED_DIM, 1);
  const blueMean = makeMat(BLUE_DIM, 1);
  const blueStd = makeMat(BLUE_DIM, 1);
  for (let i = 0; i < RED_DIM; i++) {
    redMean.data[i] = sumRed.data[i] / K;
    const variance = Math.max(0, sumRed2.data[i] / K - redMean.data[i] * redMean.data[i]);
    redStd.data[i] = Math.sqrt(variance);
  }
  // Blue 用 mean 后归一化，使其仍是合法概率
  let s = 0;
  for (let i = 0; i < BLUE_DIM; i++) {
    blueMean.data[i] = sumBlue.data[i] / K;
    s += blueMean.data[i];
  }
  if (s > 0) for (let i = 0; i < BLUE_DIM; i++) blueMean.data[i] /= s;
  for (let i = 0; i < BLUE_DIM; i++) {
    const variance = Math.max(0, sumBlue2.data[i] / K - (sumBlue.data[i] / K) ** 2);
    blueStd.data[i] = Math.sqrt(variance);
  }
  return { redProbs: redMean, redStd, blueProbs: blueMean, blueStd };
}
