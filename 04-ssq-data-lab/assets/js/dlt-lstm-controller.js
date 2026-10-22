// 大乐透 LSTM 面板控制器（结构同 lstm-controller.js）

import { $, pad2 } from "./utils.js";
import { toast, copyToClipboard } from "./ui.js";
import {
  createDltModel, forwardDltModel, encodeDltSequence,
  topKFront, topKBack,
  serializeDltModel, deserializeDltModel,
  FRONT_DIM, BACK_DIM, FRONT_PICK, BACK_PICK,
} from "./dlt-nn-model.js";
import { trainDltModel, buildDltSamples } from "./dlt-nn-trainer.js";
import { trainDltEnsemble, dltEnsembleForward } from "./dlt-nn-ensemble.js";
import {
  backtestDltModel, backtestDltUniformBaseline,
  backtestDltFreqBaseline, backtestDltBayesBaseline,
  DLT_RANDOM_BASELINE,
} from "./dlt-nn-backtest.js";
import {
  bootstrapCI, pairedBootstrap,
  metricAvgHit6, metricBlueAcc,
  reliabilityDiagram,
  brierSkillScore, permutationTest,
} from "./nn-statistics.js";
import { createRng } from "./rng.js";
import * as modelStorage from "./model-storage.js";
import { openModelManager } from "./model-manager-ui.js";
import { isWorkerAvailable, trainInWorker } from "./nn-worker-client.js";
import * as predictionHistory from "./prediction-history.js";
import { diagnoseTicket as diagnoseDltTicket } from "./dlt-explainer.js";
import { renderTrackerPanel } from "./prediction-tracker-ui.js";
import { renderConformalPanel } from "./conformal-ui.js";
import { renderExplainerCard } from "./lstm-explainer-card.js";
import { renderDriftMonitor } from "./drift-monitor-ui.js";

const STORAGE_KEY = "dlt-lstm-default";
const LEGACY_LS_KEY = "dlt-lstm-model-v1";

const state = {
  draws: [],
  model: null,
  history: null,
  trainSamples: null,
  valSamples: null,
  seqLen: 15,
  shouldStop: false,
  isTraining: false,
};

export function setupDltLstmController(allDraws) {
  state.draws = allDraws;
  $("#btnDltLstmTrain")?.addEventListener("click", onTrain);
  $("#btnDltLstmStop")?.addEventListener("click", () => {
    state.shouldStop = true;
    if (state.workerStop) state.workerStop();
    setStatus("stopping…", "warn");
  });
  $("#btnDltLstmPredict")?.addEventListener("click", onPredict);
  $("#btnDltLstmBacktest")?.addEventListener("click", onBacktest);
  $("#btnDltLstmSave")?.addEventListener("click", onSave);
  $("#btnDltLstmLoad")?.addEventListener("click", onLoad);
  $("#btnDltLstmDownload")?.addEventListener("click", onDownload);
  $("#btnDltLstmLoadDemo")?.addEventListener("click", onLoadDemo);
  $("#btnDltLstmManager")?.addEventListener("click", onOpenManager);
  $("#dltLstmUploadFile")?.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) onUploadFile(f);
    e.target.value = "";
  });
  tryAutoLoad();

  setTimeout(() => mountDltTracker(), 80);
}

let dltTrackerRef = null;
function mountDltTracker() {
  const container = $("#dltLstmTrackerBody");
  if (!container) return;
  dltTrackerRef = renderTrackerPanel(container, "dlt", state.draws);
  const driftBody = $("#dltLstmDriftBody");
  if (driftBody) {
    renderDriftMonitor({ container: driftBody, draws: state.draws, lottery: "dlt" });
  }
}
function refreshDltTracker() {
  if (dltTrackerRef?.refresh) dltTrackerRef.refresh();
}

export function updateDltLstmDraws(draws) {
  state.draws = draws;
}

