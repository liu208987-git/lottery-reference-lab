import { $, $$, pad2, makeBall, createEl, clamp, parseNumList } from "./utils.js";
import { topN, bottomN, sumOf, oddCountOf, spanOf, zoneCounts } from "./stats.js";

/* =========================================================
   Tabs (with hash sync)
   ========================================================= */
export function setupTabs(onChange) {
  const tabs = $$(".tab");
  const panels = $$(".panel");

  const activate = (name, opts = {}) => {
    if (!tabs.some((t) => t.dataset.tab === name)) name = "overview";
    for (const t of tabs) {
      const active = t.dataset.tab === name;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
      t.tabIndex = active ? 0 : -1;
    }
    for (const p of panels) p.classList.toggle("is-active", p.dataset.panel === name);
    if (!opts.silent) {
      try { history.replaceState(null, "", `#${name}`); } catch (e) {}
    }
    if (onChange) onChange(name);
  };

  tabs.forEach((t, idx) => {
    t.addEventListener("click", () => activate(t.dataset.tab));
    t.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const next = tabs[(idx + dir + tabs.length) % tabs.length];
        next.focus();
        activate(next.dataset.tab);
      }
    });
  });

  // 初始 hash
  const initial = (location.hash || "").replace("#", "").trim();
  if (initial) activate(initial, { silent: true });

  // 监听 hash 变化（浏览器前进/后退）
  window.addEventListener("hashchange", () => {
    const name = (location.hash || "").replace("#", "").trim();
    if (name) activate(name, { silent: true });
  });

  return activate;
}

/* =========================================================
   Theme toggle
   ========================================================= */
export function setupTheme() {
  const btn = $("#btnTheme");
  if (!btn) return;
  const sun = $("#iconSun");
  const moon = $("#iconMoon");

  const apply = (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    if (sun && moon) {
      sun.style.display = theme === "light" ? "none" : "";
      moon.style.display = theme === "light" ? "" : "none";
    }
    try { localStorage.setItem("ssq-theme", theme); } catch (e) {}
  };

  const current = document.documentElement.getAttribute("data-theme") || "dark";
  apply(current);

  btn.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") || "dark";
    const next = cur === "light" ? "dark" : "light";
    apply(next);
    document.dispatchEvent(new CustomEvent("ssq:theme", { detail: { theme: next } }));
  });
}

/* =========================================================
   Hero / Latest
   ========================================================= */
export function renderLatest(draw) {
  $("#latestIssue").textContent = draw.issue;
  $("#latestDate").textContent = draw.date || "（无）";
  const wrap = $("#latestBalls");
  wrap.innerHTML = "";
  for (const r of draw.reds) wrap.appendChild(makeBall(r, "red"));
  const blueBall = makeBall(draw.blue, "blue");
  blueBall.classList.add("plus");
  wrap.appendChild(blueBall);
  $("#mLatest").textContent = draw.issue;
}

export function renderHeroMeta(meta, draws) {
  const n = Number(meta.count || draws.length) || draws.length;
  $("#mCount").textContent = n.toLocaleString();
  $("#mRange").textContent = `${draws[0].issue} – ${draws[draws.length - 1].issue}`;
}

/* =========================================================
   Rank (Top / Bottom)
   ========================================================= */
export function renderRank(el, pairs) {
  el.innerHTML = "";
  pairs.forEach(([num, val], i) => {
    const li = createEl("li", {
      html: `
        <span class="mono" style="color:var(--muted-3); width:18px; text-align:right">${i + 1}.</span>
        <span class="ball ${el.id?.includes("Blue") ? "blue" : "red"}" style="width:26px; height:26px; font-size:11px; box-shadow:none">${pad2(num)}</span>
        <span class="muted" style="margin-left:auto; font-family:var(--mono); font-size:12px">×&nbsp;<strong style="color:var(--text)">${val}</strong></span>
      `,
    });
    el.appendChild(li);
  });
}

/* =========================================================
   Data table
   ========================================================= */
export function renderTable(rows, note) {
  const tbody = $("#tbody");
  tbody.innerHTML = "";
  if (rows.length === 0) {
    tbody.appendChild(createEl("tr", {
      html: `<td colspan="4" class="muted" style="text-align:center; padding:24px">没有匹配的数据。</td>`,
    }));
  }
  for (const d of rows) {
    const reds = d.reds.map((x) => `<span class="red-num">${pad2(x)}</span>`).join("&nbsp;&nbsp;");
    const tr = createEl("tr", {
      html: `
        <td class="mono">${d.issue}</td>
        <td class="mono muted">${d.date || ""}</td>
        <td>${reds}</td>
        <td><span class="blue-num">${pad2(d.blue)}</span></td>
      `,
    });
    tbody.appendChild(tr);
  }
  $("#dataFootnote").textContent = note || "";
}

