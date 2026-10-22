// 复用的 explainer card 渲染器（SSQ + DLT 共用）
//
// 输入：诊断结果 + 颜色主色（SSQ 用 acid，DLT 用 dlt-front）
// 副作用：把 .explainer-card 插入到 container（替换已有的）

export function renderExplainerCard({ container, diag, primaryColor = "var(--acid)" }) {
  if (!container) return;
  container.querySelector(".explainer-card")?.remove();

  const lvl = diag.healthLevel;
  const colorVar = lvl.color === "green" ? primaryColor
    : lvl.color === "amber" ? "var(--gold)"
    : "var(--red-2)";

  const dimsHtml = diag.dimensions.map((d) => {
    const dColor = d.score >= 75 ? primaryColor : d.score >= 50 ? "var(--gold)" : "var(--red-2)";
    return `
      <div class="explainer-dim">
        <div class="explainer-dim-head">
          <span class="explainer-dim-icon">${d.icon}</span>
          <strong>${d.name}</strong>
          <span class="mono" style="margin-left:auto;color:${dColor}">${d.score}</span>
        </div>
        <div class="explainer-dim-bar"><i style="width:${d.score}%;background:${dColor}"></i></div>
        <div class="fine muted explainer-dim-reason">${d.reasons.map((r) => `• ${escapeText(r)}`).join("<br>")}</div>
      </div>
    `;
  }).join("");

  const card = document.createElement("div");
  card.className = "explainer-card card";
  card.style.marginTop = "14px";
  card.innerHTML = `
    <div class="explainer-head">
      <div class="explainer-score" style="border-color:${colorVar};color:${colorVar}">
        <strong>${diag.totalScore}</strong>
        <span class="fine muted">/100</span>
      </div>
      <div class="explainer-meta">
        <div class="card-title">号码体检 <span class="card-num">六维度评分</span></div>
        <div style="margin-top:4px">${lvl.emoji} <strong style="color:${colorVar}">${lvl.label}</strong></div>
      </div>
    </div>
    <div class="explainer-grid">${dimsHtml}</div>
    <div class="callout" style="margin-top:12px">
      <div class="callout-body" style="white-space:pre-wrap">${escapeText(diag.advice)}</div>
    </div>
  `;
  container.appendChild(card);
}

function escapeText(s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
