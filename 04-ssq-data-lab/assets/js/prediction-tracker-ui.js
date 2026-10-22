// 预测追踪 UI 渲染器：把 prediction-history.js 的数据转成卡片
//
// 特性：
//   - 自动 settle（用 draws 比对）
//   - 总结：N 条已结算 / 平均红命中 / 平均蓝命中 / baseline 对比 / z-score
//   - 直方图：红命中数 0..K 分布 + 期望（二项分布参考）
//   - 列表：最近 20 条（命中/未命中颜色区分）
//   - 操作：刷新 / 导出 CSV / 清空

import * as predictionHistory from "./prediction-history.js";
import { BASELINES } from "./lottery-config.js";
import { pad2 } from "./utils.js";

/**
 * 主入口：渲染预测追踪面板到目标容器。
 * @param containerEl  HTMLElement
 * @param lottery       "ssq" | "dlt"
 * @param draws         全部历史 draws（用来 settle）
 * @returns             { refresh, summary } 暴露刷新方法
 */
export function renderTrackerPanel(containerEl, lottery, draws) {
  if (!containerEl) return null;

  function update() {
    // 1. 先用最新 draws settle 一遍
    predictionHistory.settle(draws, lottery);
    const baselines = lottery === "ssq"
      ? { redExp: BASELINES.ssq.redHit6, redVar: 0.5, blueExp: BASELINES.ssq.blueAcc, blueVar: 0.06 }
      : { redExp: BASELINES.dlt.frontHit5, redVar: 0.5, blueExp: BASELINES.dlt.backHit2, blueVar: 0.3 };
    const s = predictionHistory.summary(lottery, baselines);
    containerEl.innerHTML = renderHTML(s, predictionHistory.list(lottery), lottery);
    bind(containerEl, lottery, draws, update);
  }

  update();
  return { refresh: update };
}

