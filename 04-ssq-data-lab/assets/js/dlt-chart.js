// 大乐透频次/遗漏柱状图（DLT 调色板版本）
//
// 复刻自 chart.js renderBars，但 mode 扩展支持：
//   "front"      → 大乐透前区，绿色渐变
//   "back"       → 大乐透后区，紫色渐变
//   "front-miss" / "back-miss" → 遗漏（acid 黄）

import { pad2 } from "./utils.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, String(v));
  }
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

function ensureTooltip(container) {
  let tip = container.querySelector(".chart-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.setAttribute("role", "tooltip");
    container.appendChild(tip);
  }
  return tip;
}

function readVar(name, fallback) {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function dltPalette(mode) {
  if (mode === "back") {
    const c = readVar("--dlt-back", "#d6a8ff");
    const c2 = readVar("--dlt-back-2", "#e8c8ff");
    return { fillTop: c2, fillBot: c, fillBotOpacity: 0.18, stroke: c, strokeOpacity: 0.5,
             glow: c, track: "rgba(214, 168, 255, 0.05)" };
  }
  if (mode === "front-miss" || mode === "back-miss") {
    const c = readVar("--acid", "#c8ff4d");
    const c2 = readVar("--acid-2", "#e2ff8c");
    return { fillTop: c2, fillBot: c, fillBotOpacity: 0.10, stroke: c, strokeOpacity: 0.45,
             glow: c, track: "rgba(200, 255, 77, 0.05)" };
  }
  // front (default)
  const c = readVar("--dlt-front", "#5dd9b8");
  const c2 = readVar("--dlt-front-2", "#88e8cd");
  return { fillTop: c2, fillBot: c, fillBotOpacity: 0.18, stroke: c, strokeOpacity: 0.55,
           glow: c, track: "rgba(93, 217, 184, 0.05)" };
}

function niceCeil(maxV) {
  if (maxV <= 0) return 1;
  const exp = Math.floor(Math.log10(maxV));
  const base = Math.pow(10, exp);
  const m = maxV / base;
  let nice;
  if (m <= 1) nice = 1;
  else if (m <= 2) nice = 2;
  else if (m <= 2.5) nice = 2.5;
  else if (m <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

export function renderDltBars(container, values, size, mode = "front", { unit = "次" } = {}) {
  container.innerHTML = "";
  container.style.position = "relative";
  const tip = ensureTooltip(container);

  const W = container.clientWidth || 520;
  const H = container.clientHeight || 200;
  const padL = 26;
  const padR = 12;
  const padTop = 12;
  const padBot = 24;
  const innerW = W - padL - padR;
  const innerH = H - padTop - padBot;
  const gap = Math.max(2, Math.min(4, innerW / size / 6));
  const barW = Math.max(3, (innerW - gap * (size - 1)) / size);

  const vs = values.slice(1, size + 1);
  const rawMax = Math.max(1, ...vs);
  const niceMax = niceCeil(rawMax);
  const colors = dltPalette(mode);

  const svg = el("svg", {
    class: "chart-svg",
    viewBox: `0 0 ${W} ${H}`,
    width: "100%",
    height: "100%",
    preserveAspectRatio: "none",
    role: "img",
    "aria-label": `bar chart of ${size} numbers`,
  });

  const defs = el("defs");
  const gradId = `dlt-grad-${mode}-${Math.random().toString(36).slice(2, 7)}`;
  const grad = el("linearGradient", { id: gradId, x1: "0", x2: "0", y1: "0", y2: "1" });
  grad.appendChild(el("stop", { offset: "0%", "stop-color": colors.fillTop, "stop-opacity": 1 }));
  grad.appendChild(el("stop", { offset: "100%", "stop-color": colors.fillBot, "stop-opacity": colors.fillBotOpacity }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = (niceMax * t) / ticks;
    const y = padTop + innerH - (innerH * t) / ticks;
    svg.appendChild(el("line", {
      x1: padL, x2: W - padR, y1: y, y2: y,
      stroke: t === 0 ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.05)",
      "stroke-dasharray": t === 0 ? "" : "2 4",
    }));
    if (t > 0) {
      const tx = el("text", {
        x: padL - 6, y: y + 3,
        "text-anchor": "end",
        "font-size": "9",
        "font-family": "JetBrains Mono, ui-monospace, Menlo, monospace",
        fill: "rgba(255,255,255,.32)",
      });
      tx.textContent = String(Math.round(v));
      svg.appendChild(tx);
    }
  }

  const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
  const meanY = padTop + innerH - (mean / niceMax) * innerH;
  svg.appendChild(el("line", {
    x1: padL, x2: W - padR, y1: meanY, y2: meanY,
    stroke: colors.glow, "stroke-opacity": 0.45, "stroke-dasharray": "1 3",
  }));

  for (let i = 0; i < size; i++) {
    const v = vs[i];
    const h = niceMax === 0 ? 0 : Math.round((v / niceMax) * innerH);
    const x = padL + i * (barW + gap);
    const y = padTop + innerH - h;

    svg.appendChild(el("rect", {
      x, y: padTop, width: barW, height: innerH,
      rx: 2, ry: 2, fill: colors.track,
    }));

    const bar = el("rect", {
      x, y, width: barW, height: Math.max(1, h),
      rx: 2, ry: 2,
      fill: `url(#${gradId})`,
      stroke: colors.stroke,
      "stroke-opacity": colors.strokeOpacity,
      "stroke-width": 0.6,
      "data-idx": i + 1,
      "data-val": v,
      class: "chart-bar",
    });
    svg.appendChild(bar);

    if ((i + 1) % 5 === 0 || i === 0 || i === size - 1) {
      const label = el("text", {
        x: x + barW / 2,
        y: H - 8,
        "text-anchor": "middle",
        "font-size": "9.5",
        "font-family": "JetBrains Mono, ui-monospace, Menlo, monospace",
        fill: "rgba(255,255,255,.42)",
      });
      label.textContent = pad2(i + 1);
      svg.appendChild(label);
    }
  }

  container.appendChild(svg);

  const onMove = (ev) => {
    const target = ev.target;
    if (!(target instanceof SVGRectElement)) {
      tip.style.opacity = "0";
      return;
    }
    const idx = target.getAttribute("data-idx");
    const val = target.getAttribute("data-val");
    if (!idx) {
      tip.style.opacity = "0";
      return;
    }
    const pct = (Number(val) / Math.max(1, mean)) * 100 - 100;
    const cmp = pct >= 0 ? `+${pct.toFixed(0)}%` : `${pct.toFixed(0)}%`;
    tip.innerHTML = `<strong>${pad2(Number(idx))}</strong> · ${val} ${unit} <span style="color:rgba(255,255,255,.5)"> ${cmp} 均值</span>`;
    tip.style.opacity = "1";
    const rect = container.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const tipW = tip.offsetWidth || 120;
    const left = Math.min(rect.width - tipW - 8, Math.max(8, x + 12));
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(6, y - 32)}px`;
  };
  svg.addEventListener("mousemove", onMove);
  svg.addEventListener("mouseleave", () => { tip.style.opacity = "0"; });
}
