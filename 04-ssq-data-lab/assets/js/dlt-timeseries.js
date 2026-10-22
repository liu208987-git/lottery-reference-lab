// 大乐透时序图：和值/跨度/AC/奇偶/后区和值随期数的演化
//
// 与 timeseries.js 同构，但提取大乐透字段（front/back）。

import { pad2 } from "./utils.js";
import {
  frontSum, frontSpan, frontAcValue, frontOddCount,
  backSum, FRONT_SUM_MIN, FRONT_SUM_MAX,
  FRONT_SPAN_MIN, FRONT_SPAN_MAX, BACK_SUM_MIN, BACK_SUM_MAX,
} from "./dlt-distribution.js";
import { movingAverage } from "./timeseries.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const SPECS = {
  sum: { label: "前区和值", min: FRONT_SUM_MIN, max: FRONT_SUM_MAX, color: "--dlt-front", fmt: (v) => v },
  span: { label: "前区跨度", min: FRONT_SPAN_MIN, max: FRONT_SPAN_MAX, color: "--gold", fmt: (v) => v },
  ac: { label: "AC 值", min: 0, max: 6, color: "--plum", fmt: (v) => v },
  odd: { label: "奇数个数", min: 0, max: 5, color: "--dlt-front", fmt: (v) => v },
  backsum: { label: "后区和值", min: BACK_SUM_MIN, max: BACK_SUM_MAX, color: "--dlt-back", fmt: (v) => v },
};

function metricOf(draw, kind) {
  if (kind === "sum") return frontSum(draw.front);
  if (kind === "span") return frontSpan(draw.front);
  if (kind === "ac") return frontAcValue(draw.front);
  if (kind === "odd") return frontOddCount(draw.front);
  if (kind === "backsum") return backSum(draw.back);
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

export function buildDltSeries(draws, kind) {
  return draws.map((d) => metricOf(d, kind));
}

export function renderDltTimeSeries(container, draws, kind, { window = 30 } = {}) {
  container.innerHTML = "";
  if (!draws.length) return;

  const spec = SPECS[kind] || SPECS.sum;
  const values = buildDltSeries(draws, kind);
  const ma = movingAverage(values, window);
  const expected = values.reduce((a, b) => a + b, 0) / values.length;

  const W = container.clientWidth || 600;
  const H = container.clientHeight || 180;
  const padL = 36, padR = 12, padT = 12, padB = 22;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const yMin = Math.min(spec.min, ...values);
  const yMax = Math.max(spec.max, ...values);
  const yScale = (v) => padT + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;
  const xScale = (i) => padL + (i / Math.max(1, values.length - 1)) * innerW;

  const accent = readVar(spec.color, "#5dd9b8");
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

  const pts = values.map((v, i) => `${xScale(i).toFixed(2)},${yScale(v).toFixed(2)}`).join(" ");
  svg.appendChild(el("polyline", {
    points: pts, fill: "none",
    stroke: accent, "stroke-opacity": "0.16", "stroke-width": "1",
  }));

  const mPts = ma.map((v, i) => `${xScale(i).toFixed(2)},${yScale(v).toFixed(2)}`).join(" ");
  svg.appendChild(el("polyline", {
    points: mPts, fill: "none",
    stroke: accent, "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round",
  }));

  const last = values.length - 1;
  svg.appendChild(el("circle", {
    cx: xScale(last), cy: yScale(values[last]), r: 3.5,
    fill: accent, stroke: "rgba(255,255,255,.6)", "stroke-width": "0.8",
  }));

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
  const fontStyle = { "font-size": "9.5", fill: muted, "font-family": "JetBrains Mono, monospace" };
  const tMin = el("text", { x: padL - 4, y: yScale(yMin) + 3, "text-anchor": "end", ...fontStyle });
  tMin.textContent = String(yMin);
  svg.appendChild(tMin);
  const tMax = el("text", { x: padL - 4, y: yScale(yMax) + 3, "text-anchor": "end", ...fontStyle });
  tMax.textContent = String(yMax);
  svg.appendChild(tMax);

  container.appendChild(svg);
}

export const DLT_TIME_SERIES_KINDS = SPECS;
