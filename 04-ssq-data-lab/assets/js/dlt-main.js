// 大乐透主控制器：与 main.js 同构，但全部基于 DLT 配置（5 选 35 + 2 选 12）。

import { $, $$, clamp, pad2, parseNumList } from "./utils.js";
import { loadDltDraws } from "./dlt-data.js";
import { DLT_CONFIG } from "./lottery-config.js";
import {
  zoneFreq, zoneCurrentMiss, topNFromFreq, zoneMissStats, zoneMissStatsWithSignificance, buildZoneTrend,
} from "./lottery-stats.js";
import { renderDltBars } from "./dlt-chart.js";
import { renderDltTrend } from "./dlt-trend-chart.js";
import { generateDltTickets } from "./dlt-generator.js";
import { generateDltAdvanced } from "./dlt-advanced-sampler.js";
import { runDltBacktest } from "./dlt-backtest.js";
import {
  expectedReturn, additionalBetEdge, withPrizeProbabilities,
  ticketsExpectedReturn, breakevenJackpot,
} from "./dlt-prize.js";
import { simulateChase } from "./dlt-chase.js";
import {
  frontBackSumCorrelation, oddCountIndependenceTest,
  frontBackPairLift, verdictFromP,
} from "./dlt-independence.js";
import { diagnoseTicket } from "./dlt-explainer.js";
import { setupDltLstmController, updateDltLstmDraws } from "./dlt-lstm-controller.js";
import { renderBettingPanel } from "./rational-betting-ui.js";
import {
  frontOddEvenRatio, frontBigSmallRatio, frontPrimeCompositeRatio,
  frontPath012Ratio, frontZoneRatio, frontAcValue,
  frontConsecutiveGroups, frontMaxSameTail,
  frontSum, frontSpan, backSum, backSpan, backOddEvenRatio,
  groupByRatio,
  FRONT_SIZE, FRONT_PICK, BACK_SIZE, BACK_PICK,
  FRONT_SUM_MIN, FRONT_SUM_MAX, FRONT_SPAN_MIN, FRONT_SPAN_MAX,
  BACK_SUM_MIN, BACK_SUM_MAX,
} from "./dlt-distribution.js";
import { frontChi, backChi, chiSquaredPValue } from "./dlt-chi-square.js";
import {
  dltDanTuoTickets, dltComplexTickets, combinations, dltPriceOf,
} from "./dlt-combinatorics.js";
import {
  buildDltCooccurrenceMatrix, topDltPartners, dltLiftOf, extremeDltPairs,
  FRONT_INDEPENDENT_LIFT_BASELINE,
} from "./dlt-cooccurrence.js";
import { renderDltTimeSeries } from "./dlt-timeseries.js";
import {
  nextDltDrawTime, dltSaleCutoffOf, diffDuration,
  formatChinaTime, nextDltIssueOf,
} from "./dlt-countdown.js";
import {
  setupTabs, setupTheme,
  renderDltLatest, renderDltHeroMeta, renderDltRank, renderDltTable,
  renderDltInsightChips, renderDltTickets, formatDltTicketLine,
  copyToClipboard, renderDltTicketAnalysis, showLoadError,
  showDltDataSourceBanner, setRefreshLoading,
  readDltWinSize, readDltGeneratorConfig, showDltGenError,
  setDltGenDiagnostics, toast, renderDltSamplerDiagnostics,
  readDltBacktestConfig, renderDltBacktestResult,
} from "./dlt-ui.js";

const FRONT_ZONE = DLT_CONFIG.zones[0];
const BACK_ZONE = DLT_CONFIG.zones[1];

const state = {
  meta: {},
  draws: [],
  winSize: 200,
  freqAllFront: null,
  freqAllBack: null,
  freqRecentFront: null,
  freqRecentBack: null,
  missFront: null,
  missBack: null,
  coMatrix: null,
  tableRows: [],
  lastTickets: [],
};

function computeStats() {
  state.freqAllFront = zoneFreq(state.draws, FRONT_ZONE);
  state.freqAllBack = zoneFreq(state.draws, BACK_ZONE);
  const recent = state.draws.slice(-state.winSize);
  state.freqRecentFront = zoneFreq(recent, FRONT_ZONE);
  state.freqRecentBack = zoneFreq(recent, BACK_ZONE);
  state.missFront = zoneCurrentMiss(state.draws, FRONT_ZONE);
  state.missBack = zoneCurrentMiss(state.draws, BACK_ZONE);
  // χ² 显著性
  state.chiSquareFront = zoneMissStatsWithSignificance(state.draws, FRONT_ZONE);
  state.chiSquareBack = zoneMissStatsWithSignificance(state.draws, BACK_ZONE);
  state.coMatrix = null; // lazy
}

function renderOverviewAndInsight() {
  const latest = state.draws[state.draws.length - 1];
  renderDltHeroMeta(state.meta, state.draws);
  renderDltLatest(latest);

  renderDltBars($("#chartFrontAll"), state.freqAllFront, FRONT_SIZE, "front");
  renderDltBars($("#chartBackAll"), state.freqAllBack, BACK_SIZE, "back");
  renderDltRank($("#rankFrontRecent"), topNFromFreq(state.freqRecentFront, 8, FRONT_SIZE), "front");
  renderDltRank($("#rankBackRecent"), topNFromFreq(state.freqRecentBack, 6, BACK_SIZE), "back");

  renderDltBars($("#chartFrontMiss"), state.missFront, FRONT_SIZE, "front-miss", { unit: "期" });
  renderDltBars($("#chartBackMiss"), state.missBack, BACK_SIZE, "back-miss", { unit: "期" });
  renderDltInsightChips({
    freqRecentFront: state.freqRecentFront,
    missFront: state.missFront,
    missBack: state.missBack,
    chiSquareFront: state.chiSquareFront,
    chiSquareBack: state.chiSquareBack,
  });

  renderDataTable();
}

