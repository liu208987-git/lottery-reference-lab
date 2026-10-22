import { $, $$, clamp, pad2, parseNumList } from "./utils.js";
import { loadDraws } from "./data.js";
import {
  freqFromDraws,
  missCounts,
  topN,
  sumOf,
  spanOf,
  RED_MAX,
  BLUE_MAX,
} from "./stats.js";
import { renderBars } from "./chart.js";
import { renderTrend } from "./trend-chart.js";
import { generateTickets } from "./generator.js";
import { generateAdvanced } from "./advanced-sampler.js";
import { setupLstmController, updateLstmDraws } from "./lstm-controller.js";
import { renderBettingPanel } from "./rational-betting-ui.js";
import {
  renderSsqPrizePanel, setupSsqChasePanel, setupSsqBacktestPanel,
} from "./ssq-betting-ui.js";
import {
  oddEvenRatio,
  bigSmallRatio,
  primeCompositeRatio,
  path012Ratio,
  zoneRatio,
  acValue,
  consecutiveGroups,
  maxSameTail,
  groupBy,
  histogram,
} from "./distribution.js";
import { redChi, blueChi, chiSquaredPValue } from "./chi-square.js";
import { danTuoTickets, complexTickets, combinations, priceOf } from "./combinatorics.js";
import { analyzeDantuo, analyzeComplex, singleTicketAnalysis } from "./dantuo-prize.js";
import { buildTrendMatrix } from "./trend.js";
import { missStats, missStatsWithSignificance } from "./miss-stats.js";
import {
  buildCooccurrenceMatrix,
  topPartners,
  liftOf,
  extremePairs,
  INDEPENDENT_LIFT_BASELINE,
} from "./cooccurrence.js";
import { renderTimeSeries } from "./timeseries.js";
import {
  nextDrawTime,
  saleCutoffOf,
  diffDuration,
  formatChinaTime,
  nextIssueOf,
} from "./countdown.js";
import {
  setupTabs,
  setupTheme,
  renderLatest,
  renderHeroMeta,
  renderRank,
  renderTable,
  renderInsightChips,
  renderTickets,
  formatTicketLine,
  copyToClipboard,
  renderTicketAnalysis,
  showLoadError,
  showDataSourceBanner,
  setRefreshLoading,
  readWinSize,
  readGeneratorConfig,
  showGenError,
  setGenDiagnostics,
  toast,
} from "./ui.js";

const state = {
  meta: {},
  draws: [],
  winSize: 200,
  freqAllRed: null,
  freqAllBlue: null,
  freqRecentRed: null,
  freqRecentBlue: null,
  missRed: null,
  missBlue: null,
  tableRows: [],
  lastTickets: [],
};

function computeStats() {
  state.freqAllRed = freqFromDraws(state.draws, "reds", RED_MAX);
  state.freqAllBlue = freqFromDraws(state.draws, "blue", BLUE_MAX);
  const recent = state.draws.slice(-state.winSize);
  state.freqRecentRed = freqFromDraws(recent, "reds", RED_MAX);
  state.freqRecentBlue = freqFromDraws(recent, "blue", BLUE_MAX);
  state.missRed = missCounts(state.draws, "reds", RED_MAX);
  state.missBlue = missCounts(state.draws, "blue", BLUE_MAX);
  // χ² 显著性检验：找统计上"严格异常"的号码（Bonferroni 修正）
  state.chiSquareRed = missStatsWithSignificance(state.draws, RED_MAX, 6, "reds");
  state.chiSquareBlue = missStatsWithSignificance(state.draws, BLUE_MAX, 1, "blue");
}

