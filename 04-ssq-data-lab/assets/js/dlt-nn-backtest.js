// 大乐透 LSTM Walk-forward backtest + 4 个 baseline
//
// 与 SSQ 版（nn-backtest.js）同构，但适配 DLT 的 5+2 结构。

import {
  encodeDltSequence, forwardDltModel, topKFront, topKBack,
  FRONT_DIM, BACK_DIM, FRONT_PICK, BACK_PICK,
} from "./dlt-nn-model.js";
import { zoneFreq } from "./lottery-stats.js";
import { DLT_CONFIG } from "./lottery-config.js";
import { posteriorMeanArray } from "./bayes.js";
import { FRONT_PRIOR, BACK_PRIOR } from "./dlt-advanced-sampler.js";
import { createRng } from "./rng.js";
import { BASELINES } from "./lottery-config.js";

const FRONT_ZONE = DLT_CONFIG.zones[0];
const BACK_ZONE = DLT_CONFIG.zones[1];

export const DLT_RANDOM_BASELINE = {
  frontHit5: BASELINES.dlt.frontHit5,        // 0.7143
  frontHit7: BASELINES.dlt.frontHit7,        // 1.0
  backHit2: BASELINES.dlt.backHit2,          // 0.3333
};

export function backtestDltModel(model, trainTail, testDraws, seqLen, historyBeforeTrainTail = []) {
  let shortWindow = trainTail.slice(-seqLen);
  let fullHist = [...historyBeforeTrainTail, ...trainTail];
  const records = [];
  for (const target of testDraws) {
    const window = shortWindow.slice(-seqLen);
    const historyBeforeWindow = fullHist.slice(0, fullHist.length - window.length);
    const seq = encodeDltSequence(window, historyBeforeWindow);
    const fwd = forwardDltModel(model, seq, { training: false });

    const top5 = topKFront(fwd.fProbs, FRONT_PICK).map(([n]) => n);
    const realFront = target.front;
    const fHit5 = top5.filter((n) => realFront.includes(n)).length;
    const top7 = topKFront(fwd.fProbs, 7).map(([n]) => n);
    const fHit7 = top7.filter((n) => realFront.includes(n)).length;

    const top2 = topKBack(fwd.bProbs, BACK_PICK).map(([n]) => n);
    const realBack = target.back;
    const bHit2 = top2.filter((n) => realBack.includes(n)).length;

    let brier = 0;
    for (let i = 0; i < FRONT_DIM; i++) {
      const p = fwd.fProbs.data[i];
      const y = realFront.includes(i + 1) ? 1 : 0;
      brier += (p - y) ** 2;
    }
    brier /= FRONT_DIM;

    let fLL = 0;
    for (let i = 0; i < FRONT_DIM; i++) {
      const p = Math.max(1e-12, Math.min(1 - 1e-12, fwd.fProbs.data[i]));
      const y = realFront.includes(i + 1) ? 1 : 0;
      fLL -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
    }
    fLL /= FRONT_DIM;

    let bLL = 0;
    for (let i = 0; i < BACK_DIM; i++) {
      const p = Math.max(1e-12, Math.min(1 - 1e-12, fwd.bProbs.data[i]));
      const y = realBack.includes(i + 1) ? 1 : 0;
      bLL -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
    }
    bLL /= BACK_DIM;

    let rawRedProbs = null;
    if (model.calibration) {
      const sigBare = (logits) => {
        const out = new Float32Array(logits.data.length);
        for (let i = 0; i < logits.data.length; i++) {
          const x = Math.max(-50, Math.min(50, logits.data[i]));
          out[i] = 1 / (1 + Math.exp(-x));
        }
        return out;
      };
      rawRedProbs = Array.from(sigBare(fwd.fLogits));
    }

    records.push({
      issue: target.issue,
      realFront, realBack,
      predTop5: top5, predTop2: top2,
      fHit5, fHit7, bHit2,
      brier, fLL, bLL,
      // 给 reliability diagram 用
      redHit6: fHit5,        // 命名兼容 SSQ 的 reliability 工具
      realReds: realFront,
      redProbs: Array.from(fwd.fProbs.data),
      rawRedProbs,
      blueProbs: Array.from(fwd.bProbs.data),
      blueHit: bHit2 === BACK_PICK,
    });
    shortWindow.push(target);
    fullHist.push(target);
  }
  return summarize(records);
}

