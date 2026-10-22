// 理性投注工作台 UI
//
// 4 张卡片：
//   1. 当前 EV 计算器（用户输入当期奖池 → 算 EV 是否 > 成本）
//   2. 多注覆盖率对比（diverse vs random）
//   3. Kelly + 破产风险蒙特卡洛
//   4. 残酷事实总结（数学说话）

import {
  ssqSinglePrizeProbabilities, dltSinglePrizeProbabilities,
  expectedValue, multiTicketCoverage, kellyFraction, bankrollSimulation,
} from "./rational-betting.js";

let _state = {
  lottery: "ssq",
  jackpot: 5000000,
  secondPrize: 50000,
  bankroll: 1000,
  perPeriod: 10,
  periods: 100,
  K: 5,
};

export function renderBettingPanel({ container, lottery = "ssq" }) {
  if (!container) return;
  _state.lottery = lottery;

  // 默认值按彩种调
  if (lottery === "dlt") {
    _state.jackpot = 10000000;
    _state.secondPrize = 100000;
  }

  draw(container);
}

function draw(container) {
  const probs = _state.lottery === "ssq" ? ssqSinglePrizeProbabilities() : dltSinglePrizeProbabilities();
  const fixedPrizes = { "一等奖": _state.jackpot, "二等奖": _state.secondPrize };
  const ev = expectedValue(probs.tiers, fixedPrizes, 2);
  const kelly = kellyFraction(ev.ev, 2, _state.jackpot);

  container.innerHTML = `
    ${renderHeader()}
    ${renderEVCard(probs, ev)}
    ${renderTiersTable(probs.tiers, fixedPrizes)}
    ${renderCoverageCard()}
    ${renderKellyCard(kelly, ev)}
    ${renderSimulationCard(probs.tiers, fixedPrizes)}
    ${renderHardTruth(probs, ev)}
  `;
  bind(container);
}

function renderHeader() {
  return `
    <div class="callout chip-warn" style="margin-bottom:14px">
      <div class="callout-title">⚠️ 重要前提</div>
      <div class="callout-body">
        <strong>单注中奖概率是规则常数</strong>，不能被任何算法改变：
        <ul style="margin:6px 0; padding-left:20px">
          <li>SSQ 一等奖 = <strong class="mono">1 / 17,721,088</strong>（约 1770 万分之一）</li>
          <li>DLT 一等奖 = <strong class="mono">1 / 21,425,712</strong>（约 2140 万分之一）</li>
        </ul>
        本面板做的是 <strong>4 件数学上真有效的事</strong>：(1) 算 EV 决定何时投 ／
        (2) 多注覆盖优化 ／ (3) Kelly 资金管理 ／ (4) 破产风险评估。
        <strong>这些不是"提升中奖概率"，而是让投注从负期望博彩 → 至少做出理性决策。</strong>
      </div>
    </div>
  `;
}

function renderEVCard(probs, ev) {
  const isDlt = _state.lottery === "dlt";
  const evColor = ev.shouldPlay ? "var(--acid)" : "var(--red-2)";
  const evVerdict = ev.shouldPlay
    ? `✅ EV (${ev.ev.toFixed(3)}) > 成本 (2.00)，数学上"值得投"`
    : `❌ EV (${ev.ev.toFixed(3)}) < 成本 (2.00)，期望亏损 ${(2 - ev.ev).toFixed(3)} 元/注`;

  return `
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">💰 当期 EV 计算器 <span class="card-num">期望回报</span></div>
      <div class="rb-controls">
        <label class="field">
          <span>一等奖金额（元）</span>
          <input type="number" id="rbJackpot" min="0" step="100000" value="${_state.jackpot}" />
        </label>
        <label class="field">
          <span>二等奖金额（元）</span>
          <input type="number" id="rbSecond" min="0" step="1000" value="${_state.secondPrize}" />
        </label>
      </div>
      <div class="diag-grid" style="margin-top:14px">
        <div class="diag-line">
          <span>单注期望收益 EV</span>
          <strong class="mono" style="color:${evColor}">${ev.ev.toFixed(4)} 元</strong>
        </div>
        <div class="diag-line">
          <span>单注期望净利</span>
          <strong class="mono" style="color:${evColor}">${ev.evMinusCost >= 0 ? "+" : ""}${ev.evMinusCost.toFixed(4)} 元</strong>
        </div>
        <div class="diag-line">
          <span>至少中一注奖概率</span>
          <strong class="mono">${(ev.pAnyWin * 100).toFixed(4)}%（约 1/${(1/ev.pAnyWin).toFixed(0)}）</strong>
        </div>
        <div class="diag-line">
          <span>判断</span>
          <strong>${evVerdict}</strong>
        </div>
      </div>
      <div class="hint">${isDlt ? "DLT 大滚奖 + 追加投注偶尔会让 EV > 2 元（例如奖池 ≥ 6 亿时）。" : "SSQ 在历史上极少出现 EV > 成本。"}调一等奖到 <strong class="mono">${suggestBreakeven(probs.tiers).toLocaleString()}</strong> 元才能让 EV 刚好等于成本。</div>
    </div>
  `;
}