async function onTrain() {
  if (state.isTraining) return;
  state.isTraining = true;
  state.shouldStop = false;
  setControls(true);

  try {
    const seqLen = clampInt("#dltLstmSeqLen", 5, 50, 15);
    const hidden = clampInt("#dltLstmHidden", 16, 256, 64);
    const numLayers = clampInt("#dltLstmLayers", 1, 4, 2);
    const split = clampNum("#dltLstmSplit", 0.5, 0.95, 0.85);
    const lr = clampNum("#dltLstmLr", 1e-4, 0.1, 0.003);
    const epochs = clampInt("#dltLstmEpochs", 1, 100, 20);
    const batchSize = clampInt("#dltLstmBatch", 4, 128, 32);
    const dropoutInput = clampNum("#dltLstmDropIn", 0, 0.5, 0.1);
    const dropoutHidden = clampNum("#dltLstmDropHidden", 0, 0.5, 0.2);
    const dropoutOutput = clampNum("#dltLstmDropOut", 0, 0.5, 0.2);
    const labelSmoothing = clampNum("#dltLstmLabelSmooth", 0, 0.2, 0.05);
    const lcbLambda = clampNum("#dltLstmLcbLambda", 0, 3, 0);
    const ensembleK = clampInt("#dltLstmEnsembleK", 1, 8, 1);
    const seedStr = $("#dltLstmSeed")?.value?.trim() || `dlt-train-${Date.now()}`;
    state.seqLen = seqLen;
    state.lcbLambda = lcbLambda;

    setStatus("准备样本…");
    const samples = buildDltSamples(state.draws, seqLen);
    if (samples.length < 100) throw new Error(`数据太少，至少需要 ${100 + seqLen} 期`);
    const splitIdx = Math.floor(samples.length * split);
    state.trainSamples = samples.slice(0, splitIdx);
    state.valSamples = samples.slice(splitIdx);

    const arch = `H=${hidden} · L=${numLayers} · drop[in/h/out]=${dropoutInput}/${dropoutHidden}/${dropoutOutput} · K=${ensembleK}`;
    setStatus(`训练：${state.trainSamples.length} train / ${state.valSamples.length} val · T=${seqLen} · ${arch}`);
    initCurves();
    resetSeries();

    const t0 = Date.now();
    const baseModelOpts = { hiddenDim: hidden, numLayers, dropoutInput, dropoutHidden, dropoutOutput };
    const baseTrainOpts = {
      epochs, batchSize, lr,
      gradClip: 5, patience: 6, weightDecay: 1e-5,
      labelSmoothing,
    };

    if (state.useWorker !== false && isWorkerAvailable()) {
      const workerHandle = trainInWorker({
        cmd: "trainDlt",
        samples: state.trainSamples,
        valSamples: state.valSamples,
        modelOpts: baseModelOpts,
        trainOpts: baseTrainOpts,
        seed: seedStr,
        ensembleK,
        onBatch: (b) => {
          if (b.totalBatches) {
            const ratio = ensembleK > 1
              ? (b.member / b.totalMembers) + (b.batch / b.totalBatches / b.totalMembers)
              : (b.batch / b.totalBatches);
            setProgress(ratio);
          }
        },
        onEpoch: (e) => {
          appendCurve(e);
          const eta = estimateETA(e.epoch + 1, e.totalEpochs) || "";
          if (ensembleK > 1) {
            setStatus(`成员 ${e.member + 1}/${e.totalMembers} · epoch ${e.epoch + 1}/${e.totalEpochs} · val ${e.valLoss.toFixed(4)} · 前 hit@5 ${e.valFrontHit5.toFixed(3)}${eta ? ` · ${eta}` : ""}`);
          } else {
            setStatus(`[worker] epoch ${e.epoch + 1}/${e.totalEpochs} · train ${e.trainLoss.toFixed(4)} · val ${e.valLoss.toFixed(4)} · 前 hit@5 ${e.valFrontHit5.toFixed(3)}${eta ? ` · ${eta}` : ""}`);
          }
        },
      });
      state.workerStop = workerHandle.stop;
      const payload = await workerHandle.done;
      if (payload.type === "ensemble") {
        state.ensemble = {
          members: payload.members.map(deserializeDltModel),
          histories: payload.histories,
        };
        state.history = state.ensemble.histories[state.ensemble.histories.length - 1] || null;
        state.model = state.ensemble.members[0];
      } else {
        state.model = deserializeDltModel(payload.model);
        if (payload.calibration) state.model.calibration = payload.calibration;
        state.history = payload.history;
        state.ensemble = null;
      }
    } else if (ensembleK > 1) {
      const result = await trainDltEnsemble(state.trainSamples, state.valSamples, {
        K: ensembleK,
        seedBase: seedStr,
        modelOpts: baseModelOpts,
        trainOpts: {
          ...baseTrainOpts,
          onBatch: (b) => {
            if (b.totalBatches) setProgress((b.member / b.totalMembers) + (b.batch / b.totalBatches / b.totalMembers));
          },
          onEpoch: (e) => {
            appendCurve(e);
            setStatus(`成员 ${e.member + 1}/${e.totalMembers} · epoch ${e.epoch + 1}/${e.totalEpochs} · train ${e.trainLoss.toFixed(4)} · val ${e.valLoss.toFixed(4)} · 前 hit@5 ${e.valFrontHit5.toFixed(3)}`);
          },
        },
        shouldStop: () => state.shouldStop,
      });
      state.ensemble = { members: result.members, histories: result.histories };
      state.model = result.members[0]; // 用第一个作为单模型 fallback
      state.history = result.histories[result.histories.length - 1];
    } else {
      // 单模型
      state.ensemble = null;
      const memberRng = createRng(seedStr).next;
      state.model = createDltModel({ ...baseModelOpts, rng: memberRng });
      const result = await trainDltModel(state.model, state.trainSamples, state.valSamples, {
        ...baseTrainOpts,
        rng: memberRng,
        onBatch: (b) => {
          if (b.totalBatches) setProgress(b.batch / b.totalBatches);
          if (b.nan) setStatus(`epoch ${b.epoch + 1} batch ${b.batch}: NaN 跳过`, "warn");
        },
        onEpoch: (e) => {
          appendCurve(e);
          setStatus(`epoch ${e.epoch + 1}/${e.totalEpochs} · train ${e.trainLoss.toFixed(4)} · val ${e.valLoss.toFixed(4)} · 前 hit@5 ${e.valFrontHit5.toFixed(3)} · 后 hit@2 ${e.valBackHit2.toFixed(3)}`);
          setProgress((e.epoch + 1) / e.totalEpochs);
        },
        shouldStop: () => state.shouldStop,
      });
      state.history = result.history;
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const bestLoss = state.history ? Math.min(...state.history.valLoss).toFixed(4) : "—";
    setStatus(`训练完成 · ${elapsed}s · best val ${bestLoss}`, "ok");
    setProgress(1);

    if (state.history) renderFinalMetrics(state.history);

    $("#btnDltLstmPredict").disabled = false;
    $("#btnDltLstmBacktest").disabled = false;
    $("#btnDltLstmSave").disabled = false;
    if ($("#btnDltLstmDownload")) $("#btnDltLstmDownload").disabled = false;
  } catch (err) {
    setStatus(`错误：${err.message || err}`, "bad");
    console.error(err);
  } finally {
    state.isTraining = false;
    setControls(false);
  }
}

function onPredict() {
  if (!state.model && !state.ensemble) return;
  const window = state.draws.slice(-state.seqLen);
  const historyBeforeWindow = state.draws.slice(0, state.draws.length - state.seqLen);
  const seq = encodeDltSequence(window, historyBeforeWindow);

  let fProbs, bProbs, fStd = null, bStd = null;
  if (state.ensemble) {
    const out = dltEnsembleForward(state.ensemble.members, seq);
    fProbs = out.fProbs;
    bProbs = out.bProbs;
    fStd = out.fStd;
    bStd = out.bStd;
  } else {
    const fwd = forwardDltModel(state.model, seq, { training: false });
    fProbs = fwd.fProbs;
    bProbs = fwd.bProbs;
  }

  // LCB ranking 当 ensemble + λ>0
  const lambda = state.lcbLambda || 0;
  let top5;
  if (state.ensemble && fStd && lambda > 0) {
    const arr = [];
    for (let i = 0; i < FRONT_DIM; i++) {
      arr.push([i + 1, fProbs.data[i] - lambda * fStd.data[i], fProbs.data[i], fStd.data[i]]);
    }
    arr.sort((a, b) => b[1] - a[1]);
    top5 = arr.slice(0, FRONT_PICK).map(([n, , mean]) => [n, mean]);
  } else {
    top5 = topKFront(fProbs, FRONT_PICK);
  }
  let top2;
  if (state.ensemble && bStd && lambda > 0) {
    const arr = [];
    for (let i = 0; i < BACK_DIM; i++) {
      arr.push([i + 1, bProbs.data[i] - lambda * bStd.data[i], bProbs.data[i], bStd.data[i]]);
    }
    arr.sort((a, b) => b[1] - a[1]);
    top2 = arr.slice(0, BACK_PICK).map(([n, , mean]) => [n, mean]);
  } else {
    top2 = topKBack(bProbs, BACK_PICK);
  }

  const card = $("#dltLstmPredictionCard");
  const body = $("#dltLstmPredictionBody");
  card.style.display = "";

  const fBars = [];
  let fMax = 0;
  for (let i = 0; i < FRONT_DIM; i++) fMax = Math.max(fMax, fProbs.data[i]);
  for (let i = 0; i < FRONT_DIM; i++) {
    const p = fProbs.data[i];
    const w = (p / Math.max(1e-9, fMax)) * 100;
    const isPicked = top5.some(([n]) => n === i + 1);
    const stdInfo = fStd
      ? ` <span class="muted fine">±${(fStd.data[i] * 100).toFixed(1)}%</span>`
      : "";
    fBars.push(`
      <div class="prob-row">
        <span class="ball front ${isPicked ? "" : "muted-ball"}" style="width:24px;height:24px;font-size:10px;box-shadow:none">${pad2(i + 1)}</span>
        <span class="prob-bar"><i style="width:${w.toFixed(1)}%"></i></span>
        <span class="mono prob-val">${(p * 100).toFixed(1)}%${stdInfo}</span>
      </div>
    `);
  }
  const bRanked = [];
  for (let i = 0; i < BACK_DIM; i++) bRanked.push([i + 1, bProbs.data[i]]);
  bRanked.sort((a, b) => b[1] - a[1]);
  const bBars = bRanked.map(([n, p]) => {
    const isPicked = top2.some(([m]) => m === n);
    const stdInfo = bStd
      ? ` <span class="muted fine">±${(bStd.data[n - 1] * 100).toFixed(1)}%</span>`
      : "";
    return `
      <div class="prob-row">
        <span class="ball back ${isPicked ? "" : "muted-ball"}" style="width:24px;height:24px;font-size:10px;box-shadow:none">${pad2(n)}</span>
        <span class="prob-bar"><i style="width:${(p * 100).toFixed(1)}%"></i></span>
        <span class="mono prob-val">${(p * 100).toFixed(1)}%${stdInfo}</span>
      </div>
    `;
  }).join("");

  const ensembleBadge = state.ensemble
    ? `<span class="chip chip-ok" style="margin-left:8px">${state.ensemble.members.length} 模型集成${lambda > 0 ? ` · LCB λ=${lambda}` : ""}</span>`
    : "";

  body.innerHTML = `
    <div class="prediction-pick">
      <div class="prediction-label">Top-5 前 + Top-2 后${ensembleBadge}</div>
      <div class="balls">
        ${top5.map(([n]) => `<span class="ball front">${pad2(n)}</span>`).join("")}
        ${top2.map(([n], idx) => `<span class="ball back${idx === 0 ? " plus" : ""}">${pad2(n)}</span>`).join("")}
      </div>
    </div>
    <div class="prediction-cols">
      <div>
        <div class="card-title">前区 35 路概率${fStd ? "（± 集成 std）" : ""}</div>
        ${fBars.join("")}
      </div>
      <div>
        <div class="card-title">后区 12 路概率${bStd ? "（± 集成 std）" : ""}</div>
        ${bBars}
      </div>
    </div>
    <div class="callout" style="margin-top:14px">
      <div class="callout-title">⚠️ 模型局限</div>
      <div class="callout-body">
        本预测器在 walk-forward 回测里前区 Top-5 命中数与<strong>均匀基线 ${DLT_RANDOM_BASELINE.frontHit5.toFixed(3)}</strong>统计上不可区分；
        后区 Top-2 命中数与<strong>${DLT_RANDOM_BASELINE.backHit2.toFixed(3)}</strong>统计上不可区分。<br/>
        <strong>这不是模型差，是大乐透 i.i.d. 抽奖装置没有可学习的时间规律。</strong>
        点下方"回测"亲眼看证据。
      </div>
    </div>
  `;
  toast("已生成预测");

  // 号码体检
  try {
    const front5 = top5.map(([n]) => n);
    const back2 = top2.map(([n]) => n);
    const diag = diagnoseDltTicket({ front: front5, back: back2 }, state.draws);
    renderExplainerCard({
      container: $("#dltLstmPredictionBody"),
      diag,
      primaryColor: "var(--dlt-front)",
    });
  } catch (e) {
    console.warn("dlt explainer failed:", e);
  }

  // 预测追踪
  try {
    const lastDraw = state.draws[state.draws.length - 1];
    const targetIssue = lastDraw ? nextDltIssue(lastDraw.issue) : "next";
    predictionHistory.record({
      lottery: "dlt",
      targetIssue,
      modelType: state.ensemble ? "lstm-ensemble" : "lstm-single",
      topReds: top5.map(([n]) => n),
      topBlue: top2.map(([n]) => n),
      K: { reds: 5, blue: 2 },
    });
    refreshDltTracker();
  } catch (e) {}
}

function nextDltIssue(issue) {
  const s = String(issue);
  const last = s.slice(-3);
  const n = parseInt(last, 10);
  if (!Number.isFinite(n)) return s + "+1";
  return s.slice(0, -3) + String(n + 1).padStart(3, "0");
}


async function onBacktest() {
  if (!state.model) return;
  setStatus("回测中…");
  await pause();
  try {
    const seqLen = state.seqLen;
    const valTargets = state.valSamples.map((s) => s.raw.target);
    const valIssues = new Set(valTargets.map((d) => d.issue));
    const splitIdx = state.draws.findIndex((d) => valIssues.has(d.issue));
    if (splitIdx < seqLen) throw new Error("回测窗口不足");
    const trainTail = state.draws.slice(splitIdx - seqLen, splitIdx);
    const testDraws = state.draws.slice(splitIdx);
    const historyBeforeTrainTail = state.draws.slice(0, splitIdx - seqLen);

    const lstmRes = backtestDltModel(state.model, trainTail, testDraws, seqLen, historyBeforeTrainTail);
    const freqRes = backtestDltFreqBaseline(state.draws.slice(0, splitIdx), testDraws);
    const bayesRes = backtestDltBayesBaseline(state.draws.slice(0, splitIdx), testDraws);
    const uniformRes = backtestDltUniformBaseline(testDraws, 80, "uniform-dlt");

    const card = $("#dltLstmBacktestCard");
    const body = $("#dltLstmBacktestBody");
    card.style.display = "";
    body.innerHTML = renderBacktestTable(lstmRes, freqRes, bayesRes, uniformRes, testDraws.length);
    setStatus(`回测完成：${testDraws.length} 期`, "ok");

    // 激活共形面板
    try {
      const conformalCard = $("#dltLstmConformalCard");
      const conformalBody = $("#dltLstmConformalBody");
      if (conformalCard && conformalBody) {
        conformalCard.style.display = "";
        let latestProbs = null;
        try {
          const window = state.draws.slice(-state.seqLen);
          const histBefore = state.draws.slice(0, state.draws.length - state.seqLen);
          const seq = encodeDltSequence(window, histBefore);
          if (state.ensemble) {
            const out = dltEnsembleForward(state.ensemble.members, seq);
            latestProbs = Float32Array.from(out.fProbs.data);
          } else if (state.model) {
            const fwd = forwardDltModel(state.model, seq, { training: false });
            latestProbs = Float32Array.from(fwd.fProbs.data);
          }
        } catch (_) {}
        renderConformalPanel({
          container: conformalBody,
          backtestRecords: lstmRes.records,
          lottery: "dlt",
          latestProbs,
        });
      }
    } catch (e) { console.warn("dlt conformal panel failed:", e); }
  } catch (err) {
    setStatus(`回测失败：${err.message || err}`, "bad");
    console.error(err);
  }
}

function renderBacktestTable(lstm, freq, bayes, uniform, n) {
  const fmt = (v, d = 4) => (v == null ? "—" : v.toFixed(d));
  const pct = (v) => (v == null ? "—" : `${(v * 100).toFixed(2)}%`);

  // metricAvgHit6 取的是 record.redHit6——我们把 fHit5 映射到 redHit6 字段
  const lstmCi = bootstrapCI(lstm.records, metricAvgHit6, { B: 500, seed: "dlt-bt-lstm" });
  const uniCi = bootstrapCI(uniform.records, metricAvgHit6, { B: 500, seed: "dlt-bt-uni" });
  const paired = pairedBootstrap(lstm.records, uniform.records, metricAvgHit6, { B: 500, seed: "dlt-bt-paired" });

  const formatCI = (mean, lo, hi) => `${mean.toFixed(3)} <span class="muted">[${lo.toFixed(3)}, ${hi.toFixed(3)}]</span>`;

  const rows = [];
  rows.push({
    label: "LSTM（前区 5 选 35）",
    tag: "primary",
    f5: formatCI(lstm.summary.avgFrontHit5, lstmCi.lower, lstmCi.upper),
    f7: lstm.summary.avgFrontHit7.toFixed(3),
    b2: lstm.summary.avgBackHit2.toFixed(3),
    brier: lstm.summary.avgBrier,
    ll: lstm.summary.avgFrontLL + lstm.summary.avgBackLL,
  });
  rows.push({
    label: "贝叶斯后验 baseline",
    f5: bayes.summary.avgFrontHit5.toFixed(3),
    f7: bayes.summary.avgFrontHit7.toFixed(3),
    b2: bayes.summary.avgBackHit2.toFixed(3),
  });
  rows.push({
    label: "频率 baseline",
    f5: freq.summary.avgFrontHit5.toFixed(3),
    f7: freq.summary.avgFrontHit7.toFixed(3),
    b2: freq.summary.avgBackHit2.toFixed(3),
  });
  rows.push({
    label: "均匀随机 baseline (80×MC)",
    f5: formatCI(uniform.summary.avgFrontHit5, uniCi.lower, uniCi.upper),
    f7: uniform.summary.avgFrontHit7.toFixed(3),
    b2: uniform.summary.avgBackHit2.toFixed(3),
  });
  rows.push({
    label: "理论期望（任意预测器）",
    tag: "theory",
    f5: DLT_RANDOM_BASELINE.frontHit5.toFixed(3),
    f7: DLT_RANDOM_BASELINE.frontHit7.toFixed(3),
    b2: DLT_RANDOM_BASELINE.backHit2.toFixed(3),
  });

  const tableRows = rows.map((r) => `
    <tr class="${r.tag === "primary" ? "row-primary" : ""}${r.tag === "theory" ? " row-theory" : ""}">
      <td>${r.label}</td>
      <td class="mono">${r.f5}</td>
      <td class="mono">${r.f7}</td>
      <td class="mono">${r.b2}</td>
      <td class="mono">${r.brier != null ? fmt(r.brier) : "—"}</td>
      <td class="mono">${r.ll != null ? fmt(r.ll, 3) : "—"}</td>
    </tr>
  `).join("");

  const ciIncludesZero = paired.lower <= 0 && paired.upper >= 0;
  const verdict = ciIncludesZero
    ? `LSTM 与均匀随机的前区 hit@5 差值 95% CI = [${paired.lower.toFixed(3)}, ${paired.upper.toFixed(3)}] <strong>包含 0</strong>。差异不显著——这正是预期：大乐透前后区都是 i.i.d. 摇号。`
    : `差值 95% CI = [${paired.lower.toFixed(3)}, ${paired.upper.toFixed(3)}] <strong>不含 0</strong>。但要警惕：(1) ${n} 期的局部偏差不一定泛化；(2) 即便差异真实，也不构成可重复的预测能力。`;

  // BSS（用前区 35/5 配置）+ 配对置换检验
  const bssLstm = brierSkillScore(lstm.records, FRONT_DIM, FRONT_PICK);
  const permTest = permutationTest(lstm.records, uniform.records, metricAvgHit6, { B: 1000, seed: "dlt-perm" });

  const reliab = reliabilityDiagram(lstm.records, { bins: 10 });
  const rawRecords = lstm.records.map((r) => ({
    realReds: r.realReds,
    redProbs: r.rawRedProbs || r.redProbs,
  }));
  const reliabRaw = reliabilityDiagram(rawRecords, { bins: 10 });
  const hasCalibration = !!state.model?.calibration;
  const eceCompare = hasCalibration
    ? `ECE: raw <strong class="mono">${reliabRaw.ece.toFixed(4)}</strong> → calibrated <strong class="mono">${reliab.ece.toFixed(4)}</strong>`
    : `ECE = ${reliab.ece.toFixed(4)}`;

  return `
    <div class="bt-table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>方法</th>
            <th>前 hit@5 [95% CI]</th>
            <th>前 hit@7</th>
            <th>后 hit@2</th>
            <th>Brier</th>
            <th>NLL</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <div class="callout" style="margin-top:14px">
      <div class="callout-title">配对 Bootstrap 显著性检验（B=500）</div>
      <div class="callout-body">${verdict}</div>
    </div>
    <div class="bt-stats-grid" style="margin-top:14px">
      <div class="card bt-stat-card">
        <div class="card-title">Brier Skill Score <span class="card-num">vs climatology</span></div>
        <div class="diag-grid">
          <div class="diag-line">
            <span>LSTM BSS（前区）</span>
            <strong class="mono" style="color:${bssLstm.bss > 0 ? "var(--dlt-front)" : "var(--red-2)"}">${bssLstm.bss.toFixed(4)}</strong>
          </div>
          <div class="diag-line">
            <span>Climatology baseline</span>
            <strong class="mono">${(FRONT_PICK / FRONT_DIM).toFixed(4)}</strong>
          </div>
          <div class="diag-line">
            <span>BS<sub>model</sub> · BS<sub>ref</sub></span>
            <strong class="mono">${bssLstm.bsModel.toFixed(4)} · ${bssLstm.bsRef.toFixed(4)}</strong>
          </div>
        </div>
        <div class="hint">BSS = 1 − BS_model / BS_ref。&gt;0 优于"全部猜 5/35"；&lt;0 反而更差。彩票 i.i.d. 下 BSS 期望 ≈ 0。</div>
      </div>
      <div class="card bt-stat-card">
        <div class="card-title">配对置换检验 <span class="card-num">paired permutation, B=1000</span></div>
        <div class="diag-grid">
          <div class="diag-line">
            <span>观察到的均值差</span>
            <strong class="mono">${permTest.observed.toFixed(4)}</strong>
          </div>
          <div class="diag-line">
            <span>双侧 p 值</span>
            <strong class="mono" style="color:${permTest.pTwoSided < 0.05 ? "var(--gold)" : "var(--text)"}">${permTest.pTwoSided.toFixed(4)}</strong>
          </div>
          <div class="diag-line">
            <span>判断（α=0.05）</span>
            <strong>${permTest.pTwoSided < 0.05 ? `<span class="chip chip-warn">差异显著</span>` : `<span class="chip chip-ok">差异不显著</span>`}</strong>
          </div>
        </div>
        <div class="hint">置换检验比 paired bootstrap 更严格。p ≥ 0.05 表示数据看起来与"两组本质相同"无法区分。</div>
      </div>
    </div>
    <div class="card" style="margin-top:14px; padding: var(--space-4)">
      <div class="card-title">校准曲线 · Reliability Diagram <span class="card-num">${eceCompare}</span></div>
      ${renderReliab(reliab, hasCalibration ? reliabRaw : null)}
      <div class="hint">点越接近对角线 y=x 越好。${hasCalibration ? "灰色虚线 = 训练后未校准；绿色 = temperature scaling 校准后。" : "完美校准 ECE = 0。"}</div>
    </div>
  `;
}

function renderReliab(reliab, reliabRaw = null) {
  const W = 380, H = 240;
  const padL = 36, padR = 12, padT = 18, padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const sx = (v) => padL + v * innerW;
  const sy = (v) => padT + (1 - v) * innerH;
  const renderPoints = (points, color, opacity, withLine) => {
    const valid = points.filter(p => p.observedFreq != null && p.count > 0);
    const dots = valid.map((p) => {
      const r = 2 + Math.min(8, Math.sqrt(p.count) * 0.5);
      return `<circle cx="${sx(p.avgPred).toFixed(1)}" cy="${sy(p.observedFreq).toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" opacity="${opacity}"/>`;
    }).join("");
    const line = withLine && valid.length > 1
      ? `<polyline points="${valid.map(p => `${sx(p.avgPred).toFixed(1)},${sy(p.observedFreq).toFixed(1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.6"/>`
      : "";
    return line + dots;
  };
  const refLine = `<line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${padT}" stroke="rgba(255,255,255,.35)" stroke-dasharray="3 4"/>`;
  const xAxis = `<line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${padT + innerH}" stroke="rgba(255,255,255,.25)"/>`;
  const yAxis = `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="rgba(255,255,255,.25)"/>`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((v) => `
    <text x="${sx(v)}" y="${padT + innerH + 14}" text-anchor="middle" font-size="9" fill="rgba(255,255,255,.5)" font-family="JetBrains Mono, monospace">${v.toFixed(2)}</text>
    <text x="${padL - 4}" y="${sy(v) + 3}" text-anchor="end" font-size="9" fill="rgba(255,255,255,.5)" font-family="JetBrains Mono, monospace">${v.toFixed(2)}</text>
  `).join("");

  const hasRaw = reliabRaw && reliabRaw.points.some(p => p.observedFreq != null && p.count > 0);
  const rawLine = hasRaw
    ? `<polyline points="${reliabRaw.points.filter(p => p.observedFreq != null && p.count > 0).map(p => `${sx(p.avgPred).toFixed(1)},${sy(p.observedFreq).toFixed(1)}`).join(" ")}" fill="none" stroke="rgba(180,180,180,.55)" stroke-width="1.2" stroke-dasharray="3 3"/>`
    : "";
  const rawDots = hasRaw ? renderPoints(reliabRaw.points, "rgba(180,180,180,.85)", 0.55, false) : "";
  const calSvg = renderPoints(reliab.points, "var(--dlt-front)", 0.85, true);
  const legend = hasRaw
    ? `<g transform="translate(${padL + 8}, ${padT + 4})">
        <line x1="0" y1="6" x2="14" y2="6" stroke="rgba(180,180,180,.6)" stroke-dasharray="2 2"/>
        <text x="20" y="9" font-size="9" fill="rgba(255,255,255,.65)" font-family="JetBrains Mono, monospace">raw</text>
        <line x1="58" y1="6" x2="72" y2="6" stroke="var(--dlt-front)" stroke-width="1.5"/>
        <text x="78" y="9" font-size="9" fill="rgba(255,255,255,.65)" font-family="JetBrains Mono, monospace">calibrated</text>
      </g>`
    : "";

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${xAxis}${yAxis}${refLine}${ticks}${rawLine}${rawDots}${calSvg}${legend}</svg>`;
}

/* ============================================================
 * 持久化（IndexedDB + 文件导出 / 导入）
 * ============================================================ */
async function onSave() {
  if (!state.model) return;
  const payload = buildDltPayload();
  try {
    await modelStorage.save(STORAGE_KEY, payload);
    modelStorage.requestPersistence().catch(() => {});
    const quota = await modelStorage.getQuota();
    const quotaStr = quota
      ? `（已用 ${(quota.usage / 1024 / 1024).toFixed(1)} / ${(quota.quota / 1024 / 1024).toFixed(0)} MB）`
      : "";
    toast(`已保存到 IndexedDB ${quotaStr}`);
  } catch (e) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      toast(`已降级保存到 localStorage（${e.message}）`);
    } catch (e2) {
      toast(`保存失败：${e2.message}（请用「下载到本地」）`);
    }
  }
}

function buildDltPayload() {
  return {
    type: "single",
    lottery: "dlt",
    model: serializeDltModel(state.model),
    seqLen: state.seqLen,
    history: state.history,
    hiddenDim: state.model?.hiddenDim,
    numLayers: state.model?.numLayers,
    savedAt: new Date().toISOString(),
  };
}

async function tryAutoLoad() {
  try {
    let payload = await modelStorage.load(STORAGE_KEY);
    if (!payload) {
      payload = await modelStorage.migrateFromLocalStorage(LEGACY_LS_KEY, STORAGE_KEY);
      if (payload) toast("已从 localStorage 迁移老 DLT 模型到 IndexedDB");
    }
    if (payload) applyDltLoadedPayload(payload, true);
  } catch {}
}

async function onLoad() {
  try {
    const payload = await modelStorage.load(STORAGE_KEY);
    if (!payload) {
      const raw = localStorage.getItem(LEGACY_LS_KEY);
      if (raw) { applyDltLoadedPayload(JSON.parse(raw), false); return; }
      toast("没有找到已保存的模型");
      return;
    }
    applyDltLoadedPayload(payload, false);
  } catch (e) {
    toast(`加载失败：${e.message}`);
  }
}

function applyDltLoadedPayload(payload, silent) {
  if (payload?.lottery && payload.lottery !== "dlt") {
    toast(`这是 ${payload.lottery.toUpperCase()} 模型，不能导入到大乐透`);
    return;
  }
  state.model = deserializeDltModel(payload.model);
  state.seqLen = payload.seqLen || 15;
  state.history = payload.history || null;
  if (state.history) renderFinalMetrics(state.history);
  $("#btnDltLstmPredict").disabled = false;
  $("#btnDltLstmBacktest").disabled = !state.valSamples;
  $("#btnDltLstmSave").disabled = false;
  if ($("#btnDltLstmDownload")) $("#btnDltLstmDownload").disabled = false;
  if (silent) setStatus(`已自动加载 DLT 模型（${payload.savedAt?.slice(0, 19) || ""}）`, "ok");
  else toast("已加载");
}

function onDownload() {
  if (!state.model) return;
  const payload = buildDltPayload();
  const filename = `dlt-lstm-${new Date().toISOString().slice(0, 10)}.lottery.json`;
  modelStorage.exportToFile(payload, filename);
  toast(`已下载 ${filename}`);
}

function onUploadFile(file) {
  if (!file) return;
  modelStorage.importFromFile(file)
    .then((payload) => {
      applyDltLoadedPayload(payload, false);
      modelStorage.save(STORAGE_KEY, payload).catch(() => {});
    })
    .catch((e) => toast(`导入失败：${e.message}`));
}

async function onLoadDemo() {
  setStatus("加载 demo 模型…");
  try {
    const res = await fetch("./data/demo-models/dlt-lstm.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    applyDltLoadedPayload(payload, false);
    if (state.draws.length > payload.seqLen + 20) {
      const samples = buildDltSamples(state.draws, payload.seqLen);
      const splitIdx = Math.floor(samples.length * 0.85);
      state.trainSamples = samples.slice(0, splitIdx);
      state.valSamples = samples.slice(splitIdx);
      $("#btnDltLstmBacktest").disabled = false;
    }
    setStatus(
      `已加载 demo 模型（${payload.trainedOnIssues?.from} – ${payload.trainedOnIssues?.to}，${payload.hiddenDim}H × ${payload.numLayers}L）。可直接预测 / 回测，无需训练。`,
      "ok"
    );
    toast("Demo 模型加载完成");
  } catch (e) {
    setStatus(`Demo 加载失败：${e.message}`, "bad");
    toast(`Demo 加载失败：${e.message}`);
  }
}

function onOpenManager() {
  openModelManager({
    lottery: "dlt",
    currentKey: state.currentKey || STORAGE_KEY,
    onSwitch: (key, payload) => {
      state.currentKey = key;
      applyDltLoadedPayload(payload, false);
      toast(`已切换到「${key}」`);
    },
    onCompare: async (payloadA, payloadB, keyA, keyB) => {
      const card = $("#dltLstmCompareCard");
      const body = $("#dltLstmCompareBody");
      if (!card || !body) {
        toast("对比 UI 未找到");
        return;
      }
      card.style.display = "";
      body.innerHTML = `<div class="muted fine" style="padding:12px">正在对比 <strong class="mono">${keyA}</strong> vs <strong class="mono">${keyB}</strong>… 跑两轮 walk-forward 回测可能需要 20-60 秒，请稍候。</div>`;
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      try {
        const { renderComparison } = await import("./model-compare.js");
        await new Promise(r => setTimeout(r, 40));
        const html = await renderComparison(payloadA, payloadB, state.draws, "dlt");
        body.innerHTML = html;
        toast("对比完成");
      } catch (e) {
        body.innerHTML = `<div class="callout chip-warn" style="margin:0"><div class="callout-title">对比失败</div><div class="callout-body">${(e.message || String(e)).replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"})[c])}</div></div>`;
        console.error(e);
      }
    },
  });
}