function renderTrendPanel() {
  const win = Number($("#trendWindow")?.value || 50);
  const showStats = $("#trendShowStats")?.checked !== false;
  const slice = state.draws.slice(-win);
  const rows = slice.map((d) => ({
    issue: d.issue,
    date: d.date,
    hit: new Set(d.front),
  }));
  const rowsBack = slice.map((d) => ({
    issue: d.issue,
    date: d.date,
    hit: new Set(d.back),
  }));
  const frontStats = showStats ? toIndexed(zoneMissStats(slice, FRONT_ZONE)) : null;
  const backStats = showStats ? toIndexed(zoneMissStats(slice, BACK_ZONE)) : null;
  renderDltTrend($("#trendFront"), rows, {
    size: FRONT_SIZE, kind: "front", stats: frontStats,
    zoneBoundaries: [12, 24],
  });
  renderDltTrend($("#trendBack"), rowsBack, {
    size: BACK_SIZE, kind: "back", stats: backStats,
  });
}

// zoneMissStats 返回从 index 1 起的对象数组；走势图渲染器期望 stats[1..size]
function toIndexed(arr) { return arr; }

function renderRatioList(el, entries, top = 8) {
  if (!el) return;
  el.innerHTML = "";
  const totalCount = entries.reduce((a, b) => a + b[1], 0);
  const max = entries[0]?.[1] || 1;
  const items = entries.slice(0, top);
  for (const [k, v] of items) {
    const pct = ((v / totalCount) * 100).toFixed(1);
    const w = Math.round((v / max) * 100);
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="ratio-row">
        <span class="ratio-key">${k}</span>
        <span class="ratio-bar"><i style="width:0%"></i></span>
        <span class="ratio-val">${v} · ${pct}%</span>
      </div>
    `;
    el.appendChild(li);
    requestAnimationFrame(() => {
      const fill = li.querySelector(".ratio-bar i");
      if (fill) fill.style.width = `${w}%`;
    });
  }
}

function renderDistributionPanel() {
  const draws = state.draws;
  renderRatioList($("#distOddEven"), groupByRatio(draws, (d) => frontOddEvenRatio(d.front)));
  renderRatioList($("#distBigSmall"), groupByRatio(draws, (d) => frontBigSmallRatio(d.front)));
  renderRatioList($("#distPrime"), groupByRatio(draws, (d) => frontPrimeCompositeRatio(d.front)));
  renderRatioList($("#dist012"), groupByRatio(draws, (d) => frontPath012Ratio(d.front)));
  renderRatioList($("#distZone"), groupByRatio(draws, (d) => frontZoneRatio(d.front)));
  const acEntries = groupByRatio(draws, (d) => String(frontAcValue(d.front)))
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  renderRatioList($("#distAC"), acEntries, 8);
  renderRatioList($("#distBackOddEven"), groupByRatio(draws, (d) => backOddEvenRatio(d.back)));

  drawHistogram($("#chartSum"), draws.map((d) => frontSum(d.front)), FRONT_SUM_MIN, FRONT_SUM_MAX);
  drawHistogram($("#chartSpan"), draws.map((d) => frontSpan(d.front)), FRONT_SPAN_MIN, FRONT_SPAN_MAX);
  drawHistogram($("#chartBackSum"), draws.map((d) => backSum(d.back)), BACK_SUM_MIN, BACK_SUM_MAX);

  renderTimeSeriesPanel();
  renderCooccurrencePanel();
}

function renderTimeSeriesPanel() {
  const container = $("#tsChart");
  if (!container) return;
  const kind = $("#tsKind")?.value || "sum";
  const winSel = $("#tsWindow")?.value || "300";
  const ma = clamp(Number($("#tsMA")?.value || 30), 1, 200);
  const len = winSel === "all" ? state.draws.length : Math.min(state.draws.length, Number(winSel));
  const slice = state.draws.slice(-len);
  renderDltTimeSeries(container, slice, kind, { window: ma });
}

function renderCooccurrencePanel() {
  const container = $("#partnerList");
  const extreme = $("#extremePairs");
  if (!container || !extreme) return;
  if (!state.coMatrix) {
    state.coMatrix = buildDltCooccurrenceMatrix(state.draws);
  }
  const m = state.coMatrix;
  const num = clamp(Number($("#partnerNum")?.value || 6), 1, FRONT_SIZE);
  const k = clamp(Number($("#partnerK")?.value || 8), 3, FRONT_SIZE - 1);
  const partners = topDltPartners(m, num, k);
  container.innerHTML = "";
  for (const [n, count] of partners) {
    const lift = dltLiftOf(m, state.freqAllFront, state.draws.length, num, n);
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="ball front" style="width:26px;height:26px;font-size:11px;box-shadow:none">${pad2(n)}</span>
      <span class="muted" style="margin-left:auto; font-family:var(--mono); font-size:12px">
        ×&nbsp;<strong style="color:var(--text)">${count}</strong>
        &nbsp;·&nbsp; lift <strong style="color:${liftColor(lift)}">${lift.toFixed(2)}</strong>
      </span>
    `;
    container.appendChild(li);
  }

  const ex = extremeDltPairs(m, state.freqAllFront, state.draws.length, 8);
  extreme.innerHTML = "";
  for (const p of ex) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="ball front" style="width:24px;height:24px;font-size:10px;box-shadow:none">${pad2(p.a)}</span>
      <span class="ball front" style="width:24px;height:24px;font-size:10px;box-shadow:none">${pad2(p.b)}</span>
      <span class="muted" style="margin-left:auto; font-family:var(--mono); font-size:12px">
        ×&nbsp;${p.count} · lift <strong style="color:${liftColor(p.lift)}">${p.lift.toFixed(2)}</strong>
      </span>
    `;
    extreme.appendChild(li);
  }
}

function liftColor(lift) {
  const dev = Math.abs(lift - FRONT_INDEPENDENT_LIFT_BASELINE);
  if (dev < 0.05) return "var(--dlt-front)";
  if (dev < 0.15) return "var(--gold)";
  return "var(--red-2)";
}

function drawHistogram(container, values, min, max) {
  if (!container) return;
  const buckets = Array(max - min + 1).fill(0);
  for (const v of values) {
    if (v >= min && v <= max) buckets[v - min]++;
  }
  const arr = [0, ...buckets];
  renderDltBars(container, arr, buckets.length, "front", { unit: "期" });
}

function renderScience() {
  const fc = frontChi(state.draws);
  const bc = backChi(state.draws);
  const pF = chiSquaredPValue(fc.chi, fc.df);
  const pB = chiSquaredPValue(bc.chi, bc.df);

  $("#chiFront").textContent = fc.chi.toFixed(2);
  $("#pFront").textContent = formatP(pF);
  $("#rejectFront").innerHTML = verdictChip(pF);
  $("#chiBack").textContent = bc.chi.toFixed(2);
  $("#pBack").textContent = formatP(pB);
  $("#rejectBack").innerHTML = verdictChip(pB);

  const fRej = pF < 0.05, bRej = pB < 0.05;
  let verdict;
  if (!fRej && !bRej) {
    verdict = `前区 p=${formatP(pF)}、后区 p=${formatP(pB)}，两者都 <strong>显著大于 0.05</strong>。
      统计上没有证据拒绝"均匀分布"假设——换句话说，
      <strong>历史数据与"完全随机摇出"完全一致</strong>。
      "冷号热号"只是随机波动的自然产物，不构成下期的预测依据。`;
  } else if (fRej && !bRej) {
    verdict = `前区 p=${formatP(pF)} < 0.05，观察到显著偏差；后区 p=${formatP(pB)} 未显著。
      前区偏差可能来自摇奖设备物理不对称、样本量、或碰巧的极端情况。
      <strong>显著性 ≠ 可预测性</strong>，它只告诉你"均匀假设在此样本下成立/不成立"。`;
  } else {
    verdict = `前区 p=${formatP(pF)}、后区 p=${formatP(pB)}，存在显著偏差。
      这不代表"冷号会补"，更可能的解释是：摇奖装置的物理随机性不完美。
      即便如此，<strong>下一期仍然是独立同分布的随机抽取</strong>。`;
  }
  $("#scienceVerdict").innerHTML = verdict + "<br/><br/>"
    + `<em class="muted">样本：${state.draws.length} 期（${state.draws[0].issue} – ${state.draws[state.draws.length - 1].issue}）</em>`;

  renderIndependenceChecks();
}

function renderIndependenceChecks() {
  // 1) 前后区和值相关
  const corr = frontBackSumCorrelation(state.draws);
  const corrEl = $("#indCorr");
  if (corrEl) {
    const v = verdictFromP(Math.min(corr.pearsonP, corr.spearmanP));
    corrEl.innerHTML = `
      <div class="metric-line"><span>Pearson r</span><strong class="mono">${corr.pearson.toFixed(4)}</strong></div>
      <div class="metric-line"><span>Pearson p</span><strong class="mono">${formatP(corr.pearsonP)}</strong></div>
      <div class="metric-line"><span>Spearman ρ</span><strong class="mono">${corr.spearman.toFixed(4)}</strong></div>
      <div class="metric-line"><span>Spearman p</span><strong class="mono">${formatP(corr.spearmanP)}</strong></div>
      <div class="metric-line"><span>判语</span><strong>${verdictChipFromV(v)}</strong></div>
    `;
  }

  // 2) 奇偶比独立性卡方
  const odd = oddCountIndependenceTest(state.draws);
  const oddEl = $("#indOddChi");
  if (oddEl) {
    const v = verdictFromP(odd.p);
    oddEl.innerHTML = `
      <div class="metric-line"><span>χ²</span><strong class="mono">${odd.chi.toFixed(2)}</strong></div>
      <div class="metric-line"><span>df</span><strong class="mono">${odd.df}</strong></div>
      <div class="metric-line"><span>p 值</span><strong class="mono">${formatP(odd.p)}</strong></div>
      <div class="metric-line"><span>样本</span><strong class="mono">${odd.n}</strong></div>
      <div class="metric-line"><span>判语</span><strong>${verdictChipFromV(v)}</strong></div>
    `;
  }

  // 3) 35×12 lift 极端对
  const pairs = frontBackPairLift(state.draws, { topK: 8 });
  const pairsEl = $("#indPairs");
  if (pairsEl) {
    pairsEl.innerHTML = "";
    for (const e of pairs.extremes) {
      const li = document.createElement("li");
      const liftColor2 = Math.abs(e.deviation) < 0.05 ? "var(--dlt-front)"
        : Math.abs(e.deviation) < 0.15 ? "var(--gold)" : "var(--red-2)";
      li.innerHTML = `
        <span class="ball front" style="width:24px;height:24px;font-size:10px;box-shadow:none">${pad2(e.front)}</span>
        <span class="ball back" style="width:24px;height:24px;font-size:10px;box-shadow:none">${pad2(e.back)}</span>
        <span class="muted" style="margin-left:auto; font-family:var(--mono); font-size:12px">
          ×&nbsp;${e.count} · lift <strong style="color:${liftColor2}">${e.lift.toFixed(2)}</strong>
        </span>
      `;
      pairsEl.appendChild(li);
    }
  }
}

function verdictChipFromV(v) {
  if (!v.reject) return `<span class="chip chip-ok">${v.text}</span>`;
  if (v.severity === "weak") return `<span class="chip chip-warn">${v.text}</span>`;
  return `<span class="chip chip-warn" style="border-color:var(--red-2); color:var(--red-2)">${v.text}</span>`;
}

function formatP(p) {
  if (p < 0.0001) return "< 0.0001";
  return p.toFixed(4);
}

function verdictChip(p) {
  if (p < 0.05) return `<span class="chip chip-warn">拒绝（p&lt;0.05）</span>`;
  return `<span class="chip chip-ok">不拒绝（数据与均匀一致）</span>`;
}

function readDataLimit() {
  const value = $("#dataLimit")?.value || "50";
  return value === "all" ? Infinity : Number(value);
}

function limitDataRows(rows) {
  const limit = readDataLimit();
  const ordered = rows.slice().reverse();
  return Number.isFinite(limit) ? ordered.slice(0, limit) : ordered;
}

function filterDataRows(query) {
  const q = query.trim();
  if (!q) return state.draws;
  const qLower = q.toLowerCase();
  // 后区匹配："后 02"、"back 02"、"b 02"
  const backMatch = q.match(/(?:后|back|b)\s*0?(\d{1,2})/i);
  const back = backMatch ? Number(backMatch[1]) : null;
  const frontNums = backMatch ? [] : parseNumList(q, 1, FRONT_SIZE);

  return state.draws.filter((d) => {
    const textHit = String(d.issue).includes(q) || String(d.date || "").toLowerCase().includes(qLower);
    const frontHit = frontNums.length > 0 && frontNums.every((n) => d.front.includes(n));
    const backHit = back != null && d.back.includes(back);
    return textHit || frontHit || backHit;
  });
}

function renderDataTable() {
  const q = ($("#qIssue")?.value || "").trim();
  const rows = limitDataRows(filterDataRows(q));
  state.tableRows = rows;
  const scope = readDataLimit() === Infinity ? "全部" : `最近 ${readDataLimit()} 期`;
  const prefix = q ? `搜索 "${q}"` : scope;
  renderDltTable(rows, `${prefix}：显示 ${rows.length} 条；总数据 ${state.draws.length} 期（倒序）。`);
}

function exportCurrentCsv() {
  const rows = state.tableRows;
  const lines = [["issue", "date", "front", "back"].join(",")];
  for (const d of rows) {
    lines.push([
      d.issue, d.date || "",
      d.front.map(pad2).join(" "),
      d.back.map(pad2).join(" "),
    ].map((v) => `"${String(v).replaceAll('"', '""')}"`).join(","));
  }
  const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dlt-data-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function analyseManualTicket() {
  const front = parseNumList($("#manualFront")?.value, 1, FRONT_SIZE).sort((a, b) => a - b);
  const back = parseNumList($("#manualBack")?.value, 1, BACK_SIZE).sort((a, b) => a - b);
  if (front.length !== FRONT_PICK) {
    renderDltTicketAnalysis({ error: `前区需要 ${FRONT_PICK} 个不重复号码（当前 ${front.length} 个）` });
    return;
  }
  if (back.length !== BACK_PICK) {
    renderDltTicketAnalysis({ error: `后区需要 ${BACK_PICK} 个不重复号码（当前 ${back.length} 个）` });
    return;
  }

  const latest = state.draws[state.draws.length - 1];
  const fkey = front.join(",");
  const bkey = back.join(",");
  const historyHits = state.draws.filter((d) =>
    d.front.join(",") === fkey && d.back.join(",") === bkey);

  // 6 维深度诊断
  const diag = diagnoseTicket({ front, back }, state.draws);

  renderDltTicketAnalysis({
    front, back,
    sum: frontSum(front),
    span: frontSpan(front),
    oddEven: frontOddEvenRatio(front),
    bigSmall: frontBigSmallRatio(front),
    primeComposite: frontPrimeCompositeRatio(front),
    path012: frontPath012Ratio(front),
    zone: frontZoneRatio(front),
    ac: frontAcValue(front),
    consecutiveGroups: frontConsecutiveGroups(front),
    maxSameTail: frontMaxSameTail(front),
    backSum: backSum(back),
    backOddEven: backOddEvenRatio(back),
    repeatFront: latest ? front.filter((n) => latest.front.includes(n)) : [],
    repeatBack: latest ? back.filter((n) => latest.back.includes(n)) : [],
    historyHits,
    diagnosis: diag,
  });
}