/* =========================================================
   Insight chips
   ========================================================= */
export function renderInsightChips({ freqRecentRed, missRed, missBlue, chiSquareRed, chiSquareBlue } = {}) {
  const chips = $("#insightChips");
  chips.innerHTML = "";
  const items = [
    { k: "近期红热", v: topN(freqRecentRed, 3, 33).map(([n, v]) => `${pad2(n)}·${v}`).join(" / "), kind: "warn" },
    { k: "近期红冷", v: bottomN(freqRecentRed, 3, 33).map(([n, v]) => `${pad2(n)}·${v}`).join(" / "), kind: "" },
    { k: "红高遗漏", v: topN(missRed, 3, 33).map(([n, v]) => `${pad2(n)}·${v}`).join(" / "), kind: "" },
    { k: "蓝高遗漏", v: topN(missBlue, 2, 16).map(([n, v]) => `${pad2(n)}·${v}`).join(" / "), kind: "" },
  ];

  // 增强：χ² 显著异常号
  if (chiSquareRed) {
    const hot = [];
    const cold = [];
    for (let i = 1; i <= 33; i++) {
      const s = chiSquareRed.stats[i];
      if (!s) continue;
      if (s.isSignificantBonferroni) {
        if (s.direction === "hot") hot.push([i, s.zScore]);
        else if (s.direction === "cold") cold.push([i, s.zScore]);
      }
    }
    hot.sort((a, b) => b[1] - a[1]);
    cold.sort((a, b) => a[1] - b[1]);
    const fmtChi = (arr) => arr.length === 0 ? "—" : arr.slice(0, 3).map(([n, z]) => `${pad2(n)}·z=${z.toFixed(1)}`).join(" / ");
    items.push({
      k: `红 χ² 严格热（Bonferroni p<${chiSquareRed.summary.bonferroniAlpha.toFixed(4)}）`,
      v: fmtChi(hot),
      kind: hot.length > 0 ? "warn" : "",
    });
    items.push({
      k: "红 χ² 严格冷",
      v: fmtChi(cold),
      kind: "",
    });
  }
  if (chiSquareBlue) {
    const hot = [];
    const cold = [];
    for (let i = 1; i <= 16; i++) {
      const s = chiSquareBlue.stats[i];
      if (!s) continue;
      if (s.isSignificant) {
        if (s.direction === "hot") hot.push([i, s.zScore]);
        else if (s.direction === "cold") cold.push([i, s.zScore]);
      }
    }
    hot.sort((a, b) => b[1] - a[1]);
    cold.sort((a, b) => a[1] - b[1]);
    const fmtChi = (arr) => arr.length === 0 ? "—" : arr.slice(0, 3).map(([n, z]) => `${pad2(n)}·z=${z.toFixed(1)}`).join(" / ");
    items.push({
      k: `蓝 χ² 显著热（α=0.05）`,
      v: fmtChi(hot),
      kind: hot.length > 0 ? "warn" : "",
    });
    items.push({
      k: "蓝 χ² 显著冷",
      v: fmtChi(cold),
      kind: "",
    });
  }

  for (const it of items) {
    const cls = it.kind ? `chip chip-${it.kind}` : "chip";
    chips.appendChild(createEl("div", { cls, html: `${it.k} <strong>${it.v}</strong>` }));
  }
}

/* =========================================================
   Ticket helpers
   ========================================================= */
export function ticketLabel(reds) {
  const z = zoneCounts(reds).join(":");
  return `和值 ${sumOf(reds)} · 奇数 ${oddCountOf(reds)} · 跨度 ${spanOf(reds)} · 三区 ${z}`;
}

export function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    resolve();
  });
}

export function formatTicketLine(ticket) {
  return `${ticket.reds.map(pad2).join(" ")} + ${pad2(ticket.blue)}`;
}

