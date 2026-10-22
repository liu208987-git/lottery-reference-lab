// LSTM 面板的 UI 控制器
//
// 职责：从 #panel-lstm 表单读参数 → 调用 trainer/backtest/ensemble → 渲染回页面

import { $, pad2 } from "./utils.js";
import { toast, copyToClipboard } from "./ui.js";
import {
  createModel, forwardModel, encodeSequence,
  topKRed, argMaxBlue,
  serializeModel, deserializeModel,
  RED_DIM, BLUE_DIM,
} from "./nn-ssq-model.js";
import { trainModel, buildSamples } from "./nn-trainer.js";
import {
  backtestModel, backtestFreqBaseline, backtestBayesBaseline, backtestUniformBaseline,
  backtestEnsemble,
} from "./nn-backtest.js";
import { trainEnsemble, ensembleForward } from "./nn-ensemble.js";
import { createRng } from "./rng.js";
import * as modelStorage from "./model-storage.js";
import { openModelManager } from "./model-manager-ui.js";
import { isWorkerAvailable, trainInWorker } from "./nn-worker-client.js";
import * as predictionHistory from "./prediction-history.js";
import { diagnoseSsqTicket } from "./ssq-explainer.js";
import { renderTrackerPanel } from "./prediction-tracker-ui.js";
import { renderConformalPanel } from "./conformal-ui.js";
import { renderSsqBacktestReport } from "./lstm-backtest-renderer.js";
import { renderExplainerCard } from "./lstm-explainer-card.js";
import { renderDriftMonitor } from "./drift-monitor-ui.js";

const STORAGE_KEY = "ssq-lstm-default";
const LEGACY_LS_KEY = "ssq-lstm-model-v2";  // 老 localStorage key

const state = {
  draws: [],
  model: null,        // 单模型
  ensemble: null,     // K 个模型 [{model}, ...]
  history: null,
  trainSamples: null,
  valSamples: null,
  seqLen: 15,
  shouldStop: false,
  isTraining: false,
};

export function setupLstmController(allDraws) {
  state.draws = allDraws;

  $("#btnLstmTrain")?.addEventListener("click", onTrain);
  $("#btnLstmStop")?.addEventListener("click", () => {
    state.shouldStop = true;
    if (state.workerStop) state.workerStop();
    setStatus("stopping…", "warn");
  });
  $("#btnLstmPredict")?.addEventListener("click", onPredict);
  $("#btnLstmBacktest")?.addEventListener("click", onBacktest);
  $("#btnLstmSave")?.addEventListener("click", onSave);
  $("#btnLstmLoad")?.addEventListener("click", onLoad);
  $("#btnLstmDownload")?.addEventListener("click", onDownload);
  $("#btnLstmLoadDemo")?.addEventListener("click", onLoadDemo);
  $("#btnLstmManager")?.addEventListener("click", onOpenManager);
  $("#lstmUploadFile")?.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) onUploadFile(f);
    e.target.value = "";
  });

  // 启动时尝试加载已保存的模型
  tryAutoLoadModel();

  // 启动时即渲染追踪面板（即使没数据也显示空态）
  setTimeout(() => mountTracker(), 80);
}

let trackerRef = null;
function mountTracker() {
  const container = $("#lstmTrackerBody");
  if (!container) return;
  trackerRef = renderTrackerPanel(container, "ssq", state.draws);
  // 顺便挂漂移监测
  const driftBody = $("#lstmDriftBody");
  if (driftBody) {
    renderDriftMonitor({ container: driftBody, draws: state.draws, lottery: "ssq" });
  }
}

/** 数据更新或新预测后调用，刷新追踪面板。 */
function refreshTracker() {
  if (trackerRef?.refresh) trackerRef.refresh();
}

export function updateLstmDraws(draws) {
  state.draws = draws;
}

/* ============================================================
 * 训练
 * ============================================================ */