function renderTools() {
  $("#btnCalcDanTuo")?.addEventListener("click", () => {
    try {
      const n = dltDanTuoTickets({
        danFront: Number($("#danFront")?.value || 0),
        tuoFront: Number($("#tuoFront")?.value || 6),
        danBack: Number($("#danBack")?.value || 0),
        tuoBack: Number($("#tuoBack")?.value || 3),
      });
      $("#danTuoResult").innerHTML =
        `<div><strong class="mono big-num">${n.toLocaleString()}</strong> 注</div>
         <div class="muted">合计 <strong class="mono">${dltPriceOf(n).toLocaleString()}</strong> 元</div>`;
    } catch (e) {
      $("#danTuoResult").innerHTML = `<span class="chip chip-warn">${e.message}</span>`;
    }
  });
  $("#btnCalcComplex")?.addEventListener("click", () => {
    try {
      const front = Number($("#complexFront")?.value || 6);
      const back = Number($("#complexBack")?.value || 3);
      const n = dltComplexTickets(front, back);
      $("#complexResult").innerHTML =
        `<div><strong class="mono big-num">${n.toLocaleString()}</strong> 注</div>
         <div class="muted">合计 <strong class="mono">${dltPriceOf(n).toLocaleString()}</strong> 元</div>`;
    } catch (e) {
      $("#complexResult").innerHTML = `<span class="chip chip-warn">${e.message}</span>`;
    }
  });
  $("#btnAnalyseTicket")?.addEventListener("click", analyseManualTicket);
  $("#manualFront")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") analyseManualTicket();
  });
  $("#manualBack")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") analyseManualTicket();
  });

  const ref = $("#refTable");
  if (ref) {
    ref.innerHTML = "";
    // 单后区 (2) 复式：选 N 个前区
    for (const n of [5, 6, 7, 8, 9, 10, 12, 15]) {
      const tickets = combinations(n, 5) * combinations(2, 2);
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="mono">${n}</td><td class="mono">${tickets.toLocaleString()}</td><td class="mono">${dltPriceOf(tickets).toLocaleString()}</td>`;
      ref.appendChild(tr);
    }
  }
}

function onGenerate() {
  const recent = state.draws.slice(-state.winSize);
  const freqFront = zoneFreq(recent, FRONT_ZONE);
  const freqBack = zoneFreq(recent, BACK_ZONE);
  const cfg = readDltGeneratorConfig();
  const lastDraw = state.draws[state.draws.length - 1];
  const avoidLastFront = cfg.avoidLast && lastDraw ? lastDraw.front : [];
  const avoidLastBack = cfg.avoidLast && lastDraw ? lastDraw.back : [];
  const engine = $("#engine")?.value || "bayes-dpp";
  const seed = $("#seedInput")?.value?.trim() || null;

  try {
    if (engine === "legacy") {
      runLegacyGenerator({ freqFront, freqBack, cfg, avoidLastFront, avoidLastBack });
    } else {
      runAdvancedGenerator({
        freqFront, freqBack,
        totalDraws: recent.length,
        cfg, avoidLastFront, avoidLastBack, engine, seed,
      });
    }
  } catch (e) {
    state.lastTickets = [];
    const btn = $("#btnCopyAll");
    if (btn) btn.disabled = true;
    showDltGenError(e.message || String(e));
    setDltGenDiagnostics("");
    renderDltSamplerDiagnostics(null);
  }
}

function runLegacyGenerator({ freqFront, freqBack, cfg, avoidLastFront, avoidLastBack }) {
  const result = generateDltTickets({
    freqFront, freqBack,
    strategyFront: cfg.strategyFront,
    strategyBack: cfg.strategyBack,
    alpha: cfg.alpha,
    constraints: cfg.constraints,
    count: cfg.count,
    optimize: cfg.optimize,
    includeFront: cfg.includeFront,
    excludeFront: cfg.excludeFront,
    avoidLastFront,
    includeBack: cfg.includeBack,
    excludeBack: cfg.excludeBack,
    avoidLastBack,
  });
  state.lastTickets = result.tickets;
  renderDltTickets(result.tickets, { tries: result.tries, failureReasons: result.failureReasons });
  $("#btnCopyAll").disabled = result.tickets.length === 0;
  const parsed = [
    cfg.includeFront.length ? `前胆 ${cfg.includeFront.length}` : "",
    cfg.includeBack.length ? `后胆 ${cfg.includeBack.length}` : "",
    cfg.excludeFront.length ? `排前 ${cfg.excludeFront.length}` : "",
    cfg.excludeBack.length ? `排后 ${cfg.excludeBack.length}` : "",
    cfg.optimize === "diverse" ? "低撞号/分散覆盖已启用" : "",
  ].filter(Boolean).join(" · ");
  setDltGenDiagnostics(
    `经典引擎 · 已生成 ${result.tickets.length}/${cfg.count} 注 · ${dltPriceOf(result.tickets.length)} 元 · 尝试 ${result.tries} 次` +
    (parsed ? ` · ${parsed}` : "") +
    (avoidLastFront.length ? ` · 已避开上一期 ${avoidLastFront.length} 个前区` : "")
  );
  renderDltSamplerDiagnostics(null);
}

function runAdvancedGenerator({
  freqFront, freqBack, totalDraws, cfg, avoidLastFront, avoidLastBack, engine, seed,
}) {
  const result = generateDltAdvanced({
    freqFront, freqBack, totalDraws,
    method: engine,
    count: cfg.count,
    constraints: cfg.constraints,
    includeFront: cfg.includeFront,
    excludeFront: cfg.excludeFront,
    avoidLastFront,
    includeBack: cfg.includeBack,
    excludeBack: cfg.excludeBack,
    avoidLastBack,
    seed,
  });
  state.lastTickets = result.tickets;
  renderDltTickets(result.tickets, {
    tries: result.diagnostics.tries || 0,
    failureReasons: result.diagnostics.failureReasons || {},
  });
  $("#btnCopyAll").disabled = result.tickets.length === 0;
  setDltGenDiagnostics(
    `${result.diagnostics.samplerLabel || engine} · 已生成 ${result.tickets.length}/${cfg.count} 注 · ${dltPriceOf(result.tickets.length)} 元`
  );
  renderDltSamplerDiagnostics(result.diagnostics, DLT_CONFIG.jackpotProbability);
}

async function onCopyAll() {
  if (!state.lastTickets.length) return;
  await copyToClipboard(state.lastTickets.map(formatDltTicketLine).join("\n"));
  const btn = $("#btnCopyAll");
  const original = btn.textContent;
  btn.textContent = "已复制";
  setTimeout(() => (btn.textContent = original), 1200);
  toast(`已复制 ${state.lastTickets.length} 注到剪贴板`);
}

function onRunBacktest() {
  const btn = $("#btnRunBacktest");
  const originalText = btn?.textContent || "运行回测";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "回测中...";
  }
  window.setTimeout(() => {
    try {
      const cfg = readDltBacktestConfig();
      const result = runDltBacktest(state.draws, cfg);
      renderDltBacktestResult(result);
      toast(`回测完成：${result.summary.rounds} 期 / ${result.summary.totalTickets} 注`);
    } catch (e) {
      renderDltBacktestResult(null);
      toast(`回测失败：${e.message || e}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  }, 20);
}

