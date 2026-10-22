// 大乐透走势图（横轴=号码，纵轴=期号），支持前区/后区两套色板
//
// 与 SSQ 的 trend-chart.js 同构，但使用绿/紫 token 以视觉分离两套彩种。

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

function readVar(name, fallback) {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * 渲染大乐透走势图。
 * @param container DOM 容器
 * @param rows [{ issue, date, hit: Set<number> }, ...]
 * @param options { size, kind: "front" | "back", stats?, zoneBoundaries?: number[] }
 *        zoneBoundaries：在哪些刻度后画分隔线（前区默认 [12, 24]）
 */
export function renderDltTrend(container, rows, {
  size,
  kind = "front",
  stats = null,
  zoneBoundaries = null,
} = {}) {
  container.innerHTML = "";
  const cellW = 24;
  const cellH = 22;
  const padLeft = 88;
  const padTop = 30;
  const padRight = 16;
  const padBottom = 14;
  const statRows = stats ? [
    { label: "出现次数", key: "freq" },
    { label: "平均遗漏", key: "avgMiss" },
    { label: "最大遗漏", key: "maxMiss" },
    { label: "当前遗漏", key: "currentMiss" },
  ] : [];
  const statBandH = statRows.length ? statRows.length * cellH + 18 : 0;

  const W = padLeft + cellW * size + padRight;
  const H = padTop + cellH * rows.length + statBandH + padBottom;

  const svg = el("svg", {
    class: "trend-svg",
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    role: "img",
    "aria-label": `${kind} trend lattice`,
  });

  // DLT 配色：前区用 acid 绿，后区用 plum 紫
  const accent = kind === "back"
    ? readVar("--dlt-back", "#d6a8ff")
    : readVar("--dlt-front", "#5dd9b8");
  const accentLight = kind === "back"
    ? readVar("--dlt-back-2", "#e8c8ff")
    : readVar("--dlt-front-2", "#88e8cd");
  const accentDeep = kind === "back"
    ? readVar("--dlt-back-deep", "#7c3fc4")
    : readVar("--dlt-front-deep", "#1f8868");

  const defs = el("defs");
  const gradId = `dlt-tg-${kind}-${Math.random().toString(36).slice(2, 7)}`;
  const grad = el("radialGradient", { id: gradId, cx: "32%", cy: "28%", r: "70%" });
  grad.appendChild(el("stop", { offset: "0%", "stop-color": "#fff", "stop-opacity": "0.6" }));
  grad.appendChild(el("stop", { offset: "100%", "stop-color": accentDeep, "stop-opacity": "0" }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  // 顶部数字刻度
  for (let n = 1; n <= size; n++) {
    const x = padLeft + (n - 0.5) * cellW;
    const isMul5 = n % 5 === 0;
    const t = el("text", {
      x, y: padTop - 12,
      "text-anchor": "middle",
      "font-size": isMul5 ? "10" : "9.5",
      "font-family": "JetBrains Mono, ui-monospace, Menlo, monospace",
      fill: isMul5 ? "rgba(255,255,255,.78)" : "rgba(255,255,255,.42)",
      "font-weight": isMul5 ? "700" : "400",
    });
    t.textContent = pad2(n);
    svg.appendChild(t);
  }

  // 区段分隔线
  if (zoneBoundaries && zoneBoundaries.length) {
    for (const boundary of zoneBoundaries) {
      const x = padLeft + boundary * cellW;
      svg.appendChild(el("line", {
        x1: x, x2: x,
        y1: padTop - 4, y2: H - padBottom + 4,
        stroke: "rgba(255,255,255,.10)",
        "stroke-dasharray": "2 3",
      }));
    }
  }

  rows.forEach((d, rowIdx) => {
    const y = padTop + rowIdx * cellH;
    const yMid = y + cellH / 2;
    const hitArr = d.hit && d.hit.has ? Array.from(d.hit) : (Array.isArray(d.hit) ? d.hit : []);

    if (rowIdx % 2 === 0) {
      svg.appendChild(el("rect", { x: 0, y, width: W, height: cellH, fill: "rgba(255,255,255,.018)" }));
    }
    svg.appendChild(el("line", {
      x1: padLeft, x2: W - padRight,
      y1: y + cellH, y2: y + cellH,
      stroke: "rgba(255,255,255,.04)",
    }));

    // 期号
    const label = el("text", {
      x: padLeft - 10, y: yMid + 3.5,
      "text-anchor": "end",
      "font-size": "10",
      "font-family": "JetBrains Mono, ui-monospace, Menlo, monospace",
      fill: "rgba(255,255,255,.55)",
    });
    label.textContent = d.issue;
    svg.appendChild(label);

    // 当期连线（前区/后区都画，显示走向）
    if (hitArr.length > 1) {
      const sorted = [...hitArr].sort((a, b) => a - b);
      const points = sorted.map((n) => `${padLeft + (n - 0.5) * cellW},${yMid}`).join(" ");
      svg.appendChild(el("polyline", {
        points, fill: "none", stroke: accentLight,
        "stroke-opacity": "0.16", "stroke-width": "1.2",
      }));
    }

    for (let n = 1; n <= size; n++) {
      const cx = padLeft + (n - 0.5) * cellW;
      const isHit = d.hit && d.hit.has ? d.hit.has(n) : hitArr.includes(n);
      if (isHit) {
        svg.appendChild(el("circle", {
          cx, cy: yMid, r: 8.5,
          fill: accent,
          stroke: "rgba(255,255,255,.18)",
          "stroke-width": 0.6,
        }));
        svg.appendChild(el("circle", {
          cx, cy: yMid, r: 8.5,
          fill: `url(#${gradId})`,
          opacity: 0.6,
        }));
        const t = el("text", {
          x: cx, y: yMid + 3.4,
          "text-anchor": "middle",
          "font-size": "9.2",
          "font-family": "JetBrains Mono, ui-monospace, Menlo, monospace",
          fill: "#fff",
          "font-weight": "700",
        });
        t.textContent = pad2(n);
        svg.appendChild(t);
      } else {
        svg.appendChild(el("circle", {
          cx, cy: yMid, r: 1.5,
          fill: "rgba(255,255,255,.22)",
        }));
      }
    }
  });

  // 底部统计行
  if (stats && statRows.length) {
    const bandTop = padTop + cellH * rows.length + 8;
    svg.appendChild(el("line", {
      x1: 0, x2: W, y1: bandTop - 4, y2: bandTop - 4,
      stroke: "rgba(255,255,255,.10)",
    }));
    statRows.forEach((row, idx) => {
      const y = bandTop + idx * cellH;
      const yMid = y + cellH / 2;
      const label = el("text", {
        x: padLeft - 10, y: yMid + 3.5,
        "text-anchor": "end",
        "font-size": "10",
        "font-family": "JetBrains Mono, ui-monospace, Menlo, monospace",
        fill: "rgba(255,255,255,.62)",
        "font-weight": "600",
      });
      label.textContent = row.label;
      svg.appendChild(label);
      if (idx % 2 === 0) {
        svg.appendChild(el("rect", { x: 0, y, width: W, height: cellH, fill: "rgba(255,255,255,.018)" }));
      }
      for (let n = 1; n <= size; n++) {
        const cx = padLeft + (n - 0.5) * cellW;
        const v = stats[n] ? stats[n][row.key] : 0;
        const display = row.key === "avgMiss" ? Number(v).toFixed(1) : Math.round(v);
        let fill = "rgba(255,255,255,.72)";
        let weight = "500";
        if (row.key === "currentMiss" && v >= 10) {
          fill = accent;
          weight = "700";
        } else if (row.key === "maxMiss" && v >= 20) {
          fill = "rgba(255,255,255,.92)";
          weight = "600";
        }
        const t = el("text", {
          x: cx, y: yMid + 3.4,
          "text-anchor": "middle",
          "font-size": "9.5",
          "font-family": "JetBrains Mono, ui-monospace, Menlo, monospace",
          fill, "font-weight": weight,
        });
        t.textContent = String(display);
        svg.appendChild(t);
      }
    });
  }

  container.appendChild(svg);
}