async function onTrain() {
  if (state.isTraining) return;
  state.isTraining = true;
  state.shouldStop = false;
  setControlsDuringTraining(true);

  try {
    const seqLen = clampInt("#lstmSeqLen", 5, 50, 15);
    const hidden = clampInt("#lstmHidden", 16, 256, 64);
    const numLayers = clampInt("#lstmLayers", 1, 4, 2);
    const split = clampNum("#lstmSplit", 0.5, 0.95, 0.85);
    const lr = clampNum("#lstmLr", 1e-4, 0.1, 0.003);
    const epochs = clampInt("#lstmEpochs", 1, 100, 20);
    const batchSize = clampInt("#lstmBatch", 4, 128, 32);
    const dropoutInput = clampNum("#lstmDropIn", 0, 0.5, 0.1);
    const dropoutHidden = clampNum("#lstmDropHidden", 0, 0.5, 0.2);
    const dropoutOutput = clampNum("#lstmDropOut", 0, 0.5, 0.2);
    const ensembleK = clampInt("#lstmEnsembleK", 1, 8, 1);
    const labelSmoothing = clampNum("#lstmLabelSmooth", 0, 0.2, 0.05);
    const lcbLambda = clampNum("#lstmLcbLambda", 0, 3, 0);
    const seedStr = $("#lstmSeed")?.value?.trim() || `train-${Date.now()}`;
    state.seqLen = seqLen;
    state.lcbLambda = lcbLambda;

    setStatus("准备样本…");
    const samples = buildSamples(state.draws, seqLen);
    if (samples.length < 100) throw new Error(`数据太少，至少需要 ${100 + seqLen} 期`);
    const splitIdx = Math.floor(samples.length * split);
    state.trainSamples = samples.slice(0, splitIdx);
    state.valSamples = samples.slice(splitIdx);

    const arch = `H=${hidden} · L=${numLayers} · drop[in/h/out]=${dropoutInput}/${dropoutHidden}/${dropoutOutput} · K=${ensembleK}`;
    setStatus(`训练：${state.trainSamples.length} train / ${state.valSamples.length} val · T=${seqLen} · ${arch}`);
    state.history = null;
    state.ensemble = null;
    state.model = null;
    initCurves();
    resetLiveSeries();

    const t0 = Date.now();
    const baseModelOpts = {
      hiddenDim: hidden, numLayers,
      dropoutInput, dropoutHidden, dropoutOutput,
    };
    const baseTrainOpts = {
      epochs, batchSize, lr,
      gradClip: 5,
      patience: 6,
      weightDecay: 1e-5,
      labelSmoothing,
    };

    if (state.useWorker !== false && isWorkerAvailable()) {
      // ── Web Worker 训练 ──
      const workerHandle = trainInWorker({
        cmd: "trainSsq",
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
          appendCurve(e, e.member);
          const eta = estimateETA(e.epoch + 1, e.totalEpochs) || "";
          if (ensembleK > 1) {
            setStatus(`成员 ${e.member + 1}/${e.totalMembers} · epoch ${e.epoch + 1}/${e.totalEpochs} · train ${e.trainLoss.toFixed(4)} · val ${e.valLoss.toFixed(4)} · 红 hit@6 ${e.valRedHit6.toFixed(3)}${eta ? ` · ${eta}` : ""}`);
          } else {
            setStatus(`[worker] epoch ${e.epoch + 1}/${e.totalEpochs} · train ${e.trainLoss.toFixed(4)} · val ${e.valLoss.toFixed(4)} · 红 hit@6 ${e.valRedHit6.toFixed(3)}${eta ? ` · ${eta}` : ""}`);
          }
        },
      });
      state.workerStop = workerHandle.stop;
      const payload = await workerHandle.done;
      if (payload.type === "ensemble") {
        state.ensemble = {
          members: payload.members.map(deserializeModel),
          histories: payload.histories,
        };
        state.history = state.ensemble.histories[state.ensemble.histories.length - 1] || null;
        state.model = state.ensemble.members[0];
      } else {
        state.model = deserializeModel(payload.model);
        if (payload.calibration) state.model.calibration = payload.calibration;
        state.history = payload.history;
        state.ensemble = null;
      }
    } else if (ensembleK > 1) {
      const result = await trainEnsemble(state.trainSamples, state.valSamples, {
        K: ensembleK,
        seedBase: seedStr,
        modelOpts: baseModelOpts,
        trainOpts: {
          ...baseTrainOpts,
          onBatch: (b) => {
            if (b.totalBatches) setProgress((b.member / b.totalMembers) + (b.batch / b.totalBatches / b.totalMembers));
          },
          onEpoch: (e) => {
            appendCurve(e, e.member);
            setStatus(`成员 ${e.member + 1}/${e.totalMembers} · epoch ${e.epoch + 1}/${e.totalEpochs} · train ${e.trainLoss.toFixed(4)} · val ${e.valLoss.toFixed(4)} · 红 hit@6 ${e.valRedHit6.toFixed(3)} · 蓝 ${(e.valBlueAcc * 100).toFixed(1)}%`);
          },
        },
        shouldStop: () => state.shouldStop,
      });
      state.ensemble = { members: result.members, histories: result.histories };
      state.history = result.histories[result.histories.length - 1];
    } else {
      const memberRng = createRng(seedStr).next;
      state.model = createModel({ ...baseModelOpts, rng: memberRng });
      const result = await trainModel(state.model, state.trainSamples, state.valSamples, {
        ...baseTrainOpts,
        rng: memberRng,
        onBatch: (b) => {
          if (b.totalBatches) setProgress(b.batch / b.totalBatches);
          if (b.nan) setStatus(`epoch ${b.epoch + 1} batch ${b.batch}: NaN 跳过`, "warn");
        },
        onEpoch: (e) => {
          appendCurve(e);
          setStatus(`epoch ${e.epoch + 1}/${e.totalEpochs} · train ${e.trainLoss.toFixed(4)} · val ${e.valLoss.toFixed(4)} · 红 hit@6 ${e.valRedHit6.toFixed(3)} · 蓝 acc ${(e.valBlueAcc * 100).toFixed(1)}%`);
          setProgress((e.epoch + 1) / e.totalEpochs);
        },
        shouldStop: () => state.shouldStop,
      });
      state.history = result.history;
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const bestLoss = state.history ? Math.min(...state.history.valLoss).toFixed(4) : "—";
    setStatus(`训练完成 · ${elapsed}s · best val ${bestLoss}${state.ensemble ? ` · ${ensembleK} 模型集成` : ""}`, "ok");
    setProgress(1);

    if (state.history) renderFinalMetrics(state.history);

    $("#btnLstmPredict").disabled = false;
    $("#btnLstmBacktest").disabled = false;
    $("#btnLstmSave").disabled = false; // ensemble 也可保存（v2）
    if ($("#btnLstmDownload")) $("#btnLstmDownload").disabled = false;
  } catch (err) {
    setStatus(`错误：${err.message || err}`, "bad");
    console.error(err);
  } finally {
    state.isTraining = false;
    setControlsDuringTraining(false);
  }
}

