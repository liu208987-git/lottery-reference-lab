// Walk-forward backtest（行业标准）
//
// 思路：
//   把测试集划分为 K 个连续段；模型用「截至段开始」的所有数据训练，然后预测段内每一期。
//   这模拟"真实部署"——预测每一期时，模型只能看过去。简化版：固定训练集训练一次模型，
//   再在测试集上一次性 forward（窗口滑动）。
//
// 评估指标：
//   - 红球 Top-6 命中数：模型选 6 个最高概率红球，与真实 6 个红球求交集大小
//   - 蓝球 Top-1 准确率：argmax 是否等于真实蓝球
//   - 红球 Top-K 命中率分布：K=6/8/10/12 等
//   - Brier score（红球 multi-label 0/1 概率校准）
//   - Log-likelihood
//
// Baseline：
//   - 均匀随机：每期红球随机 6 个，蓝球均匀
//   - 频率：用过去 N 期频率排名 Top-6 红 + 频率最高蓝
//   - Beta 后验：用 bayes.js 的后验均值 Top-6
//
// 关键结论（理论）：
//   - 红球 Top-6 期望命中（任意预测策略）= 6 × 6/33 = 1.0909...
//   - 蓝球 Top-1 准确率（任意预测策略）= 1/16 = 0.0625
//   即使一个"好"模型，也无法系统性高于这两个 baseline——这就是这个 backtester 要客观证明的。

import {
  encodeSequence, encodeTarget,
  forwardModel, topKRed, argMaxBlue,
  RED_DIM, BLUE_DIM,
} from "./nn-ssq-model.js";
import { freqFromDraws } from "./stats.js";
import { posteriorMeanArray, RED_PRIOR, BLUE_PRIOR } from "./bayes.js";
import { createRng } from "./rng.js";
import { BASELINES } from "./lottery-config.js";
import { ensembleForward } from "./nn-ensemble.js";

/**
 * 在 testDraws 上做 backtest（不更新模型权重）。
 * @param model 已训练的 LSTM 模型
 * @param trainTail 训练集最后 seqLen-1 期（用作初始上下文）
 * @param testDraws 测试集（按时间升序）
 * @param seqLen 序列长度
 * @param historyBeforeTrainTail trainTail 之前的 ALL 历史（用于算特征中的遗漏/熵；缺省 []）
 */
export function backtestModel(model, trainTail, testDraws, seqLen, historyBeforeTrainTail = []) {
  // 维护两份 history：
  //   shortWindow：最近 seqLen 期（喂给 LSTM）
  //   fullHist：完整历史（用于特征计算中的"截至此刻"统计）
  let shortWindow = trainTail.slice(-seqLen);
  let fullHist = [...historyBeforeTrainTail, ...trainTail];
  const records = [];
  for (const target of testDraws) {
    const window = shortWindow.slice(-seqLen);
    // window 第一期之前的 history = fullHist 减掉 window 部分
    const historyBeforeWindow = fullHist.slice(0, fullHist.length - window.length);
    const seq = encodeSequence(window, historyBeforeWindow);
    const fwd = forwardModel(model, seq, { training: false });

    const top6Red = topKRed(fwd.redProbs, 6).map(([n]) => n);
    const realReds = target.reds;
    const redHit6 = top6Red.filter((n) => realReds.includes(n)).length;
    const top8 = topKRed(fwd.redProbs, 8).map(([n]) => n);
    const redHit8 = top8.filter((n) => realReds.includes(n)).length;

    const blueArg = argMaxBlue(fwd.blueProbs);
    const blueHit = blueArg.num === target.blue;

    // Brier 红球
    let brier = 0;
    for (let i = 0; i < RED_DIM; i++) {
      const p = fwd.redProbs.data[i];
      const y = realReds.includes(i + 1) ? 1 : 0;
      brier += (p - y) ** 2;
    }
    brier /= RED_DIM;

    // 红球 logloss
    let redLL = 0;
    for (let i = 0; i < RED_DIM; i++) {
      const p = Math.max(1e-12, Math.min(1 - 1e-12, fwd.redProbs.data[i]));
      const y = realReds.includes(i + 1) ? 1 : 0;
      redLL -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
    }
    redLL /= RED_DIM;
    // 蓝球 logloss
    let blueLL = 0;
    for (let i = 0; i < BLUE_DIM; i++) {
      const p = Math.max(1e-12, fwd.blueProbs.data[i]);
      const y = (target.blue === i + 1) ? 1 : 0;
      blueLL -= y * Math.log(p);
    }

    // 同时计算 raw probs（无 calibration）用于 reliability 对比
    let rawRedProbs = null, rawBlueProbs = null;
    if (model.calibration) {
      const sigBare = (logits) => {
        const out = new Float32Array(logits.data.length);
        for (let i = 0; i < logits.data.length; i++) {
          const x = Math.max(-50, Math.min(50, logits.data[i]));
          out[i] = 1 / (1 + Math.exp(-x));
        }
        return out;
      };
      const softBare = (logits) => {
        const out = new Float32Array(logits.data.length);
        let max = -Infinity;
        for (let i = 0; i < logits.data.length; i++) if (logits.data[i] > max) max = logits.data[i];
        let sum = 0;
        for (let i = 0; i < logits.data.length; i++) {
          out[i] = Math.exp(logits.data[i] - max);
          sum += out[i];
        }
        for (let i = 0; i < logits.data.length; i++) out[i] /= Math.max(1e-30, sum);
        return out;
      };
      rawRedProbs = Array.from(sigBare(fwd.redLogits));
      rawBlueProbs = Array.from(softBare(fwd.blueLogits));
    }

    records.push({
      issue: target.issue,
      realReds, realBlue: target.blue,
      predTop6: top6Red,
      predBlue: blueArg.num, predBlueProb: blueArg.prob,
      redHit6, redHit8,
      blueHit,
      brier, redLL, blueLL,
      redProbs: Array.from(fwd.redProbs.data),
      blueProbs: Array.from(fwd.blueProbs.data),
      rawRedProbs, rawBlueProbs,
    });

    // 推进窗口
    shortWindow.push(target);
    fullHist.push(target);
  }
  return summarize(records);
}

