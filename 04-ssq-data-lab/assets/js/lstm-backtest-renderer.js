// SSQ LSTM 回测结果渲染：从 controller 抽出来。
//
// 输入：lstm/ensemble/freq/bayes/uniform 的 backtest 结果 + 当前 model（取 calibration）
// 输出：HTML 字符串（含 6 行表格 / 双卡片 BSS+permutation / reliability 双线 SVG）

import {
  bootstrapCI, pairedBootstrap,
  metricAvgHit6, metricBlueAcc,
  reliabilityDiagram,
  brierSkillScore, permutationTest,
} from "./nn-statistics.js";
import { bcaBootstrap } from "./bca-bootstrap.js";
import { RANDOM_BASELINE } from "./nn-backtest.js";
import { BASELINES } from "./lottery-config.js";
import { RED_DIM } from "./nn-ssq-model.js";

/**
 * @param ctx { lstm, ensemble?, freq, bayes, uniform, n, ensembleSize?, calibration? }
 * @returns HTML 字符串
 */
export function renderSsqBacktestReport(ctx) {
  const { lstm, ensemble, freq, bayes, uniform, n, ensembleSize = 0, calibration = null } = ctx;
  const fmt = (v, d = 4) => (v == null ? "—" : v.toFixed(d));
  const pct = (v) => (v == null ? "—" : `${(v * 100).toFixed(2)}%`);

  const lstmCi = bcaBootstrap(lstm.records, metricAvgHit6, { B: 800, seed: "bt-lstm" });
  const lstmBlueCi = bcaBootstrapForBlueAcc(lstm.records);
  const uniCi = bcaBootstrap(uniform.records, metricAvgHit6, { B: 800, seed: "bt-uni" });
  const paired = pairedBootstrap(lstm.records, uniform.records, metricAvgHit6, { B: 500, seed: "bt-paired" });

  const formatCI = (mean, lo, hi) =>
    `${mean.toFixed(3)} <span class="muted">[${lo.toFixed(3)}, ${hi.toFixed(3)}]</span>`;
  const formatPctCI = (mean, lo, hi) =>
    `${(mean * 100).toFixed(2)}% <span class="muted">[${(lo * 100).toFixed(2)}, ${(hi * 100).toFixed(2)}]</span>`;

  const rows = [];
  rows.push({
    label: "LSTM（单模型）",
    tag: "primary",
    redHit6Cell: formatCI(lstm.summary.avgRedHit6, lstmCi.lower, lstmCi.upper),
    redHit8: lstm.summary.avgRedHit8,
    blueAccCell: formatPctCI(lstm.summary.blueAccuracy, lstmBlueCi.lower, lstmBlueCi.upper),
    brier: lstm.summary.avgBrier,
    ll: lstm.summary.avgRedLL + lstm.summary.avgBlueLL,
  });
  if (ensemble) {
    const ensCi = bcaBootstrap(ensemble.records, metricAvgHit6, { B: 800, seed: "bt-ens" });
    const ensBlueCi = bcaBootstrapForBlueAcc(ensemble.records);
    rows.push({
      label: `LSTM Ensemble (K=${ensembleSize})`,
      tag: "primary",
      redHit6Cell: formatCI(ensemble.summary.avgRedHit6, ensCi.lower, ensCi.upper),
      redHit8: ensemble.summary.avgRedHit8,
      blueAccCell: formatPctCI(ensemble.summary.blueAccuracy, ensBlueCi.lower, ensBlueCi.upper),
      brier: ensemble.summary.avgBrier,
      ll: ensemble.summary.avgRedLL + ensemble.summary.avgBlueLL,
    });
  }
  rows.push({
    label: "贝叶斯后验 baseline",
    redHit6Cell: bayes.summary.avgRedHit6.toFixed(3),
    redHit8: bayes.summary.avgRedHit8,
    blueAccCell: pct(bayes.summary.blueAccuracy),
  });
  rows.push({
    label: "频率 baseline",
    redHit6Cell: freq.summary.avgRedHit6.toFixed(3),
    redHit8: freq.summary.avgRedHit8,
    blueAccCell: pct(freq.summary.blueAccuracy),
  });
  rows.push({
    label: "均匀随机 baseline (100×MC)",
    redHit6Cell: formatCI(uniform.summary.avgRedHit6, uniCi.lower, uniCi.upper),
    redHit8: uniform.summary.avgRedHit8,
    blueAccCell: pct(uniform.summary.blueAccuracy),
  });
  rows.push({
    label: "理论期望（任意预测器渐近）",
    tag: "theory",
    redHit6Cell: RANDOM_BASELINE.redHit6.toFixed(3),
    redHit8: RANDOM_BASELINE.redHit8,
    blueAccCell: pct(RANDOM_BASELINE.blueAcc),
  });

  const tableRows = rows.map((r) => `
    <tr class="${r.tag === "primary" ? "row-primary" : ""}${r.tag === "theory" ? " row-theory" : ""}">
      <td>${r.label}</td>
      <td class="mono">${r.redHit6Cell}</td>
      <td class="mono">${typeof r.redHit8 === "number" ? r.redHit8.toFixed(3) : (r.redHit8 ?? "—")}</td>
      <td class="mono">${r.blueAccCell}</td>
      <td class="mono">${r.brier != null ? fmt(r.brier) : "—"}</td>
      <td class="mono">${r.ll != null ? fmt(r.ll, 3) : "—"}</td>
    </tr>
  `).join("");

  const ciIncludesZero = paired.lower <= 0 && paired.upper >= 0;
  const verdict = ciIncludesZero
    ? `LSTM 与均匀随机的 hit@6 差值 95% CI = [${paired.lower.toFixed(3)}, ${paired.upper.toFixed(3)}] <strong>包含 0</strong>，差异在统计上不显著——这正是预期：彩票是 i.i.d. 随机抽取，没有可学习的时间规律。`
    : `LSTM 与均匀随机的 hit@6 差值 95% CI = [${paired.lower.toFixed(3)}, ${paired.upper.toFixed(3)}] <strong>不含 0</strong>。但要警惕：(1) ${n} 期的局部偏差可能是数据集偏差，不一定泛化；(2) 即便差异真实，也可能源于硬件物理偏差或 multi-seed 选最优结果，不构成可重复的可预测性。`;

  const bssLstm = brierSkillScore(lstm.records, RED_DIM, 6);
  const bssEnsemble = (ensemble && ensemble.records) ? brierSkillScore(ensemble.records, RED_DIM, 6) : null;
  const permTest = permutationTest(lstm.records, uniform.records, metricAvgHit6, { B: 1000, seed: "perm-lstm-uni" });

  const reliab = reliabilityDiagram(lstm.records, { bins: 10 });
  const rawRecords = lstm.records.map((r) => ({
    realReds: r.realReds,
    redProbs: r.rawRedProbs || r.redProbs,
  }));
  const reliabRaw = reliabilityDiagram(rawRecords, { bins: 10 });
  const hasCalibration = !!calibration;
  const reliabSvg = renderReliabilityDiagram(reliab, hasCalibration ? reliabRaw : null);
  const eceCompare = hasCalibration
    ? `ECE: raw <strong class="mono">${reliabRaw.ece.toFixed(4)}</strong> → calibrated <strong class="mono">${reliab.ece.toFixed(4)}</strong>（${reliabRaw.ece > reliab.ece ? "↓" : "↑"} ${Math.abs((reliabRaw.ece - reliab.ece) / Math.max(1e-6, reliabRaw.ece) * 100).toFixed(0)}%）`
    : `ECE = ${reliab.ece.toFixed(4)}`;

  return `
    <div class="bt-table-wrap">
      <table class="table">
        <thead><tr>
          <th>方法</th>
          <th>红 hit@6 [95% BCa CI]</th>
          <th>红 hit@8</th>
          <th>蓝 Top-1 准确率 [95% BCa CI]</th>
          <th>Brier</th>
          <th>NLL</th>
        </tr></thead>
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
            <span>LSTM BSS（红球）</span>
            <strong class="mono" style="color:${bssLstm.bss > 0 ? "var(--acid)" : "var(--red-2)"}">${bssLstm.bss.toFixed(4)}</strong>
          </div>
          ${bssEnsemble ? `
          <div class="diag-line">
            <span>Ensemble BSS</span>
            <strong class="mono" style="color:${bssEnsemble.bss > 0 ? "var(--acid)" : "var(--red-2)"}">${bssEnsemble.bss.toFixed(4)}</strong>
          </div>` : ""}
          <div class="diag-line">
            <span>Climatology baseline</span>
            <strong class="mono">${BASELINES.ssq.redClimatology.toFixed(4)}</strong>
          </div>
          <div class="diag-line">
            <span>BS<sub>model</sub> · BS<sub>ref</sub></span>
            <strong class="mono">${bssLstm.bsModel.toFixed(4)} · ${bssLstm.bsRef.toFixed(4)}</strong>
          </div>
        </div>
        <div class="hint">BSS = 1 − BS_model / BS_ref。&gt;0 优于"全部猜 6/33"； &lt;0 反而更差。彩票 i.i.d. 下 BSS 期望 ≈ 0。</div>
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
        <div class="hint">置换检验比 paired bootstrap 更严格。每次随机翻转 (LSTM, uniform) 的配对身份，看观察值是否落在分布尾部。p &gt;= 0.05 表示数据"看起来"和"两组本质上一样"无法区分。</div>
      </div>
    </div>
    <div class="card" style="margin-top:14px; padding: var(--space-4)">
      <div class="card-title">校准曲线 · Reliability Diagram <span class="card-num">${eceCompare}</span></div>
      ${reliabSvg}
      <div class="hint">点越接近对角线 y=x 越好——表示 "概率 20% 的号码大约真有 20% 的命中率"。${hasCalibration ? "灰色虚线 = 训练后未校准；彩色 = temperature scaling 校准后。完美校准 ECE = 0。" : "完美校准 ECE = 0。"}</div>
    </div>
  `;
}