/* ============================================================
 * 预测下一期
 * ============================================================ */
function onPredict() {
  if (!state.model && !state.ensemble) return;
  const window = state.draws.slice(-state.seqLen);
  // 特征需要"截至 window 第一期之前"的全历史
  const historyBeforeWindow = state.draws.slice(0, state.draws.length - state.seqLen);
  const seq = encodeSequence(window, historyBeforeWindow);

  let redProbs, blueProbs, redStd = null, blueStd = null;
  if (state.ensemble) {
    const out = ensembleForward(state.ensemble.members, seq);
    redProbs = out.redProbs;
    blueProbs = out.blueProbs;
    redStd = out.redStd;
    blueStd = out.blueStd;
  } else {
    const fwd = forwardModel(state.model, seq, { training: false });
    redProbs = fwd.redProbs;
    blueProbs = fwd.blueProbs;
  }

  // 选号：如果有 ensemble 且 lcbLambda > 0，用 LCB（μ - λσ）排序，
  // 这能避开"模型也不确定"的号码，让多注分散覆盖更稳健。
  const lambda = state.lcbLambda || 0;
  let top6;
  if (state.ensemble && redStd && lambda > 0) {
    const arr = [];
    for (let i = 0; i < RED_DIM; i++) {
      arr.push([i + 1, redProbs.data[i] - lambda * redStd.data[i], redProbs.data[i], redStd.data[i]]);
    }
    arr.sort((a, b) => b[1] - a[1]);
    top6 = arr.slice(0, 6).map(([n, score, mean]) => [n, mean]);
  } else {
    top6 = topKRed(redProbs, 6);
  }
  const blueArg = argMaxBlue(blueProbs);
  const blueRanked = [];
  for (let i = 0; i < BLUE_DIM; i++) blueRanked.push([i + 1, blueProbs.data[i]]);
  blueRanked.sort((a, b) => b[1] - a[1]);

  const card = $("#lstmPredictionCard");
  const body = $("#lstmPredictionBody");
  card.style.display = "";

  // 红球 33 个号码概率热度条
  const redBars = [];
  let redMax = 0;
  for (let i = 0; i < RED_DIM; i++) redMax = Math.max(redMax, redProbs.data[i]);
  for (let i = 0; i < RED_DIM; i++) {
    const p = redProbs.data[i];
    const w = (p / Math.max(1e-9, redMax)) * 100;
    const isPicked = top6.some(([n]) => n === i + 1);
    const stdInfo = redStd
      ? ` <span class="muted fine">±${(redStd.data[i] * 100).toFixed(1)}%</span>`
      : "";
    redBars.push(`
      <div class="prob-row">
        <span class="ball red ${isPicked ? "" : "muted-ball"}" style="width:24px;height:24px;font-size:10px;box-shadow:none">${pad2(i + 1)}</span>
        <span class="prob-bar"><i style="width:${w.toFixed(1)}%"></i></span>
        <span class="mono prob-val">${(p * 100).toFixed(1)}%${stdInfo}</span>
      </div>
    `);
  }
  // 蓝球
  const blueBars = blueRanked.map(([n, p]) => {
    const stdInfo = blueStd
      ? ` <span class="muted fine">±${(blueStd.data[n - 1] * 100).toFixed(1)}%</span>`
      : "";
    return `
      <div class="prob-row">
        <span class="ball blue ${n === blueArg.num ? "" : "muted-ball"}" style="width:24px;height:24px;font-size:10px;box-shadow:none">${pad2(n)}</span>
        <span class="prob-bar"><i style="width:${(p * 100).toFixed(1)}%"></i></span>
        <span class="mono prob-val">${(p * 100).toFixed(1)}%${stdInfo}</span>
      </div>
    `;
  }).join("");

  const ensembleBadge = state.ensemble
    ? `<span class="chip chip-ok" style="margin-left:8px">${state.ensemble.members.length} 模型集成</span>`
    : "";

  body.innerHTML = `
    <div class="prediction-pick">
      <div class="prediction-label">Top-6 红 + 蓝${ensembleBadge}</div>
      <div class="balls">
        ${top6.map(([n]) => `<span class="ball red">${pad2(n)}</span>`).join("")}
        <span class="ball blue plus">${pad2(blueArg.num)}</span>
      </div>
    </div>
    <div class="prediction-cols">
      <div>
        <div class="card-title">红球 33 路概率${redStd ? "（± 集成 std）" : ""}</div>
        ${redBars.join("")}
      </div>
      <div>
        <div class="card-title">蓝球 16 路概率${blueStd ? "（± 集成 std）" : ""}</div>
        ${blueBars}
      </div>
    </div>
    <div class="callout" style="margin-top:14px">
      <div class="callout-title">⚠️ 模型局限性</div>
      <div class="callout-body">
        本预测器在 walk-forward 回测里的红球 Top-6 命中数与<strong>均匀随机基线（≈ 1.09 / 期）</strong>统计上不可区分；
        蓝球 Top-1 准确率与<strong>1/16 ≈ 6.25%</strong> 的随机基线统计上不可区分。<br/>
        <strong>这不是因为模型差，而是因为彩票本身没有可学习的时间规律。</strong>
        点击下方「Walk-forward 回测」可亲眼验证。预测号码<strong>不提高</strong>实际中奖概率，仅供学习与娱乐。
      </div>
    </div>
  `;
  toast("已生成预测");

  // 号码体检（六维度评分 + 健康灯）
  try {
    const reds6 = top6.map(([n]) => n);
    const diag = diagnoseSsqTicket({ reds: reds6, blue: blueArg.num }, state.draws);
    renderExplainerCard({
      container: $("#lstmPredictionBody"),
      diag,
      primaryColor: "var(--acid)",
    });
  } catch (e) {
    console.warn("explainer failed:", e);
  }

  // 记录预测追踪（用于"我做的预测命中分布"长期统计）
  try {
    const lastDraw = state.draws[state.draws.length - 1];
    const targetIssue = lastDraw ? nextIssue(lastDraw.issue) : "next";
    predictionHistory.record({
      lottery: "ssq",
      targetIssue,
      modelType: state.ensemble ? "lstm-ensemble" : "lstm-single",
      topReds: top6.map(([n]) => n),
      topBlue: [blueArg.num],
      K: { reds: 6, blue: 1 },
    });
    refreshTracker();
  } catch (e) { /* localStorage 满 */ }
}

