// 大乐透 Deep Ensemble（Lakshminarayanan 2017 风格）
//
// 与 SSQ ensemble 同构，但适配 DLT 双 sigmoid 输出（前区 / 后区都是 multi-label BCE）。
//
// 训练 K 个独立初始化模型，预测时返回 (mean, std) 用于 LCB ranking 和不确定性可视化。

import {
  createDltModel, forwardDltModel,
  FRONT_DIM, BACK_DIM,
} from "./dlt-nn-model.js";
import { trainDltModel } from "./dlt-nn-trainer.js";
import { createRng } from "./rng.js";
import { makeMat } from "./nn-math.js";

/**
 * 训练 K 个独立 DLT 成员。
 * @param trainSamples / valSamples
 * @param opts.K              成员数（推荐 3-5）
 * @param opts.modelOpts      传给 createDltModel
 * @param opts.trainOpts      传给 trainDltModel
 * @param opts.seedBase       每成员 seed = `${seedBase}-${k}`
 * @param opts.onMember(k, history, model)
 * @param opts.shouldStop()
 */
export async function trainDltEnsemble(trainSamples, valSamples, opts = {}) {
  const {
    K = 3,
    modelOpts = {},
    trainOpts = {},
    seedBase = "dlt-ensemble",
    onMember,
    shouldStop,
  } = opts;
  const members = [];
  const histories = [];
  for (let k = 0; k < K; k++) {
    if (shouldStop && shouldStop()) break;
    const seed = `${seedBase}-${k}`;
    const memberRng = createRng(seed).next;
    const model = createDltModel({ ...modelOpts, rng: memberRng });
    const result = await trainDltModel(model, trainSamples, valSamples, {
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
 * 推理：返回 K 个模型的 mean + std（前区 / 后区独立）。
 * 应用 LCB 时直接用这两个向量。
 */
export function dltEnsembleForward(members, sequence) {
  if (members.length === 0) throw new Error("empty ensemble");
  const K = members.length;
  const sumF = makeMat(FRONT_DIM, 1);
  const sumF2 = makeMat(FRONT_DIM, 1);
  const sumB = makeMat(BACK_DIM, 1);
  const sumB2 = makeMat(BACK_DIM, 1);

  for (const m of members) {
    const fwd = forwardDltModel(m, sequence, { training: false });
    for (let i = 0; i < FRONT_DIM; i++) {
      const p = fwd.fProbs.data[i];
      sumF.data[i] += p;
      sumF2.data[i] += p * p;
    }
    for (let i = 0; i < BACK_DIM; i++) {
      const p = fwd.bProbs.data[i];
      sumB.data[i] += p;
      sumB2.data[i] += p * p;
    }
  }

  const fMean = makeMat(FRONT_DIM, 1);
  const fStd = makeMat(FRONT_DIM, 1);
  const bMean = makeMat(BACK_DIM, 1);
  const bStd = makeMat(BACK_DIM, 1);
  for (let i = 0; i < FRONT_DIM; i++) {
    fMean.data[i] = sumF.data[i] / K;
    const v = Math.max(0, sumF2.data[i] / K - fMean.data[i] * fMean.data[i]);
    fStd.data[i] = Math.sqrt(v);
  }
  for (let i = 0; i < BACK_DIM; i++) {
    bMean.data[i] = sumB.data[i] / K;
    const v = Math.max(0, sumB2.data[i] / K - bMean.data[i] * bMean.data[i]);
    bStd.data[i] = Math.sqrt(v);
  }
  // 注意：sigmoid 输出每个号码独立，不需要归一化（与 SSQ blue softmax 不同）
  return { fProbs: fMean, fStd, bProbs: bMean, bStd };
}