function onSearch() { renderDataTable(); }

async function onRefresh() {
  setRefreshLoading(true);
  try {
    const { meta, draws } = await loadDltDraws({ noCache: true });
    state.meta = meta;
    state.draws = draws;
    state.winSize = readDltWinSize();
    computeStats();
    renderAll();
    updateDltLstmDraws(draws);
    toast(`已刷新：${draws.length} 期`);
  } catch (err) {
    toast(`刷新失败：${err.message || err}`);
  } finally {
    setRefreshLoading(false);
  }
}

function renderAll() {
  renderOverviewAndInsight();
  renderTrendPanel();
  renderDistributionPanel();
  renderScience();
}

function bindInteractions() {
  $("#btnApplyWin")?.addEventListener("click", () => {
    state.winSize = clamp(Number($("#winSize")?.value || 200), 20, 1000);
    computeStats();
    renderAll();
  });
  $("#trendWindow")?.addEventListener("change", renderTrendPanel);
  $("#trendShowStats")?.addEventListener("change", renderTrendPanel);
  $("#tsKind")?.addEventListener("change", renderTimeSeriesPanel);
  $("#tsWindow")?.addEventListener("change", renderTimeSeriesPanel);
  $("#tsMA")?.addEventListener("input", renderTimeSeriesPanel);
  $("#btnPartner")?.addEventListener("click", renderCooccurrencePanel);
  $("#partnerNum")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") renderCooccurrencePanel();
  });
  $("#btnGen")?.addEventListener("click", onGenerate);
  $("#btnCopyAll")?.addEventListener("click", onCopyAll);
  $("#btnRunBacktest")?.addEventListener("click", onRunBacktest);
  $("#btnSearch")?.addEventListener("click", onSearch);
  $("#qIssue")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onSearch();
  });
  $("#dataLimit")?.addEventListener("change", renderDataTable);
  $("#btnClear")?.addEventListener("click", () => {
    $("#qIssue").value = "";
    renderDataTable();
  });
  $("#btnExportCsv")?.addEventListener("click", () => {
    exportCurrentCsv();
    toast("已导出 CSV");
  });
  $("#btnRefresh")?.addEventListener("click", onRefresh);

  // 奖级 EV 面板
  $("#prizeBand")?.addEventListener("change", renderPrizePanel);
  $("#prizeTickets")?.addEventListener("input", renderPrizePanel);

  // 追号风险
  $("#btnChaseRun")?.addEventListener("click", onRunChase);

  document.addEventListener("ssq:theme", () => {
    renderAll();
  });

  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      requestAnimationFrame(() => {
        const name = t.dataset.tab;
        if (name === "overview") {
          renderDltBars($("#chartFrontAll"), state.freqAllFront, FRONT_SIZE, "front");
          renderDltBars($("#chartBackAll"), state.freqAllBack, BACK_SIZE, "back");
        } else if (name === "insight") {
          renderDltBars($("#chartFrontMiss"), state.missFront, FRONT_SIZE, "front-miss", { unit: "期" });
          renderDltBars($("#chartBackMiss"), state.missBack, BACK_SIZE, "back-miss", { unit: "期" });
        } else if (name === "distribution") {
          renderDistributionPanel();
        } else if (name === "trend") {
          renderTrendPanel();
        } else if (name === "prize") {
          renderPrizePanel();
        }
      });
    });
  });

  window.addEventListener("resize", debounceResize);
  renderTools();
}