function nextIssue(issue) {
  // 期号格式：双色球 7 位 (YYYYNNN)、大乐透 5 位 (YYNNN)
  // 简化：末尾数字 +1（年末跨年由抓取脚本兜底）
  const s = String(issue);
  const last = s.slice(-3);
  const n = parseInt(last, 10);
  if (!Number.isFinite(n)) return s + "+1";
  return s.slice(0, -3) + String(n + 1).padStart(3, "0");
}

/* ============================================================
 * Walk-forward 回测
 * ============================================================ */
async function onBacktest() {
  const sourceModel = state.model || (state.ensemble ? state.ensemble.members[0] : null);
  if (!sourceModel) return;
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

    // LSTM（单模型 or ensemble 第一个）；如果有 ensemble，再额外算一个 ensemble backtest
    const lstmRes = backtestModel(sourceModel, trainTail, testDraws, seqLen, historyBeforeTrainTail);
    let ensembleRes = null;
    if (state.ensemble && state.ensemble.members.length > 1) {
      ensembleRes = backtestEnsemble(state.ensemble.members, trainTail, testDraws, seqLen, historyBeforeTrainTail);
    }

    const freqRes = backtestFreqBaseline(state.draws.slice(0, splitIdx), testDraws);
    const bayesRes = backtestBayesBaseline(state.draws.slice(0, splitIdx), testDraws);
    const uniformRes = backtestUniformBaseline(testDraws, 100, "uniform-baseline");

    const card = $("#lstmBacktestCard");
    const body = $("#lstmBacktestBody");
    card.style.display = "";
    body.innerHTML = renderSsqBacktestReport({
      lstm: lstmRes, ensemble: ensembleRes,
      freq: freqRes, bayes: bayesRes, uniform: uniformRes,
      n: testDraws.length,
      ensembleSize: state.ensemble?.members?.length || 0,
      calibration: state.model?.calibration || state.ensemble?.members?.[0]?.calibration || null,
    });
    setStatus(`回测完成：${testDraws.length} 期`, "ok");

    // 激活共形面板：用 lstm 单模型记录 + 当前最新预测概率（如果有）
    try {
      const conformalCard = $("#lstmConformalCard");
      const conformalBody = $("#lstmConformalBody");
      if (conformalCard && conformalBody) {
        conformalCard.style.display = "";
        // 取最新一期预测概率
        let latestProbs = null;
        try {
          const window = state.draws.slice(-state.seqLen);
          const histBefore = state.draws.slice(0, state.draws.length - state.seqLen);
          const seq = encodeSequence(window, histBefore);
          if (state.ensemble) {
            const out = ensembleForward(state.ensemble.members, seq);
            latestProbs = Float32Array.from(out.redProbs.data);
          } else if (state.model) {
            const fwd = forwardModel(state.model, seq, { training: false });
            latestProbs = Float32Array.from(fwd.redProbs.data);
          }
        } catch (e) { /* ignore */ }
        renderConformalPanel({
          container: conformalBody,
          backtestRecords: lstmRes.records,
          lottery: "ssq",
          latestProbs,
        });
      }
    } catch (e) { console.warn("conformal panel failed:", e); }
  } catch (err) {
    setStatus(`回测失败：${err.message || err}`, "bad");
    console.error("backtest error:", err, err?.stack);
  }
}