function renderOverviewAndInsight() {
  const latest = state.draws[state.draws.length - 1];
  renderHeroMeta(state.meta, state.draws);
  renderLatest(latest);

  renderBars($("#chartRedAll"), state.freqAllRed, RED_MAX, "red");
  renderBars($("#chartBlueAll"), state.freqAllBlue, BLUE_MAX, "blue");
  renderRank($("#rankRedRecent"), topN(state.freqRecentRed, 8, RED_MAX));
  renderRank($("#rankBlueRecent"), topN(state.freqRecentBlue, 6, BLUE_MAX));

  renderBars($("#chartRedMiss"), state.missRed, RED_MAX, "miss", { unit: "期" });
  renderBars($("#chartBlueMiss"), state.missBlue, BLUE_MAX, "miss", { unit: "期" });
  renderInsightChips(state);

  renderDataTable();
}

function renderTrendPanel() {
  const win = Number($("#trendWindow").value || 50);
  const showStats = $("#trendShowStats")?.checked !== false;
  const rows = buildTrendMatrix(state.draws, win);
  // 统计是基于全量数据还是当前窗口？业界惯例是基于当前可视范围。
  const windowedDraws = state.draws.slice(-win);
  const redStats = showStats ? missStats(windowedDraws, RED_MAX, "reds") : null;
  const blueStats = showStats ? missStats(windowedDraws, BLUE_MAX, "blue") : null;
  renderTrend($("#trendRed"), rows, { size: RED_MAX, kind: "red", stats: redStats });
  renderTrend($("#trendBlue"), rows, { size: BLUE_MAX, kind: "blue", stats: blueStats });
}

function renderRatioList(el, entries, top = 8) {
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
    // 下一帧再设置真实宽度，触发 CSS 过渡
    requestAnimationFrame(() => {
      const fill = li.querySelector(".ratio-bar i");
      if (fill) fill.style.width = `${w}%`;
    });
  }
}

function renderDistributionPanel() {
  const draws = state.draws;
  renderRatioList($("#distOddEven"), groupBy(draws, (r) => oddEvenRatio(r)));
  renderRatioList($("#distBigSmall"), groupBy(draws, (r) => bigSmallRatio(r)));
  renderRatioList($("#distPrime"), groupBy(draws, (r) => primeCompositeRatio(r)));
  renderRatioList($("#dist012"), groupBy(draws, (r) => path012Ratio(r)));
  renderRatioList($("#distZone"), groupBy(draws, (r) => zoneRatio(r)));
  const acEntries = groupBy(draws, (r) => String(acValue(r)))
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  renderRatioList($("#distAC"), acEntries, 11);

  // 和值分布直方图：用现有 renderBars 需要定长数组，转成 [0..N] 形式
  const sums = draws.map((d) => sumOf(d.reds));
  const spans = draws.map((d) => spanOf(d.reds));
  drawHistogram($("#chartSum"), sums, 21, 183);
  drawHistogram($("#chartSpan"), spans, 5, 32);

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
  renderTimeSeries(container, slice, kind, { window: ma });
}

function renderCooccurrencePanel() {
  const container = $("#partnerList");
  const extreme = $("#extremePairs");
  if (!container || !extreme) return;
  if (!state.coMatrix) {
    state.coMatrix = buildCooccurrenceMatrix(state.draws);
  }
  const m = state.coMatrix;
  const num = clamp(Number($("#partnerNum")?.value || 6), 1, 33);
  const k = clamp(Number($("#partnerK")?.value || 8), 3, 32);
  const partners = topPartners(m, num, k);
  container.innerHTML = "";
  for (const [n, count] of partners) {
    const lift = liftOf(m, state.freqAllRed, state.draws.length, num, n);
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="ball red" style="width:26px;height:26px;font-size:11px;box-shadow:none">${pad2(n)}</span>
      <span class="muted" style="margin-left:auto; font-family:var(--mono); font-size:12px">
        ×&nbsp;<strong style="color:var(--text)">${count}</strong>
        &nbsp;·&nbsp; lift <strong style="color:${liftColor(lift)}">${lift.toFixed(2)}</strong>
      </span>
    `;
    container.appendChild(li);
  }

  // 极端对
  const ex = extremePairs(m, state.freqAllRed, state.draws.length, 8);
  extreme.innerHTML = "";
  for (const p of ex) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="ball red" style="width:24px;height:24px;font-size:10px;box-shadow:none">${pad2(p.a)}</span>
      <span class="ball red" style="width:24px;height:24px;font-size:10px;box-shadow:none">${pad2(p.b)}</span>
      <span class="muted" style="margin-left:auto; font-family:var(--mono); font-size:12px">
        ×&nbsp;${p.count} · lift <strong style="color:${liftColor(p.lift)}">${p.lift.toFixed(2)}</strong>
      </span>
    `;
    extreme.appendChild(li);
  }
}