export function renderTickets(tickets, diagnostics) {
  const wrap = $("#results");
  wrap.innerHTML = "";
  if (tickets.length === 0) {
    const lines = ["没有生成成功：约束过严或窗口过小。"];
    if (diagnostics && diagnostics.failureReasons) {
      const entries = Object.entries(diagnostics.failureReasons).sort((a, b) => b[1] - a[1]);
      if (entries.length) {
        lines.push(`尝试 ${diagnostics.tries} 次，失败原因 Top：`);
        for (const [reason, cnt] of entries.slice(0, 3)) lines.push(`· ${reason}（${cnt}）`);
      }
    }
    wrap.appendChild(createEl("div", { cls: "fine muted", html: lines.join("<br/>") }));
    return;
  }
  tickets.forEach((t, idx) => {
    const meta = createEl("div", {
      cls: "meta",
      html: `<strong style="color:var(--text); font-weight:600">#${pad2(idx + 1)}</strong> · ${ticketLabel(t.reds)}`,
    });
    const nums = createEl("div", { cls: "nums" });
    for (const r of t.reds) nums.appendChild(makeBall(r, "red"));
    const blueBall = makeBall(t.blue, "blue");
    blueBall.classList.add("plus");
    nums.appendChild(blueBall);

    const copyBtn = createEl("button", {
      cls: "btn ghost btn-copy",
      text: "复制",
      attrs: { type: "button", "aria-label": `复制第 ${idx + 1} 注` },
    });
    copyBtn.addEventListener("click", async () => {
      await copyToClipboard(formatTicketLine(t));
      const original = copyBtn.textContent;
      copyBtn.textContent = "已复制";
      copyBtn.disabled = true;
      setTimeout(() => {
        copyBtn.textContent = original;
        copyBtn.disabled = false;
      }, 1200);
    });

    const right = createEl("div", { cls: "ticket-right" }, [nums, copyBtn]);
    const row = createEl("div", { cls: "ticket" }, [meta, right]);
    wrap.appendChild(row);
  });
}

/* =========================================================
   Banners
   ========================================================= */
export function showLoadError(message) {
  const shell = $(".shell");
  const card = createEl("div", {
    cls: "card",
    html: `
      <div class="card-title">加载失败</div>
      <div class="fine">无法加载数据。建议用本地 HTTP 方式打开，例如：</div>
      <pre class="mono fine" style="margin:10px 0 0; padding:10px 12px; background:var(--surface); border-radius:10px; border:1px solid var(--stroke); white-space:pre-wrap">python -m http.server 8000</pre>
      <div class="fine muted" style="margin-top:8px">${message}</div>
    `,
  });
  shell.prepend(card);
}

export function showDataSourceBanner(source, fetchError) {
  if (source !== "embedded") return;
  const shell = $(".shell");
  if (shell.querySelector(".banner-embedded")) return;
  const banner = createEl("div", {
    cls: "card banner-embedded",
    html: `
      <div class="card-title">提示：正在使用内置数据</div>
      <div class="fine">当前通过 <span class="mono">window.__SSQ_DATA__</span> 兜底加载。<br/>
        原因：<span class="mono">${(fetchError && fetchError.message) || "无法 fetch draws.json"}</span>。
        建议用 <span class="mono">python -m http.server 8000</span> 打开以获得最新数据。</div>
    `,
  });
  shell.prepend(banner);
}

/* =========================================================
   Refresh button (icon-btn)
   ========================================================= */
export function setRefreshLoading(loading) {
  const btn = $("#btnRefresh");
  if (!btn) return;
  btn.disabled = loading;
  btn.classList.toggle("is-loading", loading);
  btn.setAttribute("aria-label", loading ? "加载中" : "重新加载数据");
}

/* =========================================================
   Generator config readers
   ========================================================= */
export function readWinSize() {
  return clamp(Number($("#winSize").value || 200), 20, 1000);
}

export function readGeneratorConfig() {
  return {
    strategyRed: $("#strategyRed").value,
    strategyBlue: $("#strategyBlue").value,
    optimize: $("#optimizeMode")?.value || "none",
    alpha: clamp(Number($("#alpha").value || 0) / 100, 0, 2),
    count: clamp(Number($("#genN").value || 1), 1, 20),
    constraints: {
      sum: $("#cSum").checked,
      odd: $("#cOdd").checked,
      span: $("#cSpan").checked,
      zone: $("#cNo4SameZone").checked,
      ac: $("#cAC")?.checked || false,
      noConsec: $("#cNoConsec")?.checked || false,
    },
    includeRed: parseNumList($("#includeRed")?.value, 1, 33),
    excludeRed: parseNumList($("#excludeRed")?.value, 1, 33),
    excludeBlue: parseNumList($("#excludeBlue")?.value, 1, 16),
    avoidLast: $("#cAvoidLast")?.checked || false,
  };
}