/* ============================================================
 * 持久化（IndexedDB + 文件导出 / 导入）
 * ============================================================ */
async function onSave() {
  if (!state.model && !state.ensemble) return;
  const payload = buildPayload();
  // 优先保存到 IndexedDB
  try {
    await modelStorage.save(STORAGE_KEY, payload);
    // 申请持久化（防止浏览器主动清理）
    modelStorage.requestPersistence().catch(() => {});
    const tag = payload.type === "ensemble" ? `${payload.members.length} 模型集成` : "单模型";
    const quota = await modelStorage.getQuota();
    const quotaStr = quota
      ? `（已用 ${(quota.usage / 1024 / 1024).toFixed(1)} / ${(quota.quota / 1024 / 1024).toFixed(0)} MB）`
      : "";
    toast(`已保存到 IndexedDB · ${tag} ${quotaStr}`);
  } catch (e) {
    // 兜底：localStorage
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      toast(`已降级保存到 localStorage（${e.message}）`);
    } catch (e2) {
      toast(`保存失败：${e2.message}（请用「下载到本地」）`);
    }
  }
}

function buildPayload() {
  return state.ensemble
    ? {
        type: "ensemble",
        lottery: "ssq",
        members: state.ensemble.members.map(serializeModel),
        histories: state.ensemble.histories,
        seqLen: state.seqLen,
        hiddenDim: state.ensemble.members[0]?.hiddenDim,
        numLayers: state.ensemble.members[0]?.numLayers,
        savedAt: new Date().toISOString(),
      }
    : {
        type: "single",
        lottery: "ssq",
        model: serializeModel(state.model),
        seqLen: state.seqLen,
        history: state.history,
        hiddenDim: state.model?.hiddenDim,
        numLayers: state.model?.numLayers,
        savedAt: new Date().toISOString(),
      };
}