let resizeTimer = null;
function debounceResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderDltBars($("#chartFrontAll"), state.freqAllFront, FRONT_SIZE, "front");
    renderDltBars($("#chartBackAll"), state.freqAllBack, BACK_SIZE, "back");
    renderDltBars($("#chartFrontMiss"), state.missFront, FRONT_SIZE, "front-miss", { unit: "期" });
    renderDltBars($("#chartBackMiss"), state.missBack, BACK_SIZE, "back-miss", { unit: "期" });
  }, 160);
}

async function main() {
  document.body.dataset.lottery = "dlt";
  setupTabs();
  setupTheme();
  try {
    const { meta, draws, source, fetchError } = await loadDltDraws();
    if (!draws.length) throw new Error("数据为空");
    state.meta = meta;
    state.draws = draws;
    state.winSize = readDltWinSize();
    computeStats();
    renderAll();
    bindInteractions();
    setupDltLstmController(state.draws);
    renderBettingPanel({ container: document.querySelector("#rationalBettingBody"), lottery: "dlt" });
    renderPrizePanel();
    showDltDataSourceBanner(source, fetchError);
    startCountdown();
  } catch (err) {
    showLoadError(String(err.message || err));
  }
}

/* ============================================================
 * 奖级 / EV 面板
 * ============================================================ */