function renderHTML(summary, recent, lottery) {
  const isDlt = lottery === "dlt";
  const redLabel = isDlt ? "前区命中" : "红球命中";
  const blueLabel = isDlt ? "后区命中" : "蓝球命中";
  const K = summary.consistentK || (isDlt ? "5-2" : "6-1");

  if (summary.totalSettled === 0) {
    const total = summary.totalUnsettled || 0;
    if (total === 0) {
      return `<div class="callout"><div class="callout-title">还没有预测记录</div><div class="callout-body">点击「下一期预测」生成预测后会自动记录到这里。等到那期开奖后，点「刷新」会自动比对真号填命中数。</div></div>`;
    }
    return `<div class="callout"><div class="callout-title">${total} 条预测等待开奖</div><div class="callout-body">这些期还没开奖，无法比对命中数。开奖后点「刷新」自动结算。</div></div>${renderActions(false)}`;
  }

  const baseRedExp = summary.baseline.redExp;
  const baseBlueExp = summary.baseline.blueExp;
  const verdict = (z) => {
    if (z == null) return "";
    if (Math.abs(z) < 1.96) return `<span class="chip chip-ok">与基线不可区分（|z| &lt; 1.96）</span>`;
    if (z > 0) return `<span class="chip chip-warn">显著高于基线（z=${z.toFixed(2)}）</span>`;
    return `<span class="chip chip-warn">显著低于基线（z=${z.toFixed(2)}）</span>`;
  };

  const redK = isDlt ? 5 : 6;
  const blueK = isDlt ? 2 : 1;

  return `
    <div class="tracker-summary">
      <div class="tracker-stat">
        <div class="tracker-stat-num mono">${summary.totalSettled}</div>
        <div class="fine muted">已结算预测</div>
      </div>
      <div class="tracker-stat">
        <div class="tracker-stat-num mono">${summary.totalUnsettled}</div>
        <div class="fine muted">等待开奖</div>
      </div>
      <div class="tracker-stat">
        <div class="tracker-stat-num mono">${K}</div>
        <div class="fine muted">K 配置</div>
      </div>
    </div>

    <div class="card-group">
      <div class="card tracker-metric">
        <div class="card-title">${redLabel}（top-${redK}）</div>
        <div class="diag-grid">
          <div class="diag-line"><span>实际平均</span><strong class="mono">${summary.avgRedHit.toFixed(3)}</strong></div>
          <div class="diag-line"><span>i.i.d. 期望</span><strong class="mono">${baseRedExp.toFixed(3)}</strong></div>
          <div class="diag-line"><span>差值</span><strong class="mono" style="color:${summary.avgRedHit > baseRedExp ? "var(--acid)" : "var(--red-2)"}">${(summary.avgRedHit - baseRedExp >= 0 ? "+" : "")}${(summary.avgRedHit - baseRedExp).toFixed(3)}</strong></div>
          <div class="diag-line"><span>统计判断</span><strong>${verdict(summary.zRed)}</strong></div>
        </div>
        ${renderHistogram(summary.redDist, summary.totalSettled, isDlt ? 5 : 6, baseRedExp)}
      </div>
      <div class="card tracker-metric">
        <div class="card-title">${blueLabel}（top-${blueK}）</div>
        <div class="diag-grid">
          <div class="diag-line"><span>实际平均</span><strong class="mono">${summary.avgBlueHit.toFixed(3)}</strong></div>
          <div class="diag-line"><span>i.i.d. 期望</span><strong class="mono">${baseBlueExp.toFixed(3)}</strong></div>
          <div class="diag-line"><span>差值</span><strong class="mono" style="color:${summary.avgBlueHit > baseBlueExp ? "var(--acid)" : "var(--red-2)"}">${(summary.avgBlueHit - baseBlueExp >= 0 ? "+" : "")}${(summary.avgBlueHit - baseBlueExp).toFixed(3)}</strong></div>
          <div class="diag-line"><span>统计判断</span><strong>${verdict(summary.zBlue)}</strong></div>
        </div>
        ${renderHistogram(summary.blueDist, summary.totalSettled, blueK, baseBlueExp)}
      </div>
    </div>

    ${renderRecentList(recent.slice(0, 20), lottery)}

    ${renderActions(true)}

    <div class="callout" style="margin-top:14px">
      <div class="callout-title">如何解读</div>
      <div class="callout-body">
        <strong>这是项目最重要的诚实工具</strong>：你做的每次预测都被持续追踪，开奖后自动比对真号。
        如果"实际平均"在 30+ 次后仍与"i.i.d. 期望"不可区分（|z| &lt; 1.96），那就是 walk-forward 回测结论的<strong>真实部署验证</strong>——
        预测器没法系统性高于随机基线。这正是测度论的预言。
      </div>
    </div>
  `;
}

function renderHistogram(dist, total, kMax, expectedMean) {
  if (!dist || dist.length === 0) return "";
  // 横向条：每个 bin 显示 0..kMax，count，百分比
  const map = new Map(dist.map((d) => [d.hit, d.count]));
  const rows = [];
  const maxCount = Math.max(...dist.map((d) => d.count));
  for (let h = 0; h <= kMax; h++) {
    const c = map.get(h) || 0;
    const pct = total > 0 ? (c / total) * 100 : 0;
    const w = maxCount > 0 ? (c / maxCount) * 100 : 0;
    rows.push(`
      <div class="tracker-hist-row">
        <span class="tracker-hist-label mono">${h}</span>
        <span class="tracker-hist-bar"><i style="width:${w.toFixed(1)}%"></i></span>
        <span class="tracker-hist-val mono">${c} (${pct.toFixed(1)}%)</span>
      </div>
    `);
  }
  return `
    <div class="tracker-hist">
      <div class="fine muted" style="margin-bottom:6px">命中数分布（期望均值 ${expectedMean.toFixed(2)}）</div>
      ${rows.join("")}
    </div>
  `;
}

