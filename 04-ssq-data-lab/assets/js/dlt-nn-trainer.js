// 大乐透 LSTM 训练器（结构同 nn-trainer.js，但适配 47 维 + 双 sigmoid 输出）

import {
  encodeDltSequence, encodeDltTarget,
  dltLossAndGrads, flattenDltParams, flattenDltGrads,
  forwardDltModel, topKFront, topKBack,
  FRONT_DIM, BACK_DIM, FRONT_PICK, BACK_PICK,
} from "./dlt-nn-model.js";
import { clipGradGlobal, makeMat, hasNaN } from "./nn-math.js";
import { createAdam } from "./nn-optim.js";
import { fitTemperatureSigmoid } from "./nn-calibration.js";
import { makeSchedule } from "./nn-schedule.js";

export function buildDltSamples(draws, seqLen) {
  const samples = [];
  for (let t = seqLen; t < draws.length; t++) {
    const window = draws.slice(t - seqLen, t);
    const target = draws[t];
    const historyBeforeWindow = draws.slice(0, t - seqLen);
    samples.push({
      issue: target.issue,
      sequence: encodeDltSequence(window, historyBeforeWindow),
      target: encodeDltTarget(target),
      raw: { window, target },
    });
  }
  return samples;
}

export function shuffleInPlace(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** 评估：前区 Top-5 命中数 + 后区 Top-2 命中数 + 损失。 */
export function evaluateDlt(model, samples) {
  let totalLoss = 0;
  let totalFront = 0, totalBack = 0;
  let totalFrontHit5 = 0;
  let totalBackHit2 = 0;
  let n = 0;
  for (const s of samples) {
    const fwd = forwardDltModel(model, s.sequence, { training: false });
    let fLoss = 0;
    for (let i = 0; i < FRONT_DIM; i++) {
      const p = Math.max(1e-12, Math.min(1 - 1e-12, fwd.fProbs.data[i]));
      const t = s.target.front.data[i];
      fLoss -= t * Math.log(p) + (1 - t) * Math.log(1 - p);
    }
    fLoss /= FRONT_DIM;
    let bLoss = 0;
    for (let i = 0; i < BACK_DIM; i++) {
      const p = Math.max(1e-12, Math.min(1 - 1e-12, fwd.bProbs.data[i]));
      const t = s.target.back.data[i];
      bLoss -= t * Math.log(p) + (1 - t) * Math.log(1 - p);
    }
    bLoss /= BACK_DIM;
    totalLoss += fLoss + 5 * bLoss;
    totalFront += fLoss;
    totalBack += bLoss;

    const top5 = topKFront(fwd.fProbs, FRONT_PICK).map(([n]) => n);
    const realFront = [];
    for (let i = 0; i < FRONT_DIM; i++) if (s.target.front.data[i] > 0) realFront.push(i + 1);
    let fHit = 0;
    for (const x of top5) if (realFront.includes(x)) fHit++;
    totalFrontHit5 += fHit;

    const top2 = topKBack(fwd.bProbs, BACK_PICK).map(([n]) => n);
    const realBack = [];
    for (let i = 0; i < BACK_DIM; i++) if (s.target.back.data[i] > 0) realBack.push(i + 1);
    let bHit = 0;
    for (const x of top2) if (realBack.includes(x)) bHit++;
    totalBackHit2 += bHit;

    n++;
  }
  return {
    avgLoss: totalLoss / Math.max(1, n),
    avgFrontLoss: totalFront / Math.max(1, n),
    avgBackLoss: totalBack / Math.max(1, n),
    avgFrontHit5: totalFrontHit5 / Math.max(1, n),  // 期望基线 = 5×5/35 = 0.7143
    avgBackHit2: totalBackHit2 / Math.max(1, n),    // 期望基线 = 2×2/12 = 0.3333
    samples: n,
  };
}

export async function trainDltModel(model, trainSamples, valSamples, opts = {}) {
  const {
    epochs = 20,
    batchSize = 32,
    lr = 3e-3,
    lrDecay = 0,
    weightDecay = 1e-5,
    gradClip = 5,
    patience = 6,
    labelSmoothing = 0,
    schedule = "cosine",
    warmupEpochs = 1,
    rng = Math.random,
    onEpoch, onBatch, shouldStop,
  } = opts;

  const params = flattenDltParams(model);
  const adam = createAdam(params, { lr, weightDecay });
  const lrFn = makeSchedule(schedule, {
    lrPeak: lr,
    lrMin: lr * 0.01,
    warmupSteps: warmupEpochs,
    stepEpochs: 5,
    gamma: 0.5,
  });
  const history = {
    epochs: [], lr: [],
    trainLoss: [], valLoss: [],
    valFrontHit5: [], valBackHit2: [],
    gradNorms: [],
  };

  let bestValLoss = Infinity;
  let bestParams = null;
  let stale = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    if (shouldStop && shouldStop()) break;
    const epochLr = lrFn(epoch, epochs);
    adam.setLr(epochLr);
    const order = trainSamples.slice();
    shuffleInPlace(order, rng);

    let epochLoss = 0, epochCount = 0, runningGradNorm = 0, batchIdx = 0;

    for (let i = 0; i < order.length; i += batchSize) {
      if (shouldStop && shouldStop()) break;
      const batch = order.slice(i, i + batchSize);
      const accum = makeAccumGrads(model);
      let batchLoss = 0;
      for (const sample of batch) {
        const { loss, grads } = dltLossAndGrads(model, sample.sequence, sample.target, { rng, labelSmoothing });
        batchLoss += loss;
        addInto(accum, flattenDltGrads(grads));
      }
      scaleGrads(accum, 1 / batch.length);
      const norm = clipGradGlobal(Object.values(accum), gradClip);
      runningGradNorm = 0.9 * runningGradNorm + 0.1 * norm;

      let nanFound = false;
      for (const v of Object.values(accum)) if (hasNaN(v)) { nanFound = true; break; }
      if (nanFound) {
        if (onBatch) onBatch({ epoch, batch: batchIdx, loss: batchLoss / batch.length, gradNorm: norm, nan: true });
        batchIdx++;
        continue;
      }

      adam.step(accum);
      epochLoss += batchLoss;
      epochCount += batch.length;
      batchIdx++;

      if (onBatch && batchIdx % 4 === 0) {
        onBatch({
          epoch, batch: batchIdx,
          totalBatches: Math.ceil(order.length / batchSize),
          loss: batchLoss / batch.length,
          gradNorm: norm,
        });
        await pause();
      }
    }

    const valStats = evaluateDlt(model, valSamples);
    const trainAvg = epochLoss / Math.max(1, epochCount);

    history.epochs.push(epoch);
    history.lr.push(epochLr);
    history.trainLoss.push(trainAvg);
    history.valLoss.push(valStats.avgLoss);
    history.valFrontHit5.push(valStats.avgFrontHit5);
    history.valBackHit2.push(valStats.avgBackHit2);
    history.gradNorms.push(runningGradNorm);

    if (onEpoch) {
      onEpoch({
        epoch, totalEpochs: epochs,
        lr: epochLr,
        trainLoss: trainAvg,
        valLoss: valStats.avgLoss,
        valFrontHit5: valStats.avgFrontHit5,
        valBackHit2: valStats.avgBackHit2,
        gradNorm: runningGradNorm,
      });
      await pause();
    }

    if (valStats.avgLoss + 1e-6 < bestValLoss) {
      bestValLoss = valStats.avgLoss;
      bestParams = snapshotParams(model);
      stale = 0;
    } else {
      stale++;
      if (stale >= patience) break;
    }
  }
  if (bestParams) restoreParams(model, bestParams);

  // Fit temperature scaling on val set
  const prevCal = model.calibration;
  model.calibration = null;
  try {
    model.calibration = fitDltCalibration(model, valSamples);
  } catch (e) {
    model.calibration = prevCal;
  }

  return { model, history, bestValLoss, calibration: model.calibration };
}