function renderPrizePanel() {
  const band = $("#prizeBand")?.value || "expected";
  const tickets = clamp(Number($("#prizeTickets")?.value || 100), 1, 10000);

  const erBase = expectedReturn({ band, mode: "base" });
  const erAdd = expectedReturn({ band, mode: "add" });
  const edge = additionalBetEdge(band);

  // KPI 对比
  const kpiEl = $("#prizeKpiCompare");
  if (kpiEl) {
    const kpis = [
      { label: "基本投注 EV", val: `${erBase.ev.toFixed(3)} 元`, color: "var(--text)" },
      { label: "基本 payback", val: `${(erBase.evPerYuan * 100).toFixed(1)}%`,
        color: erBase.evPerYuan > 0.5 ? "var(--gold)" : "var(--red-2)" },
      { label: "追加投注 EV", val: `${erAdd.ev.toFixed(3)} 元`, color: "var(--text)" },
      { label: "追加 payback", val: `${(erAdd.evPerYuan * 100).toFixed(1)}%`,
        color: erAdd.evPerYuan > 0.5 ? "var(--gold)" : "var(--red-2)" },
      { label: "追加 1 元增量 EV", val: `${edge.edge.toFixed(3)} 元`,
        color: edge.edge > 0 ? "var(--dlt-front)" : "var(--red-2)" },
      { label: "追加是否更划算", val: edge.edge > 0 ? "✅ 是" : "❌ 否",
        color: edge.edge > 0 ? "var(--dlt-front)" : "var(--red-2)" },
    ];
    kpiEl.innerHTML = kpis.map((k) => `
      <div class="bt-kpi">
        <span>${k.label}</span>
        <strong style="color:${k.color}">${k.val}</strong>
      </div>
    `).join("");
  }

  // 9 奖级表
  const tbody = $("#prizeTable")?.querySelector("tbody");
  if (tbody) {
    const items = withPrizeProbabilities();
    tbody.innerHTML = items.map((it) => {
      const basePrize = it.type === "fixed" ? it.fixedPrize : it.estimateBands[band];
      const addPrize = it.addBonusEnabled ? basePrize * (1 + 0.8) : basePrize;
      const contribution = it.probability * basePrize;
      const hits = it.hits.map((h) => `${h.f}+${h.b}`).join(" / ");
      return `
        <tr>
          <td><strong>${it.label}</strong></td>
          <td class="mono">${hits}</td>
          <td class="mono">${(it.probability * 100).toExponential(2)}%</td>
          <td class="mono">${Math.round(1 / it.probability).toLocaleString()}</td>
          <td class="mono">${formatPrize(basePrize)}</td>
          <td class="mono">${it.addBonusEnabled ? formatPrize(addPrize) : "—"}</td>
          <td class="mono">${contribution.toFixed(4)} 元</td>
        </tr>
      `;
    }).join("");
  }

  // 追加增量明细
  const addEl = $("#prizeAddEdge");
  if (addEl) {
    const lines = edge.detail.map((d) => `
      <div class="diag-line">
        <span>${d.label} (${(d.probability * 100).toExponential(2)}%)</span>
        <strong class="mono">基 ${formatPrize(d.baseBonus)} → 追加加成 +${formatPrize(d.addBonus)}</strong>
      </div>
    `).join("");
    addEl.innerHTML = `
      ${lines}
      <div class="diag-line" style="border-top:1px solid var(--stroke); margin-top:8px; padding-top:8px">
        <span><strong>累计增量收益</strong></span>
        <strong class="mono" style="color:${edge.edge > 0 ? "var(--dlt-front)" : "var(--red-2)"}">${edge.extraGain.toFixed(3)} 元</strong>
      </div>
      <div class="diag-line">
        <span>额外成本</span>
        <strong class="mono">1.000 元</strong>
      </div>
      <div class="diag-line">
        <span><strong>追加 edge</strong></span>
        <strong class="mono" style="color:${edge.edge > 0 ? "var(--dlt-front)" : "var(--red-2)"}">${edge.edge.toFixed(3)} 元</strong>
      </div>
    `;
  }

  // 总成本 / 总 EV
  const batchEl = $("#prizeBatchSummary");
  if (batchEl) {
    const baseBatch = ticketsExpectedReturn(tickets, { band, mode: "base" });
    const addBatch = ticketsExpectedReturn(tickets, { band, mode: "add" });
    const beBase = breakevenJackpot({ band, mode: "base" });
    const beAdd = breakevenJackpot({ band, mode: "add" });
    const beStr = (b) => b.breakevenJackpot != null
      ? `${(b.breakevenJackpot / 100000000).toFixed(2)} 亿`
      : "数学上不可能";
    batchEl.innerHTML = `
      <div class="diag-line"><span>注数</span><strong class="mono">${tickets}</strong></div>
      <div class="diag-line"><span>基本投注总成本</span><strong class="mono">${baseBatch.totalCost.toFixed(0)} 元</strong></div>
      <div class="diag-line"><span>基本投注总 EV</span><strong class="mono">${baseBatch.totalEv.toFixed(2)} 元</strong></div>
      <div class="diag-line"><span>基本投注期望净收益</span><strong class="mono" style="color:${baseBatch.totalNetEv >= 0 ? "var(--dlt-front)" : "var(--red-2)"}">${baseBatch.totalNetEv.toFixed(2)} 元</strong></div>
      <div class="diag-line" style="border-top:1px solid var(--stroke); margin-top:8px; padding-top:8px"><span>追加投注总成本</span><strong class="mono">${addBatch.totalCost.toFixed(0)} 元</strong></div>
      <div class="diag-line"><span>追加投注总 EV</span><strong class="mono">${addBatch.totalEv.toFixed(2)} 元</strong></div>
      <div class="diag-line"><span>追加投注期望净收益</span><strong class="mono" style="color:${addBatch.totalNetEv >= 0 ? "var(--dlt-front)" : "var(--red-2)"}">${addBatch.totalNetEv.toFixed(2)} 元</strong></div>
      <div class="diag-line" style="border-top:1px solid var(--stroke); margin-top:8px; padding-top:8px"><span>盈亏平衡所需一等奖（基本）</span><strong class="mono" style="color:var(--gold)">≥ ${beStr(beBase)}</strong></div>
      <div class="diag-line"><span>盈亏平衡所需一等奖（追加）</span><strong class="mono" style="color:var(--gold)">≥ ${beStr(beAdd)}</strong></div>
    `;
  }
}

