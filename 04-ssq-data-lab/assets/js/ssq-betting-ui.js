// 双色球三大投注侧 UI 模块（与 DLT 端对等）：
//   1. renderSsqPrizePanel：6 奖级 EV 面板
//   2. renderSsqChasePanel：追号风险蒙特卡洛
//   3. renderSsqBacktestPanel：历史回测
//
// 与 DLT 同构，但适配 SSQ 没有"追加投注"的规则差异。
// 颜色用 SSQ 原生主题（红/蓝），DLT 用 dlt-front/back。

import {
  expectedReturn, withPrizeProbabilities, ticketsExpectedReturn,
  breakevenJackpot,
} from "./ssq-prize.js";
import { simulateChase } from "./ssq-chase.js";
import { runSsqBacktest } from "./ssq-backtest.js";
import { clamp } from "./utils.js";

const PRIZE_COLOR = "var(--red)";
const PRIZE_LIGHT = "var(--red-2)";
const PRIZE_OK = "var(--acid)";

/* ============================================================
 * Prize Panel
 * ============================================================ */
export function renderSsqPrizePanel() {
  const band = document.querySelector("#ssqPrizeBand")?.value || "expected";
  const tickets = clamp(Number(document.querySelector("#ssqPrizeTickets")?.value || 100), 1, 10000);
  const er = expectedReturn({ band });

  // KPI 区
  const kpiEl = document.querySelector("#ssqPrizeKpi");
  if (kpiEl) {
    const evColor = er.netEv >= 0 ? PRIZE_OK : PRIZE_LIGHT;
    const kpis = [
      { label: "单注成本", val: `${er.cost.toFixed(2)} 元` },
      { label: "单注 EV", val: `${er.ev.toFixed(4)} 元` },
      { label: "单注净值", val: `${er.netEv >= 0 ? "+" : ""}${er.netEv.toFixed(4)} 元`, color: evColor },
      { label: "Payback ratio", val: `${(er.payoutRatio * 100).toFixed(1)}%`, color: evColor },
    ];
    kpiEl.innerHTML = kpis.map((k) => `
      <div class="bt-kpi">
        <span>${k.label}</span>
        <strong style="color:${k.color || "var(--text)"}">${k.val}</strong>
      </div>
    `).join("");
  }

  // 6 奖级表
  const tbody = document.querySelector("#ssqPrizeTable tbody");
  if (tbody) {
    const items = withPrizeProbabilities();
    tbody.innerHTML = items.map((it) => {
      const prize = it.type === "fixed" ? it.fixedPrize : it.estimateBands[band];
      const contribution = it.probability * prize;
      const hits = it.hits.map((h) => `${h.r}+${h.b}`).join(" / ");
      return `
        <tr>
          <td>${it.label}</td>
          <td class="mono">${hits}</td>
          <td class="mono">${(it.probability * 100).toExponential(2)}%</td>
          <td class="mono">${Math.round(1 / it.probability).toLocaleString()}</td>
          <td class="mono">${formatPrize(prize)}</td>
          <td class="mono">${contribution.toFixed(4)} 元</td>
        </tr>
      `;
    }).join("");
  }

  // 总成本 / 总 EV
  const batchEl = document.querySelector("#ssqPrizeBatchSummary");
  if (batchEl) {
    const batch = ticketsExpectedReturn(tickets, { band });
    const breakeven = breakevenJackpot({ band });
    const breakevenStr = breakeven.breakevenJackpot != null
      ? `${(breakeven.breakevenJackpot / 10000).toFixed(0)} 万`
      : "数学上不可能";
    batchEl.innerHTML = `
      <div class="diag-grid">
        <div class="diag-line"><span>${tickets} 注总成本</span><strong class="mono">${batch.totalCost.toLocaleString()} 元</strong></div>
        <div class="diag-line"><span>${tickets} 注总 EV</span><strong class="mono">${batch.totalEv.toFixed(2)} 元</strong></div>
        <div class="diag-line"><span>${tickets} 注期望净亏</span><strong class="mono" style="color:${PRIZE_LIGHT}">${batch.netEv.toFixed(2)} 元</strong></div>
        <div class="diag-line"><span>每元期望回收</span><strong class="mono">${(batch.payoutRatio).toFixed(3)} 元</strong></div>
        <div class="diag-line">
          <span>盈亏平衡所需一等奖</span>
          <strong class="mono" style="color:var(--gold)">≥ ${breakevenStr}</strong>
        </div>
      </div>
      <div class="hint">每张 2 元彩票，期望回收约 <strong class="mono">${(er.ev).toFixed(2)} 元</strong>（payback ratio = <strong class="mono">${(er.payoutRatio * 100).toFixed(1)}%</strong>）。差额 <strong class="mono">${(er.cost - er.ev).toFixed(2)} 元</strong> 是国家公益金 + 运营成本。
        <strong style="color:var(--gold)">"盈亏平衡所需一等奖"</strong>是反推：在其他奖项当前估值固定时，一等奖至少需要多少元，单注 EV 才能 ≥ 2 元。SSQ 历史上几乎从未达到——当奖池滚到这个数字以上时，理论上"值得投"。
      </div>
    `;
  }
}