function fitDltCalibration(model, valSamples) {
  if (!valSamples || valSamples.length < 10) return null;
  const fLogitsList = [], fTargets = [];
  const bLogitsList = [], bTargets = [];
  for (const s of valSamples) {
    const fwd = forwardDltModel(model, s.sequence, { training: false });
    fLogitsList.push(fwd.fLogits);
    fTargets.push(s.target.front);
    bLogitsList.push(fwd.bLogits);
    bTargets.push(s.target.back);
  }
  const fCal = fitTemperatureSigmoid(fLogitsList, fTargets);
  const bCal = fitTemperatureSigmoid(bLogitsList, bTargets);
  return {
    frontT: fCal.T,
    backT: bCal.T,
    frontECE: { before: fCal.eceAt1, after: fCal.eceAtT },
    backECE: { before: bCal.eceAt1, after: bCal.eceAtT },
    frontNLL: { before: fCal.nllAt1, after: fCal.nllAtT },
    backNLL: { before: bCal.nllAt1, after: bCal.nllAtT },
    fitOnSamples: valSamples.length,
  };
}

function makeAccumGrads(model) {
  const params = flattenDltParams(model);
  const out = {};
  for (const k of Object.keys(params)) out[k] = makeMat(params[k].rows, params[k].cols);
  return out;
}
function addInto(accum, grads) {
  for (const k of Object.keys(grads)) {
    const a = accum[k].data, b = grads[k].data;
    for (let i = 0; i < a.length; i++) a[i] += b[i];
  }
}
function scaleGrads(grads, s) {
  for (const k of Object.keys(grads)) {
    const d = grads[k].data;
    for (let i = 0; i < d.length; i++) d[i] *= s;
  }
}
function snapshotParams(model) {
  const p = flattenDltParams(model);
  const snap = {};
  for (const k of Object.keys(p)) snap[k] = new Float32Array(p[k].data);
  return snap;
}
function restoreParams(model, snap) {
  const p = flattenDltParams(model);
  for (const k of Object.keys(snap)) p[k].data.set(snap[k]);
}
function pause() {
  return new Promise((r) => setTimeout(r, 0));
}