function liftColor(lift) {
  // 接近独立基线（≈0.86）= 中性；偏离越远越黄
  const base = INDEPENDENT_LIFT_BASELINE;
  const dev = Math.abs(lift - base);
  if (dev < 0.05) return "var(--acid)";
  if (dev < 0.15) return "var(--gold)";
  return "var(--red-2)";
}

function drawHistogram(container, values, min, max) {
  const buckets = Array(max - min + 1).fill(0);
  for (const v of values) {
    if (v >= min && v <= max) buckets[v - min]++;
  }
  // 用一个"伪 1-indexed"数组喂给 renderBars（它忽略 index 0）
  const arr = [0, ...buckets];
  renderBars(container, arr, buckets.length, "red", { unit: "期" });
}

function renderScience() {
  const rc = redChi(state.draws);
  const bc = blueChi(state.draws);
  const pR = chiSquaredPValue(rc.chi, rc.df);
  const pB = chiSquaredPValue(bc.chi, bc.df);

  $("#chiRed").textContent = rc.chi.toFixed(2);
  $("#pRed").textContent = formatP(pR);
  $("#rejectRed").innerHTML = verdictChip(pR);
  $("#chiBlue").textContent = bc.chi.toFixed(2);
  $("#pBlue").textContent = formatP(pB);
  $("#rejectBlue").innerHTML = verdictChip(pB);

  const rRej = pR < 0.05, bRej = pB < 0.05;
  let verdict;
  if (!rRej && !bRej) {
    verdict = `红球 p=${formatP(pR)}、蓝球 p=${formatP(pB)}，两者都 <strong>显著大于 0.05</strong>。
      统计上没有证据拒绝"均匀分布"假设——换句话说，
      <strong>历史数据与"完全随机摇出"完全一致</strong>。
      "冷号热号"只是随机波动的自然产物，不构成下期的预测依据。`;
  } else if (rRej && !bRej) {
    verdict = `红球 p=${formatP(pR)} < 0.05，观察到显著偏差；蓝球 p=${formatP(pB)} 未显著。
      红球偏差可能来自摇奖设备物理不对称、样本量、或碰巧的极端情况。
      <strong>显著性 ≠ 可预测性</strong>，它只告诉你"均匀假设在此样本下成立/不成立"。`;
  } else {
    verdict = `红球 p=${formatP(pR)}、蓝球 p=${formatP(pB)}，存在显著偏差。
      这不代表"冷号会补"，更可能的解释是：摇奖装置的物理随机性不完美。
      即便如此，<strong>下一期仍然是独立同分布的随机抽取</strong>。`;
  }
  $("#scienceVerdict").innerHTML = verdict + "<br/><br/>"
    + `<em class="muted">样本：${state.draws.length} 期（${state.draws[0].issue} – ${state.draws[state.draws.length - 1].issue}）</em>`;
}

function formatP(p) {
  if (p < 0.0001) return "< 0.0001";
  return p.toFixed(4);
}

function verdictChip(p) {
  if (p < 0.05) {
    return `<span class="chip chip-warn">拒绝（p&lt;0.05）</span>`;
  }
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
  const blueMatch = q.match(/(?:蓝|blue|b)\s*0?(\d{1,2})/i);
  const blue = blueMatch ? Number(blueMatch[1]) : null;
  const redNums = blueMatch ? [] : parseNumList(q, 1, 33);

  return state.draws.filter((d) => {
    const textHit = String(d.issue).includes(q) || String(d.date || "").toLowerCase().includes(qLower);
    const redHit = redNums.length > 0 && redNums.every((n) => d.reds.includes(n));
    const blueHit = blue != null && d.blue === blue;
    return textHit || redHit || blueHit;
  });
}

