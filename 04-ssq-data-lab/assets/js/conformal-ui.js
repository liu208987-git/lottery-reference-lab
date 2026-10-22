// 共形预测面板：α 滑块 + 实时跑 split conformal + 显示集合大小 / 经验覆盖率
//
// 数据源：当前 state.model 已跑过的 backtest records；如果还没跑回测，
// 提示用户先点回测。

import { splitConformal, conformalPredict, fitConformalThreshold } from "./conformal.js";
import { pad2 } from "./utils.js";

/**
 * @param container       渲染目标
 * @param backtestRecords 一组 { redProbs/probs, realReds/realFront, ... }
 * @param lottery         "ssq" | "dlt"
 * @param latestProbs     当前最新一期预测的概率 (Float32Array | null)
 *                          有的话会显示"在 α 下，最新一期预测集 = ..."
 */
export function renderConformalPanel({ container, backtestRecords, lottery, latestProbs = null }) {
  if (!container) return null;
  if (!backtestRecords || backtestRecords.length < 30) {
    container.innerHTML = `<div class="callout chip-warn"><div class="callout-title">共形预测需要回测数据</div><div class="callout-body">请先点击「Walk-forward 回测」生成至少 30 期预测概率。共形需要把 records 分两半（前一半 calibrate / 后一半 evaluate）来给频率主义保证。</div></div>`;
    return null;
  }

  const isDlt = lottery === "dlt";
  const numLabel = isDlt ? "前区" : "红球";

  // 把 records 转成 conformal 输入
  const records = backtestRecords.map((r) => ({
    probs: r.redProbs || r.rawRedProbs,
    realSet: r.realReds || r.realFront,
  }));

  let alpha = 0.1;

  function update() {
    const result = splitConformal(records, alpha, 0.5);
    let latestPred = null;
    if (latestProbs && result.qHat) {
      latestPred = conformalPredict(latestProbs, result.qHat);
    }
    container.innerHTML = renderHTML(result, alpha, lottery, latestPred);
    bind(container, () => update());
  }

  function bind(c, refresh) {
    const slider = c.querySelector("#conformalAlpha");
    if (slider) {
      slider.addEventListener("input", () => {
        alpha = parseFloat(slider.value);
        const display = c.querySelector("#conformalAlphaVal");
        if (display) display.textContent = alpha.toFixed(2);
      });
      slider.addEventListener("change", refresh);
    }
  }

  update();
  return { refresh: update };
}

function renderHTML(r, alpha, lottery, latestPred) {
  const isDlt = lottery === "dlt";
  const expected = (1 - alpha) * 100;
  const observed = r.coverage != null ? r.coverage * 100 : null;
  const dev = observed != null ? Math.abs(observed - expected) : null;
  const ok = dev != null && dev < 6;

  const latestHtml = latestPred ? `
    <div class="card" style="margin-top:14px">
      <div class="card-title">在当前 α 下，下一期 ${(1 - alpha) * 100}% 覆盖集 <span class="card-num">${latestPred.size} 个号</span></div>
      <div class="balls" style="flex-wrap:wrap">
        ${latestPred.set.map((n) => `<span class="ball ${isDlt ? 'front' : 'red'}">${pad2(n)}</span>`).join("")}
      </div>
      <div class="hint">这个集合保证：在重复抽奖意义下，真号<strong>全部</strong>落在集合内的频率 ≥ ${(1 - alpha) * 100}%（前提是 calibration set 与 test set i.i.d.，对彩票成立）。换句话说，<strong>α=${alpha.toFixed(2)} 表示你愿意接受 ${(alpha * 100).toFixed(0)}% 的"全覆盖失败"风险来换更小的集合。</strong></div>
    </div>
  ` : "";

  return `
    <div class="conformal-controls">
      <div class="field">
        <label for="conformalAlpha">显著性水平 α</label>
        <input type="range" id="conformalAlpha" min="0.01" max="0.5" step="0.01" value="${alpha}" />
        <span id="conformalAlphaVal" class="mono">${alpha.toFixed(2)}</span>
      </div>
      <div class="fine muted">期望覆盖率 = 1 − α = <strong class="mono">${(1 - alpha).toFixed(2)}</strong></div>
    </div>

    <div class="card-group" style="margin-top:14px">
      <div class="card">
        <div class="card-title">校准 + 评估 <span class="card-num">split 50/50</span></div>
        <div class="diag-grid">
          <div class="diag-line"><span>校准期数</span><strong class="mono">${r.calN}</strong></div>
          <div class="diag-line"><span>评估期数</span><strong class="mono">${r.testN}</strong></div>
          <div class="diag-line"><span>共形阈值 q̂</span><strong class="mono">${r.qHat.toFixed(4)}</strong></div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">覆盖率验证 <span class="card-num">empirical</span></div>
        <div class="diag-grid">
          <div class="diag-line"><span>期望覆盖率</span><strong class="mono">${expected.toFixed(1)}%</strong></div>
          <div class="diag-line"><span>实际经验覆盖率</span><strong class="mono" style="color:${ok ? "var(--acid)" : "var(--red-2)"}">${observed != null ? `${observed.toFixed(1)}%` : "—"}</strong></div>
          <div class="diag-line"><span>偏离</span><strong class="mono">${dev != null ? `${dev.toFixed(1)} pp` : "—"} ${ok ? "<span class='chip chip-ok'>正常</span>" : "<span class='chip chip-warn'>注意</span>"}</strong></div>
          <div class="diag-line"><span>平均集合大小</span><strong class="mono">${r.avgSize != null ? r.avgSize.toFixed(1) : "—"} / ${isDlt ? 35 : 33}</strong></div>
        </div>
      </div>
    </div>

    ${latestHtml}

    <div class="callout" style="margin-top:14px">
      <div class="callout-title">为什么共形预测有意义</div>
      <div class="callout-body">
        点估计（top-K 选号）只给"我猜这 K 个"——没有覆盖率保证。<br/>
        概率校准（temperature scaling）改善了概率"锐度"——但仍是单点估计。<br/>
        <strong>共形预测</strong>给出"集合大小自适应、覆盖率有 finite-sample 保证"的预测集。
        它的代价：α 越小（保证越强），集合越大、信息量越低。
        <strong>α=0.5 时集合很小但只 50% 命中；α=0.05 时集合接近全集但 95% 全命中。</strong>
        滑动滑块感受这个权衡。
      </div>
    </div>
  `;
}