/* ============================================================
 * Chase Panel
 * ============================================================ */
let _chaseLastResult = null;

export function setupSsqChasePanel() {
  const btn = document.querySelector("#btnSsqChaseRun");
  if (btn) btn.addEventListener("click", onRunSsqChase);
}

function onRunSsqChase() {
  const btn = document.querySelector("#btnSsqChaseRun");
  if (btn) { btn.disabled = true; btn.textContent = "模拟中…"; }
  setTimeout(() => {
    try {
      const result = simulateChase({
        runs: clamp(Number(document.querySelector("#ssqChaseRuns")?.value || 2000), 200, 5000),
        draws: clamp(Number(document.querySelector("#ssqChaseDraws")?.value || 50), 5, 200),
        ticketsPerDraw: clamp(Number(document.querySelector("#ssqChaseTickets")?.value || 2), 1, 20),
        bankroll: clamp(Number(document.querySelector("#ssqChaseBankroll")?.value || 2000), 20, 1000000),
        strategy: document.querySelector("#ssqChaseStrategy")?.value || "flat",
        prizeBand: document.querySelector("#ssqChasePrizeBand")?.value || "expected",
        seed: document.querySelector("#ssqChaseSeed")?.value || "ssq-chase-2026",
      });
      _chaseLastResult = result;
      renderSsqChaseResult(result);
    } catch (e) {
      console.error(e);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "运行 2000 次蒙特卡洛"; }
    }
  }, 20);
}

function renderSsqChaseResult(r) {
  // KPI
  const kpiEl = document.querySelector("#ssqChaseSummary");
  if (kpiEl) {
    const ruinColor = r.ruinProb > 0.3 ? PRIZE_LIGHT : r.ruinProb > 0.1 ? "var(--gold)" : PRIZE_OK;
    const finalColor = r.finalMean >= r.bankroll ? PRIZE_OK : PRIZE_LIGHT;
    const kpis = [
      { label: "模拟次数", val: r.runs },
      { label: "破产概率", val: `${(r.ruinProb * 100).toFixed(1)}%`, color: ruinColor },
      { label: "终值均值", val: `${r.finalMean.toFixed(0)} 元`, color: finalColor },
      { label: "终值中位数", val: `${r.finalMedian.toFixed(0)} 元` },
      { label: "终值 5% 分位", val: `${r.finalP05.toFixed(0)} 元`, color: PRIZE_LIGHT },
      { label: "终值 95% 分位", val: `${r.finalP95.toFixed(0)} 元`, color: PRIZE_OK },
      { label: "曾中过一等奖", val: `${(r.everJackpotProb * 100).toFixed(2)}%`,
        color: r.everJackpotProb > 0 ? "var(--gold)" : "var(--text-2)" },
      { label: "曾中过二等奖", val: `${(r.everSecondProb * 100).toFixed(2)}%`,
        color: r.everSecondProb > 0 ? "var(--gold)" : "var(--text-2)" },
    ];
    kpiEl.innerHTML = kpis.map((k) => `
      <div class="bt-kpi">
        <span>${k.label}</span>
        <strong style="color:${k.color || "var(--text)"}">${k.val}</strong>
      </div>
    `).join("");
  }

  // 资金曲线
  const chartEl = document.querySelector("#ssqChaseChart");
  if (chartEl) chartEl.innerHTML = renderTrajectories(r);

  // 终值分布
  const distEl = document.querySelector("#ssqChaseFinalDist");
  if (distEl) distEl.innerHTML = renderHistogram(r);

  // verdict
  const verdictEl = document.querySelector("#ssqChaseVerdict");
  if (verdictEl) {
    const expectedLossPerYuan = (r.bankroll - r.finalMean) / (r.draws * r.ticketsPerDraw * 2);
    const paybackPerYuan = (2 - expectedLossPerYuan * 2);
    verdictEl.innerHTML = `
      <div class="callout-title">数学事实</div>
      <div class="callout-body">
        在 ${r.runs} 次独立模拟里：
        <ul style="margin-top:6px; padding-left:18px">
          <li>有 <strong style="color:${PRIZE_LIGHT}">${(r.ruinProb * 100).toFixed(1)}%</strong> 的人在第 ${r.draws} 期前就<strong>破产</strong>。</li>
          <li>账户余额最终的<strong>中位数</strong>是 <strong class="mono">${r.finalMedian.toFixed(0)} 元</strong>（初始 ${r.bankroll} 元）。</li>
          <li>每花 1 元下注，<strong>平均回收</strong> ${paybackPerYuan.toFixed(2)} 元（payback ratio ${(paybackPerYuan / 2 * 100).toFixed(1)}%）。</li>
          <li>有 <strong>${(r.everJackpotProb * 100).toFixed(2)}%</strong> 的人在 ${r.draws} 期里中过一等奖。意味着 <strong>${Math.round(1 / Math.max(1e-6, r.everJackpotProb)).toLocaleString()} 个像你这样追号的人里才有 1 个</strong> 中一等。</li>
        </ul>
        <div style="margin-top:12px"><strong>结论：</strong>追号<strong>不能改变中奖概率</strong>，只能改变破产时间。<strong>"补到中"是赌徒谬误</strong>——双色球每期独立。请理性消费、量力而行。</div>
      </div>
    `;
  }
}