function formatPrize(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(2)} 万`;
  return `${n.toFixed(0)} 元`;
}

/* ============================================================
 * 追号风险蒙特卡洛
 * ============================================================ */
function onRunChase() {
  const btn = $("#btnChaseRun");
  if (btn) { btn.disabled = true; btn.textContent = "模拟中..."; }
  setTimeout(() => {
    try {
      const result = simulateChase({
        runs: clamp(Number($("#chaseRuns")?.value || 2000), 200, 5000),
        draws: clamp(Number($("#chaseDraws")?.value || 50), 5, 200),
        ticketsPerDraw: clamp(Number($("#chaseTickets")?.value || 2), 1, 20),
        bankroll: clamp(Number($("#chaseBankroll")?.value || 2000), 20, 1000000),
        strategy: $("#chaseStrategy")?.value || "flat",
        prizeBand: $("#chasePrizeBand")?.value || "expected",
        seed: $("#chaseSeed")?.value || "chase",
      });
      renderChaseResult(result);
      toast(`模拟完成：${result.runs} 次`);
    } catch (e) {
      toast(`模拟失败：${e.message || e}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "运行 2000 次蒙特卡洛"; }
    }
  }, 20);
}

function renderChaseResult(r) {
  // KPI
  const kpiEl = $("#chaseSummary");
  if (kpiEl) {
    const ruinColor = r.ruinProb > 0.3 ? "var(--red-2)" : r.ruinProb > 0.1 ? "var(--gold)" : "var(--dlt-front)";
    const finalColor = r.finalMean >= r.bankroll ? "var(--dlt-front)" : "var(--red-2)";
    const kpis = [
      { label: "模拟次数", val: r.runs },
      { label: "破产概率", val: `${(r.ruinProb * 100).toFixed(1)}%`, color: ruinColor },
      { label: "终值均值", val: `${r.finalMean.toFixed(0)} 元`, color: finalColor },
      { label: "终值中位数", val: `${r.finalMedian.toFixed(0)} 元` },
      { label: "终值 5% 分位", val: `${r.finalP05.toFixed(0)} 元`, color: "var(--red-2)" },
      { label: "终值 95% 分位", val: `${r.finalP95.toFixed(0)} 元`, color: "var(--dlt-front)" },
      { label: "曾中过一等奖", val: `${(r.everJackpotProb * 100).toFixed(2)}%`,
        color: r.everJackpotProb > 0 ? "var(--gold)" : "var(--muted)" },
      { label: "曾中过二等奖", val: `${(r.everSecondProb * 100).toFixed(2)}%`,
        color: r.everSecondProb > 0 ? "var(--gold)" : "var(--muted)" },
    ];
    kpiEl.innerHTML = kpis.map((k) => `
      <div class="bt-kpi">
        <span>${k.label}</span>
        <strong style="color:${k.color || "var(--text)"}">${k.val}</strong>
      </div>
    `).join("");
  }

  // 资金曲线
  const chartEl = $("#chaseChart");
  if (chartEl) chartEl.innerHTML = renderChaseTrajectories(r);

  // 终值直方图
  const distEl = $("#chaseFinalDist");
  if (distEl) distEl.innerHTML = renderFinalHistogram(r);

  // 理性思考
  const verdictEl = $("#chaseVerdict");
  if (verdictEl) {
    const expectedLossPerYuan = (r.bankroll - r.finalMean) / (r.draws * r.ticketsPerDraw * 2);
    verdictEl.innerHTML = `
      <div class="callout-title">数学事实</div>
      <div class="callout-body">
        在 ${r.runs} 次独立模拟里：
        <ul style="margin-top:6px; padding-left:18px">
          <li>有 <strong style="color:var(--red-2)">${(r.ruinProb * 100).toFixed(1)}%</strong> 的人在第 ${r.draws} 期前就<strong>破产</strong>。</li>
          <li>账户余额最终的<strong>中位数</strong>是 <strong class="mono">${r.finalMedian.toFixed(0)} 元</strong>（初始 ${r.bankroll} 元）。</li>
          <li>每花 1 元下注，<strong>平均回收</strong> ${expectedLossPerYuan >= 0 ? "+" : ""}${(2 - expectedLossPerYuan * 2).toFixed(2)} 元（payback ratio ${((2 - expectedLossPerYuan * 2) / 2 * 100).toFixed(1)}%）。</li>
          <li>有 <strong>${(r.everJackpotProb * 100).toFixed(2)}%</strong> 的人在 ${r.draws} 期里中过一等奖。意味着 <strong>${Math.round(1 / Math.max(1e-6, r.everJackpotProb)).toLocaleString()} 个像你这样追号的人里才有 1 个</strong> 中一等。</li>
        </ul>
        <div style="margin-top:12px"><strong>结论：</strong>追号不能改变中奖概率，只能改变破产时间。<strong>"补到中"是赌徒谬误</strong>——大乐透每期独立。请理性消费、量力而行。</div>
      </div>
    `;
  }
}