/* ============================================================
 * UI helpers
 * ============================================================ */
function clampInt(sel, lo, hi, def) {
  const n = parseInt($(sel)?.value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}
function clampNum(sel, lo, hi, def) {
  const n = parseFloat($(sel)?.value);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}
function setStatus(text, kind = "") {
  const el = $("#dltLstmStatus");
  if (!el) return;
  el.textContent = text;
  el.className = `lstm-status ${kind ? `is-${kind}` : ""}`;
}
function setProgress(ratio) {
  const bar = $("#dltLstmProgressBar");
  if (!bar) return;
  bar.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
}
function setControls(training) {
  $("#btnDltLstmTrain").disabled = training;
  $("#btnDltLstmStop").disabled = !training;
  if (training) {
    $("#btnDltLstmPredict").disabled = true;
    $("#btnDltLstmBacktest").disabled = true;
    $("#btnDltLstmSave").disabled = true;
  }
}
function initCurves() {
  const el = $("#dltLstmCurves");
  if (!el) return;
  el.innerHTML = `
    <div class="curve-wrap" id="dltLstmLossCurve" data-label="Loss"></div>
    <div class="curve-wrap" id="dltLstmHitCurve" data-label="Front Hit@5"></div>
    <div class="curve-wrap" id="dltLstmLrCurve" data-label="Learning Rate"></div>
  `;
}
const liveSeries = { trainLoss: [], valLoss: [], hit5: [], hit2: [], lr: [], trainStartedAt: 0 };
function resetSeries() {
  liveSeries.trainLoss = []; liveSeries.valLoss = [];
  liveSeries.hit5 = []; liveSeries.hit2 = [];
  liveSeries.lr = [];
  liveSeries.trainStartedAt = Date.now();
}
function appendCurve(e) {
  liveSeries.trainLoss.push(e.trainLoss);
  liveSeries.valLoss.push(e.valLoss);
  liveSeries.hit5.push(e.valFrontHit5);
  liveSeries.hit2.push(e.valBackHit2);
  if (typeof e.lr === "number") liveSeries.lr.push(e.lr);
  drawSpark("#dltLstmLossCurve", [
    { label: "train", series: liveSeries.trainLoss, color: "var(--dlt-front)" },
    { label: "val", series: liveSeries.valLoss, color: "var(--dlt-back)" },
  ]);
  drawSpark("#dltLstmHitCurve", [
    { label: "val hit@5", series: liveSeries.hit5, color: "var(--acid)" },
  ], { ref: DLT_RANDOM_BASELINE.frontHit5, refLabel: `随机基线 ${DLT_RANDOM_BASELINE.frontHit5.toFixed(3)}` });
  if (liveSeries.lr.length > 0) {
    drawSpark("#dltLstmLrCurve", [
      { label: "lr", series: liveSeries.lr, color: "var(--gold)" },
    ]);
  }
}
function estimateETA(epochsDone, epochsTotal) {
  if (epochsDone === 0) return null;
  const elapsed = Date.now() - liveSeries.trainStartedAt;
  const perEpoch = elapsed / epochsDone;
  const remaining = (epochsTotal - epochsDone) * perEpoch;
  if (remaining <= 0) return null;
  if (remaining > 60000) return `约 ${Math.round(remaining / 60000)} 分钟剩余`;
  return `约 ${Math.round(remaining / 1000)} 秒剩余`;
}
function drawSpark(sel, series, extra = {}) {
  const el = document.querySelector(sel);
  if (!el) return;
  const W = el.clientWidth || 400;
  const H = 80;
  const padL = 32, padR = 8, padT = 8, padB = 14;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const all = series.flatMap((s) => s.series).concat(extra.ref != null ? [extra.ref] : []);
  if (all.length === 0) return;
  const minV = Math.min(...all);
  const maxV = Math.max(...all);
  const range = maxV - minV || 1;
  const yScale = (v) => padT + innerH - ((v - minV) / range) * innerH;
  const lines = series.map((s) => {
    if (s.series.length < 1) return "";
    const dx = innerW / Math.max(1, s.series.length - 1);
    const pts = s.series.map((v, i) => `${(padL + i * dx).toFixed(2)},${yScale(v).toFixed(2)}`).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="1.6" stroke-linecap="round"/>`;
  }).join("");
  const refLine = extra.ref != null
    ? `<line x1="${padL}" x2="${W - padR}" y1="${yScale(extra.ref)}" y2="${yScale(extra.ref)}" stroke="rgba(255,255,255,.35)" stroke-dasharray="2 4"/>
       <text x="${padL + 4}" y="${yScale(extra.ref) - 4}" font-size="9" fill="rgba(255,255,255,.55)" font-family="JetBrains Mono, monospace">${extra.refLabel}</text>`
    : "";
  el.innerHTML = `
    <div class="curve-label">${el.dataset.label}</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
      ${refLine}
      ${lines}
    </svg>
    <div class="curve-legend">${series.map((s) => `<span style="color:${s.color}">— ${s.label}</span>`).join("&nbsp;&nbsp;")}</div>
  `;
}
function renderFinalMetrics(history) {
  if (!history || !history.epochs.length) return;
  const last = history.epochs.length - 1;
  const items = [
    ["最佳验证损失", Math.min(...history.valLoss).toFixed(4)],
    ["末次训练损失", history.trainLoss[last]?.toFixed(4) ?? "—"],
    ["末次验证损失", history.valLoss[last]?.toFixed(4) ?? "—"],
    ["验证 前区 Hit@5", `${history.valFrontHit5[last]?.toFixed(3)}（基线 ${DLT_RANDOM_BASELINE.frontHit5.toFixed(3)}）`],
    ["验证 后区 Hit@2", `${history.valBackHit2[last]?.toFixed(3)}（基线 ${DLT_RANDOM_BASELINE.backHit2.toFixed(3)}）`],
    ["训练 epoch 数", String(history.epochs.length)],
  ];

  const cal = state.model?.calibration;
  if (cal) {
    const fmtImprove = (e) => {
      if (!e) return "—";
      const before = e.before, after = e.after;
      const pct = before > 0 ? ((before - after) / before * 100) : 0;
      return `${before.toFixed(3)} → ${after.toFixed(3)} (↓${pct.toFixed(0)}%)`;
    };
    items.push(["温度 T (front)", `${cal.frontT?.toFixed(3) ?? "—"} ${cal.frontT > 1 ? "（过自信→压平）" : cal.frontT < 1 ? "（欠自信→拉锐）" : ""}`]);
    items.push(["温度 T (back)", `${cal.backT?.toFixed(3) ?? "—"}`]);
    items.push(["前区 ECE", fmtImprove(cal.frontECE)]);
    items.push(["后区 ECE", fmtImprove(cal.backECE)]);
  }

  const el = $("#dltLstmMetrics");
  if (!el) return;
  el.innerHTML = items.map(([k, v]) => `
    <div class="diag-line"><span>${k}</span><strong class="mono">${v}</strong></div>
  `).join("");
}
function pause(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }
