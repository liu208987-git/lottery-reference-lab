// 数据漂移监测 UI：PSI + 滚动 PSI + 贡献度 top-N
//
// 用户视角：训练用的旧数据和近期数据有没有"分布漂移"？
// 如果有，模型可能需要重训。

import { temporalPSI, rollingPSI, populationStabilityIndex, frequencyDist } from "./psi.js";
import { pad2 } from "./utils.js";

/**
 * @param container  渲染目标
 * @param draws      时间正序
 * @param lottery    "ssq" | "dlt"
 */
export function renderDriftMonitor({ container, draws, lottery }) {
  if (!container) return;
  if (!draws || draws.length < 100) {
    container.innerHTML = `<div class="callout chip-warn"><div class="callout-title">数据不足</div><div class="callout-body">至少需要 100 期才能做漂移分析。</div></div>`;
    return;
  }
  const isDlt = lottery === "dlt";
  const zone1 = isDlt ? "front" : "reds";
  const size1 = isDlt ? 35 : 33;
  const zone2 = isDlt ? "back" : "blue";
  const size2 = isDlt ? 12 : 16;

  // 主区与副区分别算 PSI（早 50% vs 晚 50%）
  const psi1 = temporalPSI(draws, zone1, size1, 0.5);
  const psi2 = temporalPSI(draws, zone2, size2, 0.5);
  const series1 = rollingPSI(draws, zone1, size1, Math.min(150, Math.floor(draws.length / 4)));

  container.innerHTML = `
    <div class="card-group">
      ${renderPSICard(psi1, isDlt ? "前区分布漂移" : "红球分布漂移", size1, isDlt)}
      ${renderPSICard(psi2, isDlt ? "后区分布漂移" : "蓝球分布漂移", size2, isDlt)}
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-title">${isDlt ? "前区" : "红球"} 滚动 PSI <span class="card-num">vs 全历史</span></div>
      ${renderRollingPSI(series1, draws)}
      <div class="hint">每个点是"近 N 期分布 vs 全历史分布"的 PSI。绿色 &lt; 0.10（稳定），黄色 0.1-0.25（轻微漂移），红色 &ge; 0.25（显著漂移）。i.i.d. 抽奖下应该长期 &lt; 0.05。</div>
    </div>

    ${renderTopContributors(psi1, size1, isDlt ? "前区" : "红球", isDlt)}

    <div class="callout" style="margin-top:14px">
      <div class="callout-title">PSI 解读</div>
      <div class="callout-body">
        <strong>Population Stability Index</strong> 衡量两个频率分布的对称 KL 散度。
        在金融业部署 ML 模型时常用：PSI &lt; 0.1 表示"分布稳定，模型可继续用"；
        PSI &ge; 0.25 提示"分布漂移，应重训模型"。<br/>
        <strong>彩票理论上 PSI 应长期接近 0</strong>——i.i.d. 抽奖每期独立同分布，
        长期频率收敛于均匀分布。任何持续 &gt; 0.1 的 PSI 都值得查证：
        是数据采集问题？设备物理偏差？还是数据集划分太短？
      </div>
    </div>
  `;
}

function renderPSICard(result, title, size, isDlt) {
  if (result.warning) {
    return `<div class="card"><div class="card-title">${title}</div><div class="hint">${result.warning}</div></div>`;
  }
  const verdictColor = result.verdict === "stable" ? "var(--acid)"
    : result.verdict === "minor" ? "var(--gold)" : "var(--red-2)";
  const verdictLabel = result.verdict === "stable" ? "稳定"
    : result.verdict === "minor" ? "轻微漂移" : "显著漂移";
  return `
    <div class="card">
      <div class="card-title">${title} <span class="card-num">PSI</span></div>
      <div class="diag-grid">
        <div class="diag-line">
          <span>PSI</span>
          <strong class="mono" style="color:${verdictColor}">${result.psi.toFixed(4)}</strong>
        </div>
        <div class="diag-line">
          <span>诊断</span>
          <strong style="color:${verdictColor}">${verdictLabel}</strong>
        </div>
        <div class="diag-line">
          <span>早期窗口</span>
          <strong class="mono">${result.earlyN} 期</strong>
        </div>
        <div class="diag-line">
          <span>晚期窗口</span>
          <strong class="mono">${result.lateN} 期</strong>
        </div>
      </div>
    </div>
  `;
}

