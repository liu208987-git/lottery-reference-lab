// 时序观察：把每期开奖的"摘要指标"提取成一条时间序列
//
// 用法：renderTimeSeriesChart(container, draws, "sum") -> SVG 折线 + 移动均线
// 支持指标：
//   sum   - 红球和值
//   span  - 跨度
//   ac    - AC 值
//   odd   - 奇数个数（0..6）
//   blue  - 蓝球号码

import { sumOf, spanOf, acValueOf, oddCountOf } from "./stats.js";
import { pad2 } from "./utils.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const SPECS = {
  sum: { label: "和值", min: 21, max: 183, color: "--red", fmt: (v) => v },
  span: { label: "跨度", min: 5, max: 32, color: "--gold", fmt: (v) => v },
  ac: { label: "AC 值", min: 0, max: 10, color: "--plum", fmt: (v) => v },
  odd: { label: "奇数个数", min: 0, max: 6, color: "--blue", fmt: (v) => v },
  blue: { label: "蓝球", min: 1, max: 16, color: "--blue", fmt: pad2 },
};

function metricOf(draw, kind) {
  if (kind === "sum") return sumOf(draw.reds);
  if (kind === "span") return spanOf(draw.reds);
  if (kind === "ac") return acValueOf(draw.reds);
  if (kind === "odd") return oddCountOf(draw.reds);
  if (kind === "blue") return draw.blue;
  return 0;
}

function readVar(name, fallback) {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, String(v));
  }
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

export function movingAverage(values, window) {
  if (window <= 1) return values.slice();
  const out = Array(values.length).fill(0);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    const w = Math.min(i + 1, window);
    out[i] = sum / w;
  }
  return out;
}

export function buildSeries(draws, kind) {
  return draws.map((d) => metricOf(d, kind));
}

export function renderTimeSeries(container, draws, kind, { window = 30 } = {}) {
  container.innerHTML = "";
  if (!draws.length) return;

  const spec = SPECS[kind] || SPECS.sum;
  const values = buildSeries(draws, kind);
  const ma = movingAverage(values, window);
  const expected = values.reduce((a, b) => a + b, 0) / values.length;

  const W = container.clientWidth || 600;
  const H = container.clientHeight || 180;
  const padL = 36;
  const padR = 12;
  const padT = 12;
  const padB = 22;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const yMin = Math.min(spec.min, ...values);
  const yMax = Math.max(spec.max, ...values);
  const yScale = (v) => padT + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;
  const xScale = (i) => padL + (i / Math.max(1, values.length - 1)) * innerW;

  const accent = readVar(spec.color, "#ff4757");
  const muted = "rgba(255,255,255,.45)";

  const svg = el("svg", {
    class: "ts-svg",
    viewBox: `0 0 ${W} ${H}`,
    width: "100%",
    height: "100%",
    preserveAspectRatio: "none",
    role: "img",
    "aria-label": `${spec.label} time series`,
  });

  // 期望值参考线
  const yE = yScale(expected);
  svg.appendChild(el("line", {
    x1: padL, x2: W - padR, y1: yE, y2: yE,
    stroke: muted, "stroke-dasharray": "1 4", "stroke-opacity": "0.6",
  }));
  const labelE = el("text", {
    x: padL - 4, y: yE + 3,
    "text-anchor": "end", "font-size": "9.5",
    fill: muted, "font-family": "JetBrains Mono, monospace",
  });
  labelE.textContent = `μ ${expected.toFixed(1)}`;
  svg.appendChild(labelE);

  // 原始值散点（半透明）
  const pts = values.map((v, i) => `${xScale(i).toFixed(2)},${yScale(v).toFixed(2)}`).join(" ");
  svg.appendChild(el("polyline", {
    points: pts, fill: "none",
    stroke: accent, "stroke-opacity": "0.16", "stroke-width": "1",
  }));

  // 移动均线
  const mPts = ma.map((v, i) => `${xScale(i).toFixed(2)},${yScale(v).toFixed(2)}`).join(" ");
  svg.appendChild(el("polyline", {
    points: mPts, fill: "none",
    stroke: accent, "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round",
  }));

  // 末尾点高亮
  const last = values.length - 1;
  svg.appendChild(el("circle", {
    cx: xScale(last), cy: yScale(values[last]), r: 3.5,
    fill: accent, stroke: "rgba(255,255,255,.6)", "stroke-width": "0.8",
  }));

  // X 轴刻度（首/中/末三处期号）
  const ticksAt = [0, Math.floor(values.length / 2), values.length - 1];
  for (const i of ticksAt) {
    if (!draws[i]) continue;
    const x = xScale(i);
    const t = el("text", {
      x, y: H - 6, "text-anchor": i === 0 ? "start" : i === last ? "end" : "middle",
      "font-size": "9.5", fill: muted, "font-family": "JetBrains Mono, monospace",
    });
    t.textContent = String(draws[i].issue);
    svg.appendChild(t);
  }
  // Y 轴左侧刻度（min/max）
  const fontStyle = { "font-size": "9.5", fill: muted, "font-family": "JetBrains Mono, monospace" };
  const tMin = el("text", { x: padL - 4, y: yScale(yMin) + 3, "text-anchor": "end", ...fontStyle });
  tMin.textContent = String(yMin);
  svg.appendChild(tMin);
  const tMax = el("text", { x: padL - 4, y: yScale(yMax) + 3, "text-anchor": "end", ...fontStyle });
  tMax.textContent = String(yMax);
  svg.appendChild(tMax);

  container.appendChild(svg);
}

export const TIME_SERIES_KINDS = SPECS;