/** Baseline：每期独立按"过去全部数据的频率"做 top-K 选择。 */
export function backtestFreqBaseline(allDrawsBeforeTest, testDraws) {
  const records = [];
  let history = allDrawsBeforeTest.slice();
  for (const target of testDraws) {
    const fr = freqFromDraws(history, "reds", RED_DIM);
    const fb = freqFromDraws(history, "blue", BLUE_DIM);
    const redRanked = [];
    for (let i = 1; i <= RED_DIM; i++) redRanked.push([i, fr[i]]);
    redRanked.sort((a, b) => b[1] - a[1]);
    const top6 = redRanked.slice(0, 6).map(([n]) => n);
    let bestBlue = 1, bestBlueF = -1;
    for (let i = 1; i <= BLUE_DIM; i++) if (fb[i] > bestBlueF) { bestBlueF = fb[i]; bestBlue = i; }

    records.push(buildBaselineRecord(target, top6, bestBlue, redRanked.slice(0, 8).map(([n]) => n)));
    history.push(target);
  }
  return summarize(records);
}

/** Baseline：贝叶斯后验均值 top-K。 */
export function backtestBayesBaseline(allDrawsBeforeTest, testDraws) {
  const records = [];
  let history = allDrawsBeforeTest.slice();
  for (const target of testDraws) {
    const fr = freqFromDraws(history, "reds", RED_DIM);
    const fb = freqFromDraws(history, "blue", BLUE_DIM);
    const meanR = posteriorMeanArray(fr, history.length, RED_PRIOR);
    const meanB = posteriorMeanArray(fb, history.length, BLUE_PRIOR);
    const ranked = [];
    for (let i = 1; i <= RED_DIM; i++) ranked.push([i, meanR[i]]);
    ranked.sort((a, b) => b[1] - a[1]);
    const top6 = ranked.slice(0, 6).map(([n]) => n);
    let bestBlue = 1, bestBlueP = -1;
    for (let i = 1; i <= BLUE_DIM; i++) if (meanB[i] > bestBlueP) { bestBlueP = meanB[i]; bestBlue = i; }

    records.push(buildBaselineRecord(target, top6, bestBlue, ranked.slice(0, 8).map(([n]) => n)));
    history.push(target);
  }
  return summarize(records);
}

/** Baseline：均匀随机（蒙特卡洛 R 次取平均）。 */
export function backtestUniformBaseline(testDraws, runs = 50, seed = "uniform") {
  const records = [];
  // 每期跑 runs 次随机预测，求平均命中
  const rng = createRng(seed).next;
  for (const target of testDraws) {
    let acc = 0, accBlue = 0, acc8 = 0;
    for (let r = 0; r < runs; r++) {
      const reds = sampleRandomReds(rng);
      const blue = 1 + Math.floor(rng() * 16);
      acc += reds.filter((n) => target.reds.includes(n)).length;
      const reds8 = sampleRandomKReds(rng, 8);
      acc8 += reds8.filter((n) => target.reds.includes(n)).length;
      if (blue === target.blue) accBlue++;
    }
    records.push({
      issue: target.issue,
      realReds: target.reds, realBlue: target.blue,
      predTop6: [], predBlue: 0, predBlueProb: 1 / 16,
      redHit6: acc / runs, redHit8: acc8 / runs,
      blueHit: accBlue / runs,
      brier: 0, redLL: 0, blueLL: 0,
    });
  }
  return summarize(records);
}