function renderRecentList(records, lottery) {
  if (records.length === 0) return "";
  const isDlt = lottery === "dlt";
  const rows = records.map((r) => {
    const settled = r.settled;
    const redHitColor = (h, K) => h == null ? "var(--text-2)" : h >= Math.ceil(K * 0.6) ? "var(--acid)" : h >= 1 ? "var(--gold)" : "var(--text-2)";
    const blueHitColor = redHitColor;
    const redK = r.K?.reds || (isDlt ? 5 : 6);
    const blueK = r.K?.blue || (isDlt ? 2 : 1);
    const date = (r.createdAt || "").slice(5, 16).replace("T", " ");
    const balls = (arr, kind) => (arr || []).map((n) => `<span class="ball ${kind}" style="width:22px;height:22px;font-size:9.5px;box-shadow:none">${pad2(n)}</span>`).join("");
    const realBalls = settled
      ? balls(isDlt ? r.realReds : r.realReds, isDlt ? "front" : "red") + balls(isDlt ? r.realBlue : r.realBlue, isDlt ? "back" : "blue")
      : `<span class="muted fine">未开奖</span>`;
    const hitInfo = settled
      ? `<span class="mono" style="color:${redHitColor(r.redHit, redK)}">${r.redHit}/${redK}</span> · <span class="mono" style="color:${blueHitColor(r.blueHit, blueK)}">${r.blueHit}/${blueK}</span>`
      : `<span class="muted fine">—</span>`;
    return `
      <tr class="${settled ? "" : "row-pending"}">
        <td class="mono fine">${r.targetIssue}</td>
        <td class="fine muted">${date}</td>
        <td>
          <div class="tracker-balls">${balls(r.topReds, isDlt ? "front" : "red")}${balls(r.topBlue, isDlt ? "back" : "blue")}</div>
        </td>
        <td>${realBalls}</td>
        <td>${hitInfo}</td>
      </tr>
    `;
  }).join("");
  return `
    <div class="card" style="margin-top:14px">
      <div class="card-title">最近 ${records.length} 条 <span class="card-num">recent</span></div>
      <div class="bt-table-wrap">
        <table class="table tracker-table">
          <thead><tr>
            <th>目标期</th><th>预测时间</th><th>预测号</th><th>真号</th><th>命中</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderActions(hasData) {
  return `
    <div class="tracker-actions">
      <button class="btn primary btn-sm" data-tracker-act="refresh" type="button">🔄 刷新（重新结算）</button>
      ${hasData ? `<button class="btn ghost btn-sm" data-tracker-act="export" type="button">📥 导出 CSV</button>` : ""}
      ${hasData ? `<button class="btn ghost btn-sm" data-tracker-act="clear" type="button" style="color:var(--red-2)">🗑️ 清空</button>` : ""}
    </div>
  `;
}

function bind(container, lottery, draws, refresh) {
  container.querySelectorAll("[data-tracker-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const act = btn.dataset.trackerAct;
      if (act === "refresh") refresh();
      else if (act === "clear") {
        if (confirm(`清空 ${lottery.toUpperCase()} 的所有预测记录？`)) {
          predictionHistory.clear(lottery);
          refresh();
        }
      } else if (act === "export") {
        exportCsv(lottery);
      }
    });
  });
}

function exportCsv(lottery) {
  const recs = predictionHistory.list(lottery).reverse();  // 时间正序
  const header = ["targetIssue", "createdAt", "modelType", "topReds", "topBlue", "settled", "realReds", "realBlue", "redHit", "blueHit"];
  const rows = recs.map((r) => [
    r.targetIssue,
    r.createdAt || "",
    r.modelType || "",
    (r.topReds || []).join(" "),
    (r.topBlue || []).join(" "),
    r.settled ? "1" : "0",
    (r.realReds || []).join(" "),
    (r.realBlue || []).join(" "),
    r.redHit ?? "",
    r.blueHit ?? "",
  ]);
  const csv = [header.join(","), ...rows.map((r) => r.map((x) => `"${String(x).replaceAll('"', '""')}"`).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${lottery}-prediction-history-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