/** 启动时自动加载：先 IndexedDB，回退老 localStorage。 */
async function tryAutoLoadModel() {
  try {
    let payload = await modelStorage.load(STORAGE_KEY);
    if (!payload) {
      // 一次性迁移老 localStorage
      payload = await modelStorage.migrateFromLocalStorage(LEGACY_LS_KEY, STORAGE_KEY);
      if (payload) toast("已从 localStorage 迁移老模型到 IndexedDB");
    }
    if (payload) applyLoadedPayload(payload, /*silent=*/true);
  } catch {}
}

async function onLoad() {
  try {
    const payload = await modelStorage.load(STORAGE_KEY);
    if (!payload) {
      // 再回退试老 localStorage
      const raw = localStorage.getItem(LEGACY_LS_KEY);
      if (raw) {
        applyLoadedPayload(JSON.parse(raw), false);
        return;
      }
      toast("没有找到已保存的模型");
      return;
    }
    applyLoadedPayload(payload, false);
  } catch (e) {
    toast(`加载失败：${e.message}`);
  }
}

/** 下载模型到本地 .json 文件（最稳的备份方式）。 */
function onDownload() {
  if (!state.model && !state.ensemble) return;
  const payload = buildPayload();
  const filename = `ssq-lstm-${payload.type}-${new Date().toISOString().slice(0, 10)}.lottery.json`;
  modelStorage.exportToFile(payload, filename);
  toast(`已下载 ${filename}`);
}

/** 从本地 .json 文件导入（跨设备最稳的同步方式）。 */
function onUploadFile(file) {
  if (!file) return;
  modelStorage.importFromFile(file)
    .then((payload) => {
      if (payload?.lottery && payload.lottery !== "ssq") {
        toast(`这是 ${payload.lottery.toUpperCase()} 模型，不能导入到双色球`);
        return;
      }
      applyLoadedPayload(payload, false);
      // 自动保存一份到 IndexedDB
      modelStorage.save(STORAGE_KEY, payload).catch(() => {});
    })
    .catch((e) => toast(`导入失败：${e.message}`));
}