/** Reliability diagram：calibrated 实线 + raw 虚线（可选）。 */
export function renderReliabilityDiagram(reliab, reliabRaw = null) {
  const W = 380, H = 240;
  const padL = 36, padR = 12, padT = 18, padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const sx = (v) => padL + v * innerW;
  const sy = (v) => padT + (1 - v) * innerH;

  const renderPoints = (points, color, fillOpacity = 0.78, withLine = true) => {
    const validPts = points.filter(p => p.observedFreq != null && p.count > 0);
    const dots = validPts.map((p) => {
      const r = 2 + Math.min(8, Math.sqrt(p.count) * 0.5);
      return `<circle cx="${sx(p.avgPred).toFixed(1)}" cy="${sy(p.observedFreq).toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" opacity="${fillOpacity}"/>`;
    }).join("");
    const line = withLine && validPts.length > 1
      ? `<polyline points="${validPts.map(p => `${sx(p.avgPred).toFixed(1)},${sy(p.observedFreq).toFixed(1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.6"/>`
      : "";
    return line + dots;
  };
  const refLine = `<line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${padT}" stroke="rgba(255,255,255,.35)" stroke-dasharray="3 4"/>`;
  const xAxis = `<line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${padT + innerH}" stroke="rgba(255,255,255,.25)"/>`;
  const yAxis = `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="rgba(255,255,255,.25)"/>`;
  const xLabel = `<text x="${padL + innerW / 2}" y="${H - 6}" text-anchor="middle" font-size="10" font-family="JetBrains Mono, monospace" fill="rgba(255,255,255,.6)">预测概率（avg per bucket）</text>`;
  const yLabel = `<text x="${padL - 28}" y="${padT + innerH / 2}" text-anchor="middle" font-size="10" font-family="JetBrains Mono, monospace" fill="rgba(255,255,255,.6)" transform="rotate(-90 ${padL - 28} ${padT + innerH / 2})">观察到的命中率</text>`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((v) => `
    <text x="${sx(v)}" y="${padT + innerH + 14}" text-anchor="middle" font-size="9" fill="rgba(255,255,255,.5)" font-family="JetBrains Mono, monospace">${v.toFixed(2)}</text>
    <text x="${padL - 4}" y="${sy(v) + 3}" text-anchor="end" font-size="9" fill="rgba(255,255,255,.5)" font-family="JetBrains Mono, monospace">${v.toFixed(2)}</text>
  `).join("");
  const hasRaw = reliabRaw && reliabRaw.points.some(p => p.observedFreq != null && p.count > 0);
  const legend = hasRaw
    ? `<g transform="translate(${padL + 8}, ${padT + 4})">
        <line x1="0" y1="6" x2="14" y2="6" stroke="rgba(180,180,180,.6)" stroke-dasharray="2 2"/>
        <circle cx="22" cy="6" r="3" fill="rgba(180,180,180,.6)"/>
        <text x="30" y="9" font-size="9" fill="rgba(255,255,255,.65)" font-family="JetBrains Mono, monospace">raw</text>
        <line x1="68" y1="6" x2="82" y2="6" stroke="var(--acid)" stroke-width="1.5"/>
        <circle cx="90" cy="6" r="3" fill="var(--acid)"/>
        <text x="98" y="9" font-size="9" fill="rgba(255,255,255,.65)" font-family="JetBrains Mono, monospace">calibrated</text>
      </g>`
    : "";
  const rawSvg = hasRaw ? `<g opacity="0.55">${renderPoints(reliabRaw.points, "rgba(180,180,180,.85)", 0.55, false)}</g>` : "";
  const rawLine = hasRaw
    ? (() => {
      const pts = reliabRaw.points.filter(p => p.observedFreq != null && p.count > 0)
        .map(p => `${sx(p.avgPred).toFixed(1)},${sy(p.observedFreq).toFixed(1)}`).join(" ");
      return `<polyline points="${pts}" fill="none" stroke="rgba(180,180,180,.55)" stroke-width="1.2" stroke-dasharray="3 3"/>`;
    })()
    : "";
  const calSvg = renderPoints(reliab.points, "var(--acid)", 0.85, true);

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
    ${xAxis}${yAxis}${refLine}${ticks}${xLabel}${yLabel}${rawLine}${rawSvg}${calSvg}${legend}
  </svg>`;
}


/** BCa for blue accuracy (binary metric)。 */
function bcaBootstrapForBlueAcc(records) {
  return bcaBootstrap(records, (rs) => {
    if (rs.length === 0) return 0;
    let s = 0;
    for (const r of rs) if (r.blueHit) s++;
    return s / rs.length;
  }, { B: 800, seed: "bt-blue" });
}