export function showGenError(message) {
  const wrap = $("#results");
  wrap.innerHTML = "";
  wrap.appendChild(createEl("div", {
    cls: "fine",
    html: `<span class="chip chip-warn">${message}</span>`,
  }));
}

export function setGenDiagnostics(text) {
  const el = $("#genDiag");
  if (!el) return;
  el.textContent = text || "";
}

/* =========================================================
   Manual ticket analysis
   ========================================================= */
export function renderTicketAnalysis(result) {
  const el = $("#ticketAnalysis");
  if (!el) return;
  if (result.error) {
    el.innerHTML = `<span class="chip chip-warn">${result.error}</span>`;
    return;
  }

  const metrics = [
    ["和值", result.sum],
    ["跨度", result.span],
    ["奇偶", result.oddEven],
    ["大小", result.bigSmall],
    ["质合", result.primeComposite],
    ["012 路", result.path012],
    ["三区", result.zone],
    ["AC 值", result.ac],
    ["连号组", result.consecutiveGroups],
    ["最大同尾", result.maxSameTail],
  ];
  const hitText = result.historyHits.length
    ? result.historyHits.map((d) => `${d.issue}${d.date ? ` · ${d.date}` : ""}`).join(" / ")
    : "历史上从未完整出现过";

  // 单注精确中奖率（这是与单注 SSQ 标准相同的——胆拖 D=0 T=6 B=1）
  let prizeBlock = "";
  if (result.prizeAnalysis) {
    const p = result.prizeAnalysis;
    const lvRows = p.byLevel.map((b) => `
      <tr>
        <td class="fine">${b.label}</td>
        <td class="mono fine">1 / ${Math.round(b.expectedTickets > 0 ? 1 / b.expectedTickets : Infinity).toLocaleString()}</td>
        <td class="mono fine">${b.prize.toLocaleString()}</td>
      </tr>
    `).join("");
    prizeBlock = `
      <div class="card-title fine" style="margin-top:14px">单注中奖率（精确组合数）</div>
      <div class="diag-grid">
        <div class="diag-line"><span>至少中一注奖</span><strong class="mono" style="color:var(--gold)">${(p.pAtLeastOneAny * 100).toFixed(2)}%（约 1 / ${Math.round(1 / p.pAtLeastOneAny)}）</strong></div>
        <div class="diag-line"><span>期望回报率</span><strong class="mono">${(p.payoutRatio * 100).toFixed(1)}%</strong></div>
        <div class="diag-line"><span>期望净利</span><strong class="mono" style="color:var(--red-2)">${p.netEv.toFixed(3)} 元</strong></div>
      </div>
      <details style="margin-top:8px">
        <summary class="fine muted" style="cursor:pointer">展开 6 奖级精确表</summary>
        <table class="table mini" style="margin-top:6px">
          <thead><tr><th class="fine">奖级</th><th class="fine">中奖几率</th><th class="fine">奖金</th></tr></thead>
          <tbody>${lvRows}</tbody>
        </table>
      </details>
    `;
  }

  el.innerHTML = `
    <div class="balls" style="margin-bottom:12px">
      ${result.reds.map((r) => `<span class="ball red" style="width:32px;height:32px;font-size:12px">${pad2(r)}</span>`).join("")}
      <span class="ball blue plus" style="width:32px;height:32px;font-size:12px">${pad2(result.blue)}</span>
    </div>
    <div class="analysis-grid">
      ${metrics.map(([k, v]) => `<div class="metric-line"><span>${k}</span><strong>${v}</strong></div>`).join("")}
    </div>
    ${prizeBlock}
    <div class="callout">
      <div class="callout-title">历史对照</div>
      <div class="callout-body">
        与最新期红球重复 <strong>${result.repeatReds.length}</strong> 个${result.repeatReds.length ? `（${result.repeatReds.map(pad2).join(" ")}）` : ""}；蓝球${result.repeatBlue ? "重复" : "未重复"}。<br/>
        ${hitText}。历史未出现不代表更可能出现。
      </div>
    </div>
  `;
}

/* =========================================================
   Toast
   ========================================================= */
export function toast(message, ms = 1800) {
  const host = $("#toastHost");
  if (!host) return;
  const el = createEl("div", { cls: "toast", text: message });
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
  }, ms);
}