function renderChaseTrajectories(r) {
  const W = 800, H = 220;
  const padL = 50, padR = 12, padT = 10, padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  if (!r.trajectories.length) return "";
  // 找全局最大值
  let maxBk = r.bankroll;
  for (const path of r.trajectories) for (const v of path) if (v > maxBk) maxBk = v;
  const yScale = (v) => padT + innerH - (Math.max(0, v) / maxBk) * innerH;
  const xScale = (i, len) => padL + (i / Math.max(1, len - 1)) * innerW;

  const lines = r.trajectories.map((path) => {
    const ruined = path[path.length - 1] === 0 || path.length < r.draws + 1;
    const color = ruined ? "rgba(255,80,80,0.45)" : "rgba(93,217,184,0.55)";
    const pts = path.map((v, i) => `${xScale(i, r.draws + 1).toFixed(1)},${yScale(v).toFixed(1)}`).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1" stroke-linecap="round"/>`;
  }).join("");

  // baseline = 初始资金
  const baselineY = yScale(r.bankroll);
  const baseline = `<line x1="${padL}" x2="${padL + innerW}" y1="${baselineY}" y2="${baselineY}" stroke="rgba(255,255,255,.35)" stroke-dasharray="4 4"/>`;
  const baselineLabel = `<text x="${padL + 4}" y="${baselineY - 4}" font-size="10" fill="rgba(255,255,255,.55)" font-family="JetBrains Mono, monospace">初始本金 ${r.bankroll}</text>`;

  // y 轴刻度
  const ticks = [0, 0.5, 1].map((p) => {
    const v = maxBk * p;
    const y = padT + innerH - p * innerH;
    return `<text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="rgba(255,255,255,.5)" font-family="JetBrains Mono, monospace">${v.toFixed(0)}</text>`;
  }).join("");

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
    <line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${padT + innerH}" stroke="rgba(255,255,255,.25)"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="rgba(255,255,255,.25)"/>
    ${baseline}${baselineLabel}${ticks}${lines}
    <text x="${padL + innerW / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,.55)" font-family="JetBrains Mono, monospace">期数 0 → ${r.draws}</text>
  </svg>`;
}

function renderFinalHistogram(r) {
  const W = 800, H = 200;
  const padL = 50, padR = 12, padT = 12, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const data = r.finalBankroll;
  if (!data.length) return "";
  const minV = Math.min(...data);
  const maxV = Math.max(...data);
  const bins = 40;
  const range = maxV - minV || 1;
  const counts = Array(bins).fill(0);
  for (const v of data) {
    let b = Math.floor((v - minV) / range * bins);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    counts[b]++;
  }
  const maxCount = Math.max(...counts);
  const barW = innerW / bins;
  const bars = counts.map((c, i) => {
    const x = padL + i * barW;
    const h = (c / Math.max(1, maxCount)) * innerH;
    const y = padT + innerH - h;
    const binV = minV + (i + 0.5) * range / bins;
    const color = binV >= r.bankroll ? "var(--dlt-front)" : "var(--red-2)";
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="0.65"/>`;
  }).join("");
  // baseline
  const baseRatio = (r.bankroll - minV) / range;
  const baseX = padL + Math.max(0, Math.min(1, baseRatio)) * innerW;
  const baseLine = `<line x1="${baseX}" y1="${padT}" x2="${baseX}" y2="${padT + innerH}" stroke="rgba(255,255,255,.7)" stroke-dasharray="3 3"/>
    <text x="${baseX + 4}" y="${padT + 12}" font-size="10" fill="rgba(255,255,255,.7)" font-family="JetBrains Mono, monospace">初始 ${r.bankroll}</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
    <line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${padT + innerH}" stroke="rgba(255,255,255,.25)"/>
    ${bars}${baseLine}
    <text x="${padL}" y="${H - 8}" text-anchor="start" font-size="10" fill="rgba(255,255,255,.55)" font-family="JetBrains Mono, monospace">${minV.toFixed(0)}</text>
    <text x="${padL + innerW}" y="${H - 8}" text-anchor="end" font-size="10" fill="rgba(255,255,255,.55)" font-family="JetBrains Mono, monospace">${maxV.toFixed(0)}</text>
  </svg>`;
}

let countdownTimer = null;
function startCountdown() {
  const tick = () => {
    const now = new Date();
    const target = nextDltDrawTime(now);
    if (!target) return;
    const diff = diffDuration(target, now);
    const setText = (id, v) => {
      const el = $(id);
      if (el) el.textContent = String(v).padStart(2, "0");
    };
    setText("#cdDays", diff.days);
    setText("#cdHours", diff.hours);
    setText("#cdMinutes", diff.minutes);
    setText("#cdSeconds", diff.seconds);

    const cutoff = dltSaleCutoffOf(target);
    const beforeCutoff = now.getTime() < cutoff.getTime();
    const latest = state.draws[state.draws.length - 1];
    const nextIssue = latest ? nextDltIssueOf(latest.issue, target) : null;
    const labelEl = $("#countdownLabel");
    if (labelEl) labelEl.textContent = nextIssue ? `第 ${nextIssue} 期` : "下期";

    const metaEl = $("#countdownMeta");
    if (metaEl) {
      metaEl.innerHTML = `开奖时间：<strong class="mono">${formatChinaTime(target)}</strong> · ${
        beforeCutoff
          ? `投注截止：<strong class="mono">${formatChinaTime(cutoff).slice(11)}</strong>`
          : `<span style="color:var(--gold)">本期投注已截止，等待开奖</span>`
      }`;
    }
  };
  tick();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(tick, 1000);
}

window.addEventListener("DOMContentLoaded", main);