function renderRollingPSI(series, draws) {
  if (series.length === 0) return `<div class="hint">数据不足以滚动</div>`;
  const W = 760, H = 180;
  const padL = 50, padR = 12, padT = 14, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxPsi = Math.max(0.3, ...series.map((p) => p.psi));
  const sx = (i) => padL + (i / Math.max(1, series.length - 1)) * innerW;
  const sy = (v) => padT + innerH - (v / maxPsi) * innerH;

  const dots = series.map((p, i) => {
    const color = p.verdict === "stable" ? "var(--acid)"
      : p.verdict === "minor" ? "var(--gold)" : "var(--red-2)";
    return `<circle cx="${sx(i).toFixed(1)}" cy="${sy(p.psi).toFixed(1)}" r="3" fill="${color}"/>`;
  }).join("");
  const line = series.length > 1
    ? `<polyline points="${series.map((p, i) => `${sx(i).toFixed(1)},${sy(p.psi).toFixed(1)}`).join(" ")}" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="1.2"/>`
    : "";

  // 阈值线
  const thresholdLine = (v, color) => {
    if (v > maxPsi) return "";
    return `<line x1="${padL}" y1="${sy(v).toFixed(1)}" x2="${padL + innerW}" y2="${sy(v).toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="3 4" opacity="0.6"/>`;
  };
  const labels = (v, label, color) => {
    if (v > maxPsi) return "";
    return `<text x="${padL + innerW + 4}" y="${sy(v) + 3}" font-size="9" fill="${color}" font-family="JetBrains Mono, monospace">${label}</text>`;
  };

  const xAxis = `<line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${padT + innerH}" stroke="rgba(255,255,255,.25)"/>`;
  const yAxis = `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="rgba(255,255,255,.25)"/>`;
  const yLabels = [0, maxPsi / 2, maxPsi].map((v) => `
    <text x="${padL - 4}" y="${sy(v) + 3}" text-anchor="end" font-size="9" fill="rgba(255,255,255,.5)" font-family="JetBrains Mono, monospace">${v.toFixed(2)}</text>
  `).join("");
  const firstIssue = series[0]?.issue || "";
  const lastIssue = series[series.length - 1]?.issue || "";

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
      ${xAxis}${yAxis}${yLabels}
      ${thresholdLine(0.1, "var(--gold)")}
      ${thresholdLine(0.25, "var(--red-2)")}
      ${labels(0.1, "0.10", "var(--gold)")}
      ${labels(0.25, "0.25", "var(--red-2)")}
      ${line}${dots}
      <text x="${padL}" y="${H - 8}" text-anchor="start" font-size="9" fill="rgba(255,255,255,.5)" font-family="JetBrains Mono, monospace">${firstIssue}</text>
      <text x="${padL + innerW}" y="${H - 8}" text-anchor="end" font-size="9" fill="rgba(255,255,255,.5)" font-family="JetBrains Mono, monospace">${lastIssue}</text>
    </svg>
  `;
}

function renderTopContributors(result, size, label, isDlt) {
  if (result.warning) return "";
  const top = result.contributions.slice(0, 5);
  const rows = top.map((c) => {
    const color = c.term > 0 ? "var(--gold)" : "var(--blue)";
    const dir = c.term > 0 ? "↑ 晚期更多" : "↓ 晚期更少";
    return `
      <tr>
        <td><span class="ball ${isDlt ? 'front' : 'red'}" style="width:24px;height:24px;font-size:10px;box-shadow:none">${pad2(c.i)}</span></td>
        <td class="mono">${(c.p * 100).toFixed(2)}%</td>
        <td class="mono">${(c.q * 100).toFixed(2)}%</td>
        <td class="mono" style="color:${color}">${c.term.toFixed(4)} ${dir}</td>
      </tr>
    `;
  }).join("");
  return `
    <div class="card" style="margin-top:14px">
      <div class="card-title">${label} 贡献度 Top-5 <span class="card-num">哪些号在漂移</span></div>
      <table class="table">
        <thead><tr><th>号码</th><th>早期占比</th><th>晚期占比</th><th>贡献度</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}