export function backtestDltUniformBaseline(testDraws, runs = 80, seed = "uniform-dlt") {
  const records = [];
  const rng = createRng(seed).next;
  for (const target of testDraws) {
    let acc5 = 0, acc7 = 0, acc2 = 0;
    for (let r = 0; r < runs; r++) {
      const f5 = sampleK(rng, 5, FRONT_DIM);
      const f7 = sampleK(rng, 7, FRONT_DIM);
      const b2 = sampleK(rng, 2, BACK_DIM);
      acc5 += f5.filter((n) => target.front.includes(n)).length;
      acc7 += f7.filter((n) => target.front.includes(n)).length;
      acc2 += b2.filter((n) => target.back.includes(n)).length;
    }
    records.push({
      issue: target.issue,
      realFront: target.front, realBack: target.back,
      predTop5: [], predTop2: [],
      fHit5: acc5 / runs, fHit7: acc7 / runs, bHit2: acc2 / runs,
      brier: 0, fLL: 0, bLL: 0,
      redHit6: acc5 / runs, realReds: target.front, blueHit: false,
    });
  }
  return summarize(records);
}

export function backtestDltFreqBaseline(allDrawsBeforeTest, testDraws) {
  const records = [];
  let history = allDrawsBeforeTest.slice();
  for (const target of testDraws) {
    const fF = zoneFreq(history, FRONT_ZONE);
    const fB = zoneFreq(history, BACK_ZONE);
    const fRanked = []; for (let i = 1; i <= FRONT_DIM; i++) fRanked.push([i, fF[i]]);
    fRanked.sort((a, b) => b[1] - a[1]);
    const top5 = fRanked.slice(0, FRONT_PICK).map(([n]) => n);
    const top7 = fRanked.slice(0, 7).map(([n]) => n);
    const bRanked = []; for (let i = 1; i <= BACK_DIM; i++) bRanked.push([i, fB[i]]);
    bRanked.sort((a, b) => b[1] - a[1]);
    const top2 = bRanked.slice(0, BACK_PICK).map(([n]) => n);

    records.push(buildRecord(target, top5, top7, top2));
    history.push(target);
  }
  return summarize(records);
}

export function backtestDltBayesBaseline(allDrawsBeforeTest, testDraws) {
  const records = [];
  let history = allDrawsBeforeTest.slice();
  for (const target of testDraws) {
    const fF = zoneFreq(history, FRONT_ZONE);
    const fB = zoneFreq(history, BACK_ZONE);
    const meanF = posteriorMeanArray(fF, history.length, FRONT_PRIOR);
    const meanB = posteriorMeanArray(fB, history.length, BACK_PRIOR);
    const fRanked = []; for (let i = 1; i <= FRONT_DIM; i++) fRanked.push([i, meanF[i]]);
    fRanked.sort((a, b) => b[1] - a[1]);
    const top5 = fRanked.slice(0, FRONT_PICK).map(([n]) => n);
    const top7 = fRanked.slice(0, 7).map(([n]) => n);
    const bRanked = []; for (let i = 1; i <= BACK_DIM; i++) bRanked.push([i, meanB[i]]);
    bRanked.sort((a, b) => b[1] - a[1]);
    const top2 = bRanked.slice(0, BACK_PICK).map(([n]) => n);

    records.push(buildRecord(target, top5, top7, top2));
    history.push(target);
  }
  return summarize(records);
}

function buildRecord(target, top5, top7, top2) {
  const fHit5 = top5.filter((n) => target.front.includes(n)).length;
  const fHit7 = top7.filter((n) => target.front.includes(n)).length;
  const bHit2 = top2.filter((n) => target.back.includes(n)).length;
  return {
    issue: target.issue,
    realFront: target.front, realBack: target.back,
    predTop5: top5, predTop2: top2,
    fHit5, fHit7, bHit2,
    brier: 0, fLL: 0, bLL: 0,
    redHit6: fHit5, realReds: target.front, blueHit: bHit2 === BACK_PICK,
  };
}

function summarize(records) {
  const n = records.length;
  if (n === 0) return { records, summary: null };
  const sum = (k) => records.reduce((s, r) => s + (typeof r[k] === "boolean" ? (r[k] ? 1 : 0) : r[k]), 0);
  return {
    records,
    summary: {
      n,
      avgFrontHit5: sum("fHit5") / n,
      avgFrontHit7: sum("fHit7") / n,
      avgBackHit2: sum("bHit2") / n,
      avgBrier: sum("brier") / n,
      avgFrontLL: sum("fLL") / n,
      avgBackLL: sum("bLL") / n,
    },
  };
}

function sampleK(rng, k, max) {
  const pool = []; for (let i = 1; i <= max; i++) pool.push(i);
  const out = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}