function sampleRandomReds(rng) {
  return sampleRandomKReds(rng, 6);
}
function sampleRandomKReds(rng, k) {
  const pool = [];
  for (let i = 1; i <= RED_DIM; i++) pool.push(i);
  const out = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

function buildBaselineRecord(target, top6, bestBlue, top8) {
  const redHit6 = top6.filter((n) => target.reds.includes(n)).length;
  const redHit8 = top8.filter((n) => target.reds.includes(n)).length;
  return {
    issue: target.issue,
    realReds: target.reds, realBlue: target.blue,
    predTop6: top6, predBlue: bestBlue, predBlueProb: 1 / 16,
    redHit6, redHit8,
    blueHit: bestBlue === target.blue,
    brier: 0, redLL: 0, blueLL: 0,
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
      avgRedHit6: sum("redHit6") / n,
      avgRedHit8: sum("redHit8") / n,
      blueAccuracy: sum("blueHit") / n,
      avgBrier: sum("brier") / n,
      avgRedLL: sum("redLL") / n,
      avgBlueLL: sum("blueLL") / n,
    },
  };
}

/** 期望基线（理论值，随机预测器的渐近表现）。 */
export const RANDOM_BASELINE = {
  redHit6: BASELINES.ssq.redHit6,    // ≈ 1.0909
  redHit8: BASELINES.ssq.redHit8,    // ≈ 1.4545
  blueAcc: BASELINES.ssq.blueAcc,    // 0.0625
};


/**
 * Ensemble walk-forward backtest：均值概率代替单模型 forward。
 * 与 backtestModel 同 records 字段格式，方便复用 reliability/BSS 等下游分析。
 */
export function backtestEnsemble(members, trainTail, testDraws, seqLen, historyBeforeTrainTail = []) {
  let shortWindow = trainTail.slice(-seqLen);
  let fullHist = [...historyBeforeTrainTail, ...trainTail];
  const records = [];
  for (const target of testDraws) {
    const window = shortWindow.slice(-seqLen);
    const historyBeforeWindow = fullHist.slice(0, fullHist.length - window.length);
    const seq = encodeSequence(window, historyBeforeWindow);
    const out = ensembleForward(members, seq);
    const top6 = topKRed(out.redProbs, 6).map(([n]) => n);
    const top8 = topKRed(out.redProbs, 8).map(([n]) => n);
    const blueArg = argMaxBlue(out.blueProbs);
    const redHit6 = top6.filter((n) => target.reds.includes(n)).length;
    const redHit8 = top8.filter((n) => target.reds.includes(n)).length;
    let brier = 0;
    for (let i = 0; i < RED_DIM; i++) {
      const p = out.redProbs.data[i];
      const y = target.reds.includes(i + 1) ? 1 : 0;
      brier += (p - y) ** 2;
    }
    brier /= RED_DIM;
    let redLL = 0;
    for (let i = 0; i < RED_DIM; i++) {
      const p = Math.max(1e-12, Math.min(1 - 1e-12, out.redProbs.data[i]));
      const y = target.reds.includes(i + 1) ? 1 : 0;
      redLL -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
    }
    redLL /= RED_DIM;
    let blueLL = 0;
    for (let i = 0; i < BLUE_DIM; i++) {
      const p = Math.max(1e-12, out.blueProbs.data[i]);
      const y = (target.blue === i + 1) ? 1 : 0;
      blueLL -= y * Math.log(p);
    }
    records.push({
      issue: target.issue, realReds: target.reds, realBlue: target.blue,
      predTop6: top6, predBlue: blueArg.num, predBlueProb: blueArg.prob,
      redHit6, redHit8,
      blueHit: blueArg.num === target.blue,
      brier, redLL, blueLL,
      redProbs: Array.from(out.redProbs.data),
      blueProbs: Array.from(out.blueProbs.data),
    });
    shortWindow.push(target);
    fullHist.push(target);
  }
  const summary = {
    n: records.length,
    avgRedHit6: records.reduce((s, r) => s + r.redHit6, 0) / records.length,
    avgRedHit8: records.reduce((s, r) => s + r.redHit8, 0) / records.length,
    blueAccuracy: records.reduce((s, r) => s + (r.blueHit ? 1 : 0), 0) / records.length,
    avgBrier: records.reduce((s, r) => s + r.brier, 0) / records.length,
    avgRedLL: records.reduce((s, r) => s + r.redLL, 0) / records.length,
    avgBlueLL: records.reduce((s, r) => s + r.blueLL, 0) / records.length,
  };
  return { records, summary };
}