function renderTrajectories(r) {
  const W = 800, H = 220;
  const padL = 50, padR = 12, padT = 10, padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  if (!r.trajectories.length) return "";
  let maxBk = r.bankroll;
  for (const path of r.trajectories) for (const v of path) if (v > maxBk) maxBk = v;
  const yScale = (v) => padT + innerH - (Math.max(0, v) / maxBk) * innerH;
  const xScale = (i, len) => padL + (i / Math.max(1, len - 1)) * innerW;

  const lines = r.trajectories.map((path) => {
    const ruined = path.length < r.draws + 1 || path[path.length - 1] === 0;
    const color = ruined ? "rgba(255,80,80,0.45)" : "rgba(93,217,184,0.55)";
    const pts = path.map((v, i) => `${xScale(i, r.draws + 1).toFixed(1)},${yScale(v).toFixed(1)}`).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1" stroke-linecap="round"/>`;
  }).join("");
  const baselineY = yScale(r.bankroll);
  const baseline = `<line x1="${padL}" x2="${padL + innerW}" y1="${baselineY}" y2="${baselineY}" stroke="rgba(255,255,255,.35)" stroke-dasharray="4 4"/>`;
  const baselineLabel = `<text x="${padL + 4}" y="${baselineY - 4}" font-size="10" fill="rgba(255,255,255,.55)" font-family="JetBrains Mono, monospace">初始本金 ${r.bankroll}</text>`;
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

function renderHistogram(r) {
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
    const color = binV >= r.bankroll ? PRIZE_OK : PRIZE_LIGHT;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="0.65"/>`;
  }).join("");
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

/* ============================================================
 * Backtest Panel
 * ============================================================ */
export function setupSsqBacktestPanel(getDraws) {
  const btn = document.querySelector("#btnSsqRunBacktest");
  if (btn) btn.addEventListener("click", () => onRunSsqBacktest(getDraws));
}

function onRunSsqBacktest(getDraws) {
  const btn = document.querySelector("#btnSsqRunBacktest");
  if (btn) { btn.disabled = true; btn.textContent = "回测中…"; }
  setTimeout(() => {
    try {
      const draws = getDraws();
      const cfg = readBacktestCfg();
      const result = runSsqBacktest(draws, cfg);
      renderSsqBacktestResult(result);
    } catch (e) {
      console.error(e);
      const summary = document.querySelector("#ssqBacktestSummary");
      if (summary) summary.innerHTML = `<div class="fine" style="color:${PRIZE_LIGHT}">回测失败：${e.message || e}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "运行回测"; }
    }
  }, 20);
}

function readBacktestCfg() {
  return {
    method: document.querySelector("#ssqBacktestMethod")?.value || "bayes-dpp",
    rounds: clamp(Number(document.querySelector("#ssqBacktestRounds")?.value || 80), 10, 300),
    lookback: clamp(Number(document.querySelector("#ssqBacktestLookback")?.value || 240), 50, 1000),
    ticketsPerDraw: clamp(Number(document.querySelector("#ssqBacktestTickets")?.value || 5), 1, 20),
    seed: (document.querySelector("#ssqBacktestSeed")?.value || "ssq-audit").trim() || "ssq-audit",
  };
}