/** 找让 EV = cost 的一等奖临界值。 */
function suggestBreakeven(tiers) {
  // 把一等奖以外的贡献固定，反算一等奖
  let nonJackpot = 0;
  let pJackpot = 0;
  for (const t of tiers) {
    if (t.name === "一等奖") pJackpot = t.p;
    else if (typeof t.prize === "number") nonJackpot += t.p * t.prize;
  }
  // 假设二等奖也用前面输入的固定值（这是粗估）
  const remaining = 2 - nonJackpot - 0.5;  // 留点给二等
  return Math.max(0, Math.round(remaining / pJackpot));
}

function renderTiersTable(tiers, fixedPrizes) {
  const rows = tiers.map((t) => {
    const prize = typeof t.prize === "number" ? t.prize : (fixedPrizes[t.name] ?? 0);
    const contribution = t.p * prize;
    return `
      <tr>
        <td>${t.name}</td>
        <td class="mono">${t.p.toExponential(3)}</td>
        <td class="mono">1 / ${(1 / t.p).toFixed(0)}</td>
        <td class="mono">${prize.toLocaleString()}</td>
        <td class="mono">${contribution.toFixed(4)}</td>
      </tr>
    `;
  }).join("");
  return `
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">各级奖概率与 EV 贡献 <span class="card-num">tiers</span></div>
      <table class="table">
        <thead><tr>
          <th>奖级</th><th>概率</th><th>1/n 表示</th><th>奖金（元）</th><th>EV 贡献</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderCoverageCard() {
  return `
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">🎯 多注覆盖率对比 <span class="card-num">diverse vs random</span></div>
      <div class="rb-controls">
        <label class="field">
          <span>注数 K</span>
          <input type="number" id="rbK" min="2" max="50" step="1" value="${_state.K}" />
        </label>
        <button class="btn primary btn-sm" id="rbRunCoverage" type="button">运行 5000 次蒙特卡洛</button>
      </div>
      <div id="rbCoverageResult" class="hint" style="margin-top:8px">
        点上方按钮运行模拟。模拟会比较"K 注随机"vs "K 注互不重复"两种策略的"至少 1 注中六等奖以上"概率。
        <strong>互不重复策略在数学上严格 ≥ 随机策略</strong>——这是唯一真能"提高某种命中概率"的合法做法。
      </div>
    </div>
  `;
}

function renderKellyCard(kelly, ev) {
  const color = kelly.shouldBet ? "var(--acid)" : "var(--red-2)";
  return `
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">📐 Kelly 准则 <span class="card-num">最优投注比例</span></div>
      <div class="diag-grid">
        <div class="diag-line">
          <span>净期望（EV − cost）</span>
          <strong class="mono" style="color:${color}">${kelly.netEv >= 0 ? "+" : ""}${kelly.netEv.toFixed(4)} 元/注</strong>
        </div>
        <div class="diag-line">
          <span>Kelly 推荐比例 f*</span>
          <strong class="mono" style="color:${color}">${(kelly.fraction * 100).toFixed(4)}%</strong>
        </div>
        <div class="diag-line">
          <span>判断</span>
          <strong>${kelly.verdict}</strong>
        </div>
      </div>
      <div class="hint">
        <strong>Kelly 公式</strong>是赌博理论的金标准——保证长期资金增长率最大化且不破产。
        在彩票场景：当 EV ≤ cost 时 Kelly 严格判定 <strong>不投</strong>（这覆盖 99% 的期）。
        当 EV > cost（罕见的大滚奖期），Kelly 给一个<strong>极小</strong>的下注比例，
        因为单注方差是天文级。
      </div>
    </div>
  `;
}

function renderSimulationCard(tiers, fixedPrizes) {
  return `
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">📉 破产风险蒙特卡洛 <span class="card-num">1000 次模拟</span></div>
      <div class="rb-controls">
        <label class="field">
          <span>初始本金（元）</span>
          <input type="number" id="rbBankroll" min="100" step="100" value="${_state.bankroll}" />
        </label>
        <label class="field">
          <span>每期投注（元）</span>
          <input type="number" id="rbPerPeriod" min="2" step="2" value="${_state.perPeriod}" />
        </label>
        <label class="field">
          <span>模拟期数</span>
          <input type="number" id="rbPeriods" min="10" max="500" step="10" value="${_state.periods}" />
        </label>
        <button class="btn primary btn-sm" id="rbRunSim" type="button">开始模拟</button>
      </div>
      <div id="rbSimResult" class="hint" style="margin-top:10px">
        模拟"按上述参数连续投注 N 期"的本金轨迹。
        通常会看到：90% 以上的轨迹最终亏损，少数轨迹中一等奖暴富。
        这就是彩票的真实分布。
      </div>
    </div>
  `;
}

function renderHardTruth(probs, ev) {
  const expectedReturn = (ev.ev / 2) * 100;
  return `
    <div class="callout" style="margin-bottom:14px">
      <div class="callout-title">📜 数学告诉你的残酷事实</div>
      <div class="callout-body">
        <ol style="margin:0; padding-left:20px; line-height:1.7">
          <li>这个工具<strong>不能提升单注中奖概率</strong>——再强调一次：${(probs.tiers[0].p * 1e8).toFixed(2)} ppb（十亿分之一级别）的常数无法改变。</li>
          <li>当前奖池下单注期望返奖率 = <strong class="mono">${expectedReturn.toFixed(1)}%</strong>（每投 100 元期望拿回 ${expectedReturn.toFixed(1)} 元）。</li>
          <li>买 K 注互不重复确实能提高"至少中 1 注 ≥ T 等"的概率，但<strong>EV 仍然是 K 倍单注 EV，长期不变赚不回本</strong>。</li>
          <li>Kelly 准则在 99% 的期判定"不投"。值得投的是 EV > cost 的<strong>大滚奖期</strong>——大乐透偶尔出现。</li>
          <li>如果你连续投 100 期、每期 10 元（共 1000 元），模拟显示<strong>中位数最终本金 ≈ 500 元</strong>（亏 50%），这正是返奖率结果。</li>
          <li>娱乐性投注 OK，把彩票视为<strong>"为公益基金捐款 50%，换中大奖的极小希望 50%"</strong>的混合产品最准确。</li>
        </ol>
      </div>
    </div>
  `;
}

function bind(container) {
  // EV 输入框
  const j = container.querySelector("#rbJackpot");
  const s = container.querySelector("#rbSecond");
  if (j) j.addEventListener("change", () => { _state.jackpot = Math.max(0, parseInt(j.value, 10) || 0); draw(container); });
  if (s) s.addEventListener("change", () => { _state.secondPrize = Math.max(0, parseInt(s.value, 10) || 0); draw(container); });

  // K 输入
  const k = container.querySelector("#rbK");
  if (k) k.addEventListener("change", () => { _state.K = Math.max(2, Math.min(50, parseInt(k.value, 10) || 5)); });

  // 多注覆盖
  const cov = container.querySelector("#rbRunCoverage");
  if (cov) cov.addEventListener("click", async () => {
    const out = container.querySelector("#rbCoverageResult");
    out.innerHTML = `<div class="muted">运行中（约 5-10 秒）…</div>`;
    await new Promise((r) => setTimeout(r, 50));
    const random = multiTicketCoverage({ K: _state.K, lottery: _state.lottery, tierThreshold: 6, strategy: "random", runs: 5000, seed: "ui-r" });
    const diverse = multiTicketCoverage({ K: _state.K, lottery: _state.lottery, tierThreshold: 6, strategy: "diverse", runs: 5000, seed: "ui-d" });
    const improvement = (diverse.pAtLeastOneHit - random.pAtLeastOneHit) * 100;
    const sigDiff = Math.abs(diverse.pAtLeastOneHit - random.pAtLeastOneHit) > 2 * Math.max(diverse.stderr, random.stderr);
    out.innerHTML = `
      <div class="diag-grid" style="margin-top:0">
        <div class="diag-line"><span>K = ${_state.K} 注</span><strong>"至少中 1 注 ≥ 六等奖" 概率</strong></div>
        <div class="diag-line"><span>随机生成</span><strong class="mono">${(random.pAtLeastOneHit * 100).toFixed(2)}% ± ${(random.stderr * 100).toFixed(2)}%</strong></div>
        <div class="diag-line"><span>互不重复</span><strong class="mono" style="color:var(--acid)">${(diverse.pAtLeastOneHit * 100).toFixed(2)}% ± ${(diverse.stderr * 100).toFixed(2)}%</strong></div>
        <div class="diag-line"><span>提升幅度</span><strong class="mono" style="color:${improvement >= 0 ? "var(--acid)" : "var(--red-2)"}">${improvement >= 0 ? "+" : ""}${improvement.toFixed(3)} pp ${sigDiff ? "<span class='chip chip-ok'>统计显著</span>" : "<span class='chip'>差异不显著</span>"}</strong></div>
      </div>
      <div style="margin-top:8px">5000 次蒙特卡洛 · 95% CI [${(random.ci95[0] * 100).toFixed(2)}%, ${(random.ci95[1] * 100).toFixed(2)}%] vs [${(diverse.ci95[0] * 100).toFixed(2)}%, ${(diverse.ci95[1] * 100).toFixed(2)}%]</div>
      <div style="margin-top:8px"><strong>但是注意</strong>：互不重复策略的<strong>期望收益</strong>仍然是 K × 单注 EV，与随机策略<strong>完全相同</strong>。
      所谓"提升"只在"至少中一注小奖"的指标上成立，长期总收益不变。</div>
    `;
  });

  // 模拟
  const br = container.querySelector("#rbBankroll");
  const pp = container.querySelector("#rbPerPeriod");
  const pe = container.querySelector("#rbPeriods");
  if (br) br.addEventListener("change", () => { _state.bankroll = Math.max(100, parseInt(br.value, 10) || 1000); });
  if (pp) pp.addEventListener("change", () => { _state.perPeriod = Math.max(2, parseInt(pp.value, 10) || 10); });
  if (pe) pe.addEventListener("change", () => { _state.periods = Math.max(10, Math.min(500, parseInt(pe.value, 10) || 100)); });

  const sim = container.querySelector("#rbRunSim");
  if (sim) sim.addEventListener("click", async () => {
    const out = container.querySelector("#rbSimResult");
    out.innerHTML = `<div class="muted">运行中…</div>`;
    await new Promise((r) => setTimeout(r, 50));
    const probs = _state.lottery === "ssq" ? ssqSinglePrizeProbabilities() : dltSinglePrizeProbabilities();
    const result = bankrollSimulation({
      bankroll: _state.bankroll,
      perPeriodCost: _state.perPeriod,
      periods: _state.periods,
      simulations: 1000,
      tiers: probs.tiers,
      fixedPrizes: { "一等奖": _state.jackpot, "二等奖": _state.secondPrize },
      seed: `ui-sim-${Date.now()}`,
    });
    out.innerHTML = renderSimResults(result);
  });
}

function renderSimResults(r) {
  const lossPct = ((r.initialBankroll - r.finalMedian) / r.initialBankroll * 100);
  return `
    <div class="diag-grid" style="margin-top:0">
      <div class="diag-line"><span>总投入</span><strong class="mono">${r.totalSpend.toLocaleString()} 元</strong></div>
      <div class="diag-line"><span>最终本金均值</span><strong class="mono">${r.finalMean.toFixed(0)} 元</strong></div>
      <div class="diag-line"><span>最终本金中位数</span><strong class="mono" style="color:${r.finalMedian < r.initialBankroll ? "var(--red-2)" : "var(--acid)"}">${r.finalMedian.toFixed(0)} 元（${lossPct >= 0 ? "亏" : "赚"} ${Math.abs(lossPct).toFixed(1)}%）</strong></div>
      <div class="diag-line"><span>10%-90% 分位</span><strong class="mono">[${r.finalP10.toFixed(0)}, ${r.finalP90.toFixed(0)}]</strong></div>
      <div class="diag-line"><span>破产概率</span><strong class="mono" style="color:${r.bankruptcyRate > 0.1 ? "var(--red-2)" : "var(--gold)"}">${(r.bankruptcyRate * 100).toFixed(1)}%</strong></div>
      <div class="diag-line"><span>${r.periods} 期内任意中奖概率</span><strong class="mono">${(r.pAnyWinOverPeriods * 100).toFixed(1)}%</strong></div>
      <div class="diag-line"><span>${r.periods} 期内中一等奖概率</span><strong class="mono">${(r.pJackpotOverPeriods * 100).toFixed(4)}%</strong></div>
    </div>
    <div style="margin-top:10px">${renderTrajectories(r.sampleTrajectories, r.initialBankroll)}</div>
  `;
}

function renderTrajectories(trajectories, initial) {
  if (!trajectories || trajectories.length === 0) return "";
  const W = 720, H = 220;
  const padL = 50, padR = 12, padT = 12, padB = 30;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const allValues = trajectories.flat();
  let maxV = Math.max(...allValues, initial * 1.1);
  let minV = Math.min(...allValues, 0);
  const periods = trajectories[0].length - 1;
  const sx = (i) => padL + (i / periods) * innerW;
  const sy = (v) => padT + innerH - ((v - minV) / Math.max(1, maxV - minV)) * innerH;

  const lines = trajectories.slice(0, 30).map((traj) => {
    const final = traj[traj.length - 1];
    const color = final > initial ? "rgba(0, 220, 130, 0.4)" : final > initial * 0.5 ? "rgba(255, 200, 80, 0.4)" : "rgba(220, 80, 80, 0.35)";
    const pts = traj.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="0.8"/>`;
  }).join("");

  const baseLine = `<line x1="${padL}" y1="${sy(initial)}" x2="${padL + innerW}" y2="${sy(initial)}" stroke="var(--text-2)" stroke-dasharray="3 4" stroke-width="1"/>`;
  const xAxis = `<line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${padT + innerH}" stroke="rgba(255,255,255,.25)"/>`;
  const yAxis = `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="rgba(255,255,255,.25)"/>`;
  const yLabels = [minV, initial / 2, initial, maxV].filter((v, i, a) => i === a.findIndex((x) => Math.abs(x - v) < 1)).map((v) =>
    `<text x="${padL - 4}" y="${sy(v) + 3}" text-anchor="end" font-size="10" fill="rgba(255,255,255,.6)" font-family="JetBrains Mono, monospace">${v.toFixed(0)}</text>`
  ).join("");
  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="background:rgba(255,255,255,0.02); border-radius: 8px">
      ${xAxis}${yAxis}${baseLine}${yLabels}
      ${lines}
      <text x="${padL + 8}" y="${sy(initial) - 4}" font-size="9" fill="rgba(255,255,255,.5)" font-family="JetBrains Mono, monospace">初始 ${initial}</text>
      <text x="${padL}" y="${H - 8}" text-anchor="start" font-size="10" fill="rgba(255,255,255,.5)">期数 0</text>
      <text x="${padL + innerW}" y="${H - 8}" text-anchor="end" font-size="10" fill="rgba(255,255,255,.5)">期数 ${periods}</text>
    </svg>
  `;
}