function renderDataTable() {
  const q = ($("#qIssue")?.value || "").trim();
  const rows = limitDataRows(filterDataRows(q));
  state.tableRows = rows;
  const scope = readDataLimit() === Infinity ? "全部" : `最近 ${readDataLimit()} 期`;
  const prefix = q ? `搜索 "${q}"` : scope;
  renderTable(rows, `${prefix}：显示 ${rows.length} 条；总数据 ${state.draws.length} 期（倒序）。`);
}

function exportCurrentCsv() {
  const rows = state.tableRows;
  const lines = [["issue", "date", "reds", "blue"].join(",")];
  for (const d of rows) {
    lines.push([d.issue, d.date || "", d.reds.map(pad2).join(" "), pad2(d.blue)].map((v) => `"${String(v).replaceAll('"', '""')}"`).join(","));
  }
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ssq-data-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function analyseManualTicket() {
  const reds = parseNumList($("#manualReds")?.value, 1, 33).sort((a, b) => a - b);
  const blueList = parseNumList($("#manualBlue")?.value, 1, 16);
  if (reds.length !== 6) {
    renderTicketAnalysis({ error: `红球需要 6 个不重复号码（当前 ${reds.length} 个）` });
    return;
  }
  if (blueList.length !== 1) {
    renderTicketAnalysis({ error: `蓝球需要 1 个号码（当前 ${blueList.length} 个）` });
    return;
  }

  const blue = blueList[0];
  const latest = state.draws[state.draws.length - 1];
  const key = reds.join(",");
  const historyHits = state.draws.filter((d) => d.blue === blue && d.reds.join(",") === key);
  const prizeAnalysis = singleTicketAnalysis({ prizeBand: "expected" });
  renderTicketAnalysis({
    reds,
    blue,
    sum: sumOf(reds),
    span: spanOf(reds),
    oddEven: oddEvenRatio(reds),
    bigSmall: bigSmallRatio(reds),
    primeComposite: primeCompositeRatio(reds),
    path012: path012Ratio(reds),
    zone: zoneRatio(reds),
    ac: acValue(reds),
    consecutiveGroups: consecutiveGroups(reds),
    maxSameTail: maxSameTail(reds),
    repeatReds: latest ? reds.filter((n) => latest.reds.includes(n)) : [],
    repeatBlue: latest ? latest.blue === blue : false,
    historyHits,
    prizeAnalysis,
  });
}

function renderTools() {
  $("#btnCalcDanTuo").addEventListener("click", () => {
    try {
      const danCount = Number($("#danCount").value);
      const tuoCount = Number($("#tuoCount").value);
      const blueCount = Number($("#blueCount").value);
      const n = danTuoTickets({ danCount, tuoCount, blueCount });
      // 中奖率分析（精确）
      const analysis = analyzeDantuo({ danCount, tuoCount, blueCount, prizeBand: "expected" });
      $("#danTuoResult").innerHTML = renderTicketsWithPrize(n, analysis);
    } catch (e) {
      $("#danTuoResult").innerHTML = `<span class="chip chip-warn">${e.message}</span>`;
    }
  });
  $("#btnCalcComplex").addEventListener("click", () => {
    try {
      const red = Number($("#complexRed").value);
      const blue = Number($("#complexBlue").value);
      const n = complexTickets(red, blue);
      const analysis = analyzeComplex({ redCount: red, blueCount: blue, prizeBand: "expected" });
      $("#complexResult").innerHTML = renderTicketsWithPrize(n, analysis);
    } catch (e) {
      $("#complexResult").innerHTML = `<span class="chip chip-warn">${e.message}</span>`;
    }
  });
  $("#btnAnalyseTicket").addEventListener("click", analyseManualTicket);
  $("#manualReds").addEventListener("keydown", (e) => {
    if (e.key === "Enter") analyseManualTicket();
  });
  $("#manualBlue").addEventListener("keydown", (e) => {
    if (e.key === "Enter") analyseManualTicket();
  });

  const ref = $("#refTable");
  ref.innerHTML = "";
  for (const r of [6, 7, 8, 9, 10, 12, 15, 20]) {
    const n = combinations(r, 6);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="mono">${r}</td><td class="mono">${n.toLocaleString()}</td><td class="mono">${priceOf(n).toLocaleString()}</td>`;
    ref.appendChild(tr);
  }
}

function onGenerate() {
  const recent = state.draws.slice(-state.winSize);
  const freqR = freqFromDraws(recent, "reds", RED_MAX);
  const freqB = freqFromDraws(recent, "blue", BLUE_MAX);
  const cfg = readGeneratorConfig();
  const lastDraw = state.draws[state.draws.length - 1];
  const avoidLast = cfg.avoidLast && lastDraw ? lastDraw.reds : [];
  const engine = $("#engine")?.value || "legacy";
  const seed = $("#seedInput")?.value?.trim() || null;

  try {
    if (engine === "legacy") {
      runLegacyGenerator({ freqR, freqB, cfg, avoidLast });
    } else {
      runAdvancedGenerator({
        freqR, freqB,
        totalDraws: recent.length,
        cfg, avoidLast, engine, seed,
      });
    }
  } catch (e) {
    state.lastTickets = [];
    $("#btnCopyAll").disabled = true;
    showGenError(e.message || String(e));
    setGenDiagnostics("");
    renderSamplerDiagnostics(null);
  }
}

function runLegacyGenerator({ freqR, freqB, cfg, avoidLast }) {
  const result = generateTickets({
    freqR, freqB,
    strategyRed: cfg.strategyRed,
    strategyBlue: cfg.strategyBlue,
    alpha: cfg.alpha,
    constraints: cfg.constraints,
    count: cfg.count,
    optimize: cfg.optimize,
    includeRed: cfg.includeRed,
    excludeRed: cfg.excludeRed,
    excludeBlue: cfg.excludeBlue,
    avoidLast,
  });
  state.lastTickets = result.tickets;
  renderTickets(result.tickets, { tries: result.tries, failureReasons: result.failureReasons });
  $("#btnCopyAll").disabled = result.tickets.length === 0;
  const parsed = [
    cfg.includeRed.length ? `胆码 ${cfg.includeRed.length}` : "",
    cfg.excludeRed.length ? `排除红 ${cfg.excludeRed.length}` : "",
    cfg.excludeBlue.length ? `排除蓝 ${cfg.excludeBlue.length}` : "",
    cfg.optimize === "diverse" ? "低撞号/分散覆盖已启用" : "",
  ].filter(Boolean).join(" · ");
  setGenDiagnostics(
    `经典引擎 · 已生成 ${result.tickets.length}/${cfg.count} 注 · ${priceOf(result.tickets.length)} 元 · 尝试 ${result.tries} 次` +
    (parsed ? ` · ${parsed}` : "") +
    (avoidLast.length ? ` · 已避开上一期 ${avoidLast.length} 个红球` : "")
  );
  renderSamplerDiagnostics(null);
}

function runAdvancedGenerator({ freqR, freqB, totalDraws, cfg, avoidLast, engine, seed }) {
  const result = generateAdvanced({
    freqR, freqB, totalDraws,
    method: engine,
    count: cfg.count,
    constraints: cfg.constraints,
    includeRed: cfg.includeRed,
    excludeRed: cfg.excludeRed,
    excludeBlue: cfg.excludeBlue,
    avoidLast,
    seed,
  });
  state.lastTickets = result.tickets;
  renderTickets(result.tickets, {
    tries: result.diagnostics.tries || 0,
    failureReasons: result.diagnostics.failureReasons || {},
  });
  $("#btnCopyAll").disabled = result.tickets.length === 0;
  setGenDiagnostics(
    `${result.diagnostics.samplerLabel || engine} · 已生成 ${result.tickets.length}/${cfg.count} 注 · ${priceOf(result.tickets.length)} 元`
  );
  renderSamplerDiagnostics(result.diagnostics);
}

function renderSamplerDiagnostics(diag) {
  const el = $("#samplerDiag");
  if (!el) return;
  if (!diag) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }
  el.style.display = "";

  const score = diag.qualityScore;
  const scoreColor = score >= 80 ? "var(--acid)" : score >= 60 ? "var(--gold)" : "var(--red-2)";
  const items = [];
  items.push(`<div class="diag-line"><span>采样器</span><strong class="mono">${escape(diag.samplerLabel || diag.method)}</strong></div>`);
  items.push(`<div class="diag-line"><span>种子（可复制重现）</span><strong class="mono" title="点击复制" id="diagSeed">${escape(diag.seed)}</strong></div>`);
  items.push(`<div class="diag-line"><span>候选池大小</span><strong class="mono">${diag.poolSize ?? "—"}${diag.pinned?.length ? ` · 胆码 ${diag.pinned.length}` : ""}</strong></div>`);
  items.push(`<div class="diag-line"><span>分布质量分（vs 后验）</span><strong class="mono" style="color:${scoreColor}">${score}/100</strong></div>`);
  items.push(`<div class="diag-line"><span>JS 距离</span><strong class="mono">${diag.jsDistance.toFixed(4)}</strong></div>`);
  items.push(`<div class="diag-line"><span>Wasserstein-1</span><strong class="mono">${diag.wasserstein.toFixed(3)}</strong></div>`);
  if (diag.acceptRate != null) {
    const ar = diag.acceptRate;
    const arColor = ar >= 0.2 && ar <= 0.5 ? "var(--acid)" : "var(--gold)";
    items.push(`<div class="diag-line"><span>MCMC 接受率</span><strong class="mono" style="color:${arColor}">${(ar * 100).toFixed(1)}%</strong> <span class="muted fine">理想区间 20%–50%</span></div>`);
  }
  if (diag.ess != null) {
    items.push(`<div class="diag-line"><span>有效样本数 ESS</span><strong class="mono">${Math.round(diag.ess)}</strong> · τ_int <span class="mono">${diag.tauInt?.toFixed(2)}</span></div>`);
  }
  if (diag.rHat != null && Number.isFinite(diag.rHat)) {
    const rOk = diag.rHat < 1.1;
    const rColor = rOk ? "var(--acid)" : diag.rHat < 1.2 ? "var(--gold)" : "var(--red-2)";
    items.push(`<div class="diag-line"><span>Gelman-Rubin R̂</span><strong class="mono" style="color:${rColor}">${diag.rHat.toFixed(3)}</strong> <span class="muted fine">&lt; 1.1 为收敛</span></div>`);
  }
  if (diag.tries) {
    items.push(`<div class="diag-line"><span>采样尝试</span><strong class="mono">${diag.tries}</strong></div>`);
  }

  el.innerHTML = `
    <div class="diag-head">
      <span class="diag-tag">采样诊断</span>
      <span class="muted fine">所有指标在浏览器本地实时计算</span>
    </div>
    <div class="diag-grid">${items.join("")}</div>
    <div class="callout" style="margin-top:12px">
      <div class="callout-title">如何理解</div>
      <div class="callout-body">
        <strong>质量分</strong> 衡量采样输出的频率分布与贝叶斯后验的接近程度——满分代表"采样器准确反映了你设定的目标分布"。<br/>
        <strong>它和"中奖概率无关"</strong>。在独立同分布的彩票模型下，任何采样器的中奖期望都等于均匀随机：${(1 / 17721088).toExponential(2)}（一等奖 1/17,721,088）。
      </div>
    </div>
  `;

  const seedEl = $("#diagSeed");
  if (seedEl) {
    seedEl.style.cursor = "copy";
    seedEl.addEventListener("click", async () => {
      await copyToClipboard(diag.seed);
      toast("种子已复制：粘到「种子」输入框可重现该结果");
    });
  }
}

function escape(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function onCopyAll() {
  if (!state.lastTickets.length) return;
  await copyToClipboard(state.lastTickets.map(formatTicketLine).join("\n"));
  const btn = $("#btnCopyAll");
  const original = btn.textContent;
  btn.textContent = "已复制";
  setTimeout(() => (btn.textContent = original), 1200);
  toast(`已复制 ${state.lastTickets.length} 注到剪贴板`);
}

function onSearch() {
  renderDataTable();
}

async function onRefresh() {
  setRefreshLoading(true);
  try {
    const { meta, draws } = await loadDraws({ noCache: true });
    state.meta = meta;
    state.draws = draws;
    state.winSize = readWinSize();
    state.coMatrix = null; // 重新构建
    computeStats();
    renderAll();
    updateLstmDraws(draws);
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
  $("#btnApplyWin").addEventListener("click", () => {
    state.winSize = clamp(Number($("#winSize").value || 200), 20, 1000);
    computeStats();
    renderAll();
  });
  $("#trendWindow").addEventListener("change", renderTrendPanel);
  $("#trendShowStats")?.addEventListener("change", renderTrendPanel);
  $("#tsKind")?.addEventListener("change", renderTimeSeriesPanel);
  $("#tsWindow")?.addEventListener("change", renderTimeSeriesPanel);
  $("#tsMA")?.addEventListener("input", renderTimeSeriesPanel);
  $("#btnPartner")?.addEventListener("click", renderCooccurrencePanel);
  $("#partnerNum")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") renderCooccurrencePanel();
  });
  $("#btnGen").addEventListener("click", onGenerate);
  $("#btnCopyAll").addEventListener("click", onCopyAll);
  $("#btnSearch").addEventListener("click", onSearch);
  $("#qIssue").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onSearch();
  });
  $("#dataLimit").addEventListener("change", renderDataTable);
  $("#btnClear").addEventListener("click", () => {
    $("#qIssue").value = "";
    renderDataTable();
  });
  $("#btnExportCsv").addEventListener("click", () => {
    exportCurrentCsv();
    toast("已导出 CSV");
  });
  $("#btnRefresh").addEventListener("click", onRefresh);
  document.addEventListener("ssq:theme", () => {
    // 主题切换时重绘所有 SVG（颜色取自 CSS 变量）
    renderAll();
  });

  // tab 切换时重绘当前面板内的图表（避免隐藏期间宽度=0 的回退）
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      requestAnimationFrame(() => {
        const name = t.dataset.tab;
        if (name === "overview") {
          renderBars($("#chartRedAll"), state.freqAllRed, RED_MAX, "red");
          renderBars($("#chartBlueAll"), state.freqAllBlue, BLUE_MAX, "blue");
        } else if (name === "insight") {
          renderBars($("#chartRedMiss"), state.missRed, RED_MAX, "miss", { unit: "期" });
          renderBars($("#chartBlueMiss"), state.missBlue, BLUE_MAX, "miss", { unit: "期" });
        } else if (name === "distribution") {
          renderDistributionPanel();
        } else if (name === "trend") {
          renderTrendPanel();
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
    renderBars($("#chartRedAll"), state.freqAllRed, RED_MAX, "red");
    renderBars($("#chartBlueAll"), state.freqAllBlue, BLUE_MAX, "blue");
    renderBars($("#chartRedMiss"), state.missRed, RED_MAX, "miss", { unit: "期" });
    renderBars($("#chartBlueMiss"), state.missBlue, BLUE_MAX, "miss", { unit: "期" });
  }, 160);
}

async function main() {
  setupTabs();
  setupTheme();
  try {
    const { meta, draws, source, fetchError } = await loadDraws();
    if (!draws.length) throw new Error("数据为空");
    state.meta = meta;
    state.draws = draws;
    state.winSize = readWinSize();
    computeStats();
    renderAll();
    bindInteractions();
    showDataSourceBanner(source, fetchError);
    startCountdown();
    setupLstmController(draws);
    renderBettingPanel({ container: document.querySelector("#rationalBettingBody"), lottery: "ssq" });

    // 投注侧三大面板（与大乐透对等）
    renderSsqPrizePanel();
    setupSsqChasePanel();
    setupSsqBacktestPanel(() => state.draws);
    // 监听 prize 输入实时刷新
    document.querySelector("#ssqPrizeBand")?.addEventListener("change", renderSsqPrizePanel);
    document.querySelector("#ssqPrizeTickets")?.addEventListener("input", renderSsqPrizePanel);
  } catch (err) {
    showLoadError(String(err.message || err));
  }
}

let countdownTimer = null;
function startCountdown() {
  const tick = () => {
    const now = new Date();
    const target = nextDrawTime(now);
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

    const cutoff = saleCutoffOf(target);
    const beforeCutoff = now.getTime() < cutoff.getTime();
    const latest = state.draws[state.draws.length - 1];
    const nextIssue = latest ? nextIssueOf(latest.issue, target) : null;
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


/* ============================================================
 * 胆拖 / 复式：注数 + 中奖率综合渲染
 * ============================================================ */
function renderTicketsWithPrize(n, analysis) {
  const evColor = analysis.netEv >= 0 ? "var(--acid)" : "var(--red-2)";
  const lvRows = analysis.byLevel.map((b) => {
    const expected = b.expectedTickets;
    const pct = (b.pAtLeastOne * 100).toFixed(b.pAtLeastOne < 0.001 ? 6 : 2);
    return `
      <tr>
        <td class="fine">${b.label}</td>
        <td class="mono fine">${expected < 1e-4 ? expected.toExponential(2) : expected.toFixed(4)}</td>
        <td class="mono fine">${pct}%</td>
        <td class="mono fine">${b.prize.toLocaleString()}</td>
      </tr>
    `;
  }).join("");
  const anyWinPct = (analysis.pAtLeastOneAny * 100).toFixed(analysis.pAtLeastOneAny < 0.01 ? 4 : 2);

  return `
    <div><strong class="mono big-num">${n.toLocaleString()}</strong> 注</div>
    <div class="muted">合计 <strong class="mono">${priceOf(n).toLocaleString()}</strong> 元</div>
    <div class="dantuo-mini-stats" style="margin-top:12px">
      <div class="diag-line">
        <span>至少中一注奖概率</span>
        <strong class="mono" style="color:var(--gold)">${anyWinPct}%</strong>
      </div>
      <div class="diag-line">
        <span>期望中奖注数</span>
        <strong class="mono">${analysis.expectedAnyWin.toFixed(4)}</strong>
      </div>
      <div class="diag-line">
        <span>每注期望中奖率</span>
        <strong class="mono">${(analysis.expectedAnyWinPct * 100).toFixed(2)}%</strong>
      </div>
      <div class="diag-line">
        <span>期望回报率（payback）</span>
        <strong class="mono" style="color:${evColor}">${(analysis.payoutRatio * 100).toFixed(1)}%</strong>
      </div>
      <div class="diag-line">
        <span>期望净收益</span>
        <strong class="mono" style="color:${evColor}">${analysis.netEv.toFixed(2)} 元</strong>
      </div>
    </div>
    <details class="dantuo-mini-table" style="margin-top:10px">
      <summary class="fine muted" style="cursor:pointer">展开 6 奖级精确明细</summary>
      <table class="table mini" style="margin-top:6px">
        <thead><tr><th class="fine">奖级</th><th class="fine">期望注数</th><th class="fine">至少 1 注 P</th><th class="fine">奖金</th></tr></thead>
        <tbody>${lvRows}</tbody>
      </table>
    </details>
    <div class="hint" style="margin-top:8px">奖金按"期望"档浮动估计；payback &lt; 100% 表示长期亏损（彩票 EV 数学结论）。</div>
  `;
}