function renderSsqBacktestResult(result) {
  const summaryEl = document.querySelector("#ssqBacktestSummary");
  const matrixEl = document.querySelector("#ssqBacktestMatrix");
  const bestEl = document.querySelector("#ssqBacktestBest");
  if (!summaryEl || !matrixEl || !bestEl) return;
  if (!result) return;

  const s = result.summary;
  const redLift = s.redLiftVsRandom.toFixed(2);
  const blueLift = s.blueLiftVsRandom.toFixed(2);
  const best = s.best;
  summaryEl.innerHTML = `
    <div class="backtest-kpis">
      <div class="bt-kpi"><span>回测期数</span><strong class="mono">${s.rounds}</strong></div>
      <div class="bt-kpi"><span>总注数</span><strong class="mono">${s.totalTickets}</strong></div>
      <div class="bt-kpi"><span>成本</span><strong class="mono">${s.costYuan.toLocaleString()} 元</strong></div>
      <div class="bt-kpi"><span>平均红球命中</span><strong class="mono">${s.avgRedHits.toFixed(3)}</strong></div>
      <div class="bt-kpi"><span>平均蓝球命中</span><strong class="mono">${s.avgBlueHits.toFixed(3)}</strong></div>
      <div class="bt-kpi"><span>红球 vs 随机</span><strong class="mono">${redLift}x</strong></div>
      <div class="bt-kpi"><span>蓝球 vs 随机</span><strong class="mono">${blueLift}x</strong></div>
      <div class="bt-kpi"><span>显著命中轮</span><strong class="mono">${s.notableCount}</strong></div>
    </div>
    <div class="callout" style="margin-top:12px">
      <div class="callout-title">专业解读</div>
      <div class="callout-body">
        理论随机基线：单注红球平均命中 <strong class="mono">${s.baseline.redAvgPerTicket.toFixed(3)}</strong>，
        蓝球平均命中 <strong class="mono">${s.baseline.blueAvgPerTicket.toFixed(3)}</strong>。
        回测只衡量采样器的历史表现和组合分散度，<strong>不代表下一期有预测优势</strong>。
        ${best ? `本轮最好命中为 <strong class="mono">${best.hitClass}</strong>（${escapeHtml(best.issue)}）。` : ""}
      </div>
    </div>
  `;
  matrixEl.innerHTML = renderHitMatrix(s.hitDistribution, s.totalTickets);
  bestEl.innerHTML = renderBestRecords(result.records);
}

function renderHitMatrix(dist, total) {
  const head = `<thead><tr><th>红\\蓝</th><th>0</th><th>1</th></tr></thead>`;
  const rows = [];
  for (let r = 6; r >= 0; r--) {
    const cells = [];
    for (let b = 0; b <= 1; b++) {
      const key = `${r}+${b}`;
      const n = dist[key] || 0;
      const pct = total ? `${((n / total) * 100).toFixed(1)}%` : "0.0%";
      const hot = r >= 4 || (r >= 3 && b >= 1);
      cells.push(`<td class="${hot && n ? "is-hot" : ""}"><strong class="mono">${n}</strong><span>${pct}</span></td>`);
    }
    rows.push(`<tr><th>${r}</th>${cells.join("")}</tr>`);
  }
  return `<table class="bt-matrix">${head}<tbody>${rows.join("")}</tbody></table>`;
}

function renderBestRecords(records) {
  const top = records.slice()
    .sort((a, b) => (b.redHits * 10 + b.blueHits) - (a.redHits * 10 + a.blueHits)
      || String(b.issue).localeCompare(String(a.issue)))
    .slice(0, 8);
  if (!top.length) return `<div class="fine muted">没有可展示的回测记录。</div>`;
  return `
    <div class="bt-best-list">
      ${top.map((r) => `
        <div class="bt-best-row">
          <span class="mono issue">${escapeHtml(r.issue)}</span>
          <span class="chip">${r.hitClass}</span>
          <span class="mono ticket">${escapeHtml(formatSsqTicketLine(r.ticket))}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function formatSsqTicketLine(ticket) {
  const reds = (ticket.reds || []).map((n) => String(n).padStart(2, "0")).join(" ");
  const blue = String(ticket.blue || "?").padStart(2, "0");
  return `${reds} | ${blue}`;
}

/* ============================================================
 * Helpers
 * ============================================================ */
function formatPrize(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n ?? "—");
  if (n >= 10000) return `${(n / 10000).toFixed(2)} 万`;
  return `${n.toFixed(0)} 元`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