/** 一键加载预训练 demo 模型（不需要训练）。 */
async function onLoadDemo() {
  setStatus("加载 demo 模型…");
  try {
    const res = await fetch("./data/demo-models/ssq-lstm.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    applyLoadedPayload(payload, false);
    // 自动 build val samples 让"回测"按钮可用
    if (state.draws.length > payload.seqLen + 20) {
      const samples = buildSamples(state.draws, payload.seqLen);
      const splitIdx = Math.floor(samples.length * 0.85);
      state.trainSamples = samples.slice(0, splitIdx);
      state.valSamples = samples.slice(splitIdx);
      $("#btnLstmBacktest").disabled = false;
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

/** 打开模型管理器对话框。 */
function onOpenManager() {
  openModelManager({
    lottery: "ssq",
    currentKey: state.currentKey || STORAGE_KEY,
    onSwitch: (key, payload) => {
      // 只切换 state，不覆盖 STORAGE_KEY 的内容（保护用户原 default key 数据）
      // 切换后用户如果想"把这个变成默认启动模型"，可以再点一次保存。
      state.currentKey = key;
      applyLoadedPayload(payload, false);
      toast(`已切换到「${key}」`);
    },
    onCompare: async (payloadA, payloadB, keyA, keyB) => {
      const card = $("#lstmCompareCard");
      const body = $("#lstmCompareBody");
      if (!card || !body) {
        toast("对比 UI 未找到");
        return;
      }
      card.style.display = "";
      body.innerHTML = `<div class="muted fine" style="padding:12px">正在对比 <strong class="mono">${keyA}</strong> vs <strong class="mono">${keyB}</strong>… 跑两轮 walk-forward 回测可能需要 20-60 秒，请稍候。</div>`;
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      try {
        const { renderComparison } = await import("./model-compare.js");
        await pause(40);  // 让浏览器先 paint loading 文字
        const html = await renderComparison(payloadA, payloadB, state.draws, "ssq");
        body.innerHTML = html;
        toast("对比完成");
      } catch (e) {
        body.innerHTML = `<div class="callout chip-warn" style="margin:0"><div class="callout-title">对比失败</div><div class="callout-body">${escapeText(e.message || String(e))}</div></div>`;
        console.error(e);
      }
    },
  });
}

function escapeText(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function applyLoadedPayload(payload, silent) {
  state.seqLen = payload.seqLen || 15;
  if (payload.type === "ensemble" && Array.isArray(payload.members)) {
    state.ensemble = {
      members: payload.members.map(deserializeModel),
      histories: payload.histories || [],
    };
    state.model = null;
    state.history = state.ensemble.histories[state.ensemble.histories.length - 1] || null;
    if (state.history) renderFinalMetrics(state.history);
    $("#btnLstmPredict").disabled = false;
    $("#btnLstmBacktest").disabled = !state.valSamples;
    $("#btnLstmSave").disabled = false;
    if ($("#btnLstmDownload")) $("#btnLstmDownload").disabled = false;
    if (!silent) toast(`已加载 ensemble（K=${state.ensemble.members.length}）`);
    else setStatus(`已自动加载保存的 ensemble（K=${state.ensemble.members.length}），可直接预测`, "ok");
  } else {
    // 兼容老版（type 缺失也按 single 处理）
    const modelObj = payload.model || payload; // 历史结构兼容
    state.model = deserializeModel(modelObj);
    state.ensemble = null;
    state.history = payload.history || null;
    if (state.history) renderFinalMetrics(state.history);
    $("#btnLstmPredict").disabled = false;
    $("#btnLstmBacktest").disabled = !state.valSamples;
    $("#btnLstmSave").disabled = false;
    if ($("#btnLstmDownload")) $("#btnLstmDownload").disabled = false;
    if (!silent) toast("已加载模型");
    else setStatus(`已自动加载保存的模型（${payload.savedAt?.slice(0, 19) || ""}），可直接预测`, "ok");
  }
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
  const el = $("#lstmStatus");
  if (!el) return;
  el.textContent = text;
  el.className = `lstm-status ${kind ? `is-${kind}` : ""}`;
}

function setProgress(ratio) {
  const bar = $("#lstmProgressBar");
  if (!bar) return;
  bar.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
}

function setControlsDuringTraining(training) {
  $("#btnLstmTrain").disabled = training;
  $("#btnLstmStop").disabled = !training;
  if (training) {
    $("#btnLstmPredict").disabled = true;
    $("#btnLstmBacktest").disabled = true;
    $("#btnLstmSave").disabled = true;
  }
}

function initCurves() {
  const el = $("#lstmCurves");
  if (!el) return;
  el.innerHTML = `
    <div class="curve-wrap" id="lstmLossCurve" data-label="Loss"></div>
    <div class="curve-wrap" id="lstmHitCurve" data-label="Red Top-6 Hit"></div>
    <div class="curve-wrap" id="lstmLrCurve" data-label="Learning Rate"></div>
  `;
}

const liveSeries = {
  trainLoss: [], valLoss: [], hit6: [], blueAcc: [], lr: [],
  trainStartedAt: 0,
};

function resetLiveSeries() {
  liveSeries.trainLoss = [];
  liveSeries.valLoss = [];
  liveSeries.hit6 = [];
  liveSeries.blueAcc = [];
  liveSeries.lr = [];
  liveSeries.trainStartedAt = Date.now();
}

function appendCurve(epochState) {
  liveSeries.trainLoss.push(epochState.trainLoss);
  liveSeries.valLoss.push(epochState.valLoss);
  liveSeries.hit6.push(epochState.valRedHit6);
  liveSeries.blueAcc.push(epochState.valBlueAcc);
  if (typeof epochState.lr === "number") liveSeries.lr.push(epochState.lr);

  drawSpark("#lstmLossCurve", [
    { label: "train", series: liveSeries.trainLoss, color: "var(--blue)" },
    { label: "val", series: liveSeries.valLoss, color: "var(--red)" },
  ], "min");
  drawSpark("#lstmHitCurve", [
    { label: "val hit@6", series: liveSeries.hit6, color: "var(--acid)" },
  ], "max", { ref: 6 * 6 / 33, refLabel: "随机基线 1.09" });
  if (liveSeries.lr.length > 0) {
    drawSpark("#lstmLrCurve", [
      { label: "lr", series: liveSeries.lr, color: "var(--gold)" },
    ], "max");
  }
}

/** 计算 ETA：基于已用时间 / 已完成 epoch * 剩余 epoch。 */
export function estimateETA(epochsDone, epochsTotal) {
  if (epochsDone === 0) return null;
  const elapsed = Date.now() - liveSeries.trainStartedAt;
  const perEpoch = elapsed / epochsDone;
  const remaining = (epochsTotal - epochsDone) * perEpoch;
  if (remaining <= 0) return null;
  if (remaining > 60000) return `约 ${Math.round(remaining / 60000)} 分钟剩余`;
  return `约 ${Math.round(remaining / 1000)} 秒剩余`;
}

function drawSpark(sel, series, opt, extra = {}) {
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
    ["验证 红球 Hit@6", `${history.valRedHit6[last]?.toFixed(3)}（基线 ${(6*6/33).toFixed(3)}）`],
    ["验证 蓝球 Top-1", `${(history.valBlueAcc[last] * 100).toFixed(2)}%（基线 6.25%）`],
    ["训练 epoch 数", String(history.epochs.length)],
  ];

  // 加上 calibration 信息（如果有）
  const cal = state.model?.calibration || state.ensemble?.members?.[0]?.calibration;
  if (cal) {
    const fmtImprove = (e) => {
      if (!e) return "—";
      const before = e.before, after = e.after;
      const pct = before > 0 ? ((before - after) / before * 100) : 0;
      return `${before.toFixed(3)} → ${after.toFixed(3)} (↓${pct.toFixed(0)}%)`;
    };
    items.push(["温度 T (red)", `${cal.redT?.toFixed(3) ?? "—"} ${cal.redT > 1 ? "（过自信→压平）" : cal.redT < 1 ? "（欠自信→拉锐）" : ""}`]);
    items.push(["温度 T (blue)", `${cal.blueT?.toFixed(3) ?? "—"}`]);
    items.push(["红球 ECE", fmtImprove(cal.redECE)]);
    items.push(["蓝球 ECE", fmtImprove(cal.blueECE)]);
  }

  const el = $("#lstmMetrics");
  if (!el) return;
  el.innerHTML = items.map(([k, v]) => `
    <div class="diag-line"><span>${k}</span><strong class="mono">${v}</strong></div>
  `).join("");
}

function pause(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}
