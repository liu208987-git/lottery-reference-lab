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

// 走势图：横轴=号码，纵轴=期号（最近在最下方）
// 命中渲染为彩色实心球，未命中渲染为淡点；连线展示当期"走向"
// 在数据行下方追加 4 行统计：出现次数 / 平均遗漏 / 最大遗漏 / 当前遗漏（500.com 标准走势版式）。
export function renderTrend(container, draws, { size, kind = "red", stats = null } = {}) {
  container.innerHTML = "";
  const cellW = 24;
  const cellH = 22;
  const padLeft = 88;
  const padTop = 30;
  const padRight = 16;
  const padBottom = 14;
  // 底部统计行
  const statRows = stats ? [
    { label: "出现次数", key: "freq" },
    { label: "平均遗漏", key: "avgMiss" },
    { label: "最大遗漏", key: "maxMiss" },
    { label: "当前遗漏", key: "currentMiss" },
  ] : [];
  const statBandH = statRows.length ? statRows.length * cellH + 18 : 0;

  const W = padLeft + cellW * size + padRight;
  const H = padTop + cellH * draws.length + statBandH + padBottom;

  const svg = el("svg", {
    class: "trend-svg",
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    role: "img",
    "aria-label": `${kind} trend lattice`,
  });

  const accent = kind === "blue" ? readVar("--blue", "#4aa8ff") : readVar("--red", "#ff4757");
  const accentLight = kind === "blue" ? readVar("--blue-2", "#8fcaff") : readVar("--red-2", "#ff8084");
  const accentDeep = kind === "blue" ? readVar("--blue-deep", "#1a6fc9") : readVar("--red-deep", "#c81d2a");

  const defs = el("defs");
  const gradId = `tg-${kind}-${Math.random().toString(36).slice(2, 7)}`;
  const grad = el("radialGradient", { id: gradId, cx: "32%", cy: "28%", r: "70%" });
  grad.appendChild(el("stop", { offset: "0%", "stop-color": "#fff", "stop-opacity": "0.6" }));
  grad.appendChild(el("stop", { offset: "100%", "stop-color": accentDeep, "stop-opacity": "0" }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  // 顶部数字刻度（粘住顶部，xlink 不需要）
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

  // 区段分隔（红球）
  if (kind === "red" && size === 33) {
    [11, 22].forEach((boundary) => {
      const x = padLeft + boundary * cellW;
      svg.appendChild(el("line", {
        x1: x, x2: x,
        y1: padTop - 4, y2: H - padBottom + 4,
        stroke: "rgba(255,255,255,.10)",
        "stroke-dasharray": "2 3",
      }));
    });
  }

  draws.forEach((d, rowIdx) => {
    const y = padTop + rowIdx * cellH;
    const yMid = y + cellH / 2;
    const redsArr = d.reds && d.reds.has ? Array.from(d.reds) : (Array.isArray(d.reds) ? d.reds : []);

    // 斑马底
    if (rowIdx % 2 === 0) {
      svg.appendChild(el("rect", {
        x: 0, y, width: W, height: cellH,
        fill: "rgba(255,255,255,.018)",
      }));
    }
    // 行分隔线
    svg.appendChild(el("line", {
      x1: padLeft, x2: W - padRight,
      y1: y + cellH, y2: y + cellH,
      stroke: "rgba(255,255,255,.04)",
    }));

    // 期号 label
    const label = el("text", {
      x: padLeft - 10, y: yMid + 3.5,
      "text-anchor": "end",
      "font-size": "10",
      "font-family": "JetBrains Mono, ui-monospace, Menlo, monospace",
      fill: "rgba(255,255,255,.55)",
    });
    label.textContent = d.issue;
    svg.appendChild(label);

    // 当期连线（红球）：先画线再画球，让线落在球下方
    if (kind === "red" && redsArr.length > 1) {
      const sorted = [...redsArr].sort((a, b) => a - b);
      const points = sorted.map((n) => `${padLeft + (n - 0.5) * cellW},${yMid}`).join(" ");
      svg.appendChild(el("polyline", {
        points,
        fill: "none",
        stroke: accentLight,
        "stroke-opacity": "0.16",
        "stroke-width": "1.2",
      }));
    }

    // 命中点 + 未命中淡点
    for (let n = 1; n <= size; n++) {
      const cx = padLeft + (n - 0.5) * cellW;
      const isHit = kind === "blue" ? d.blue === n : (d.reds.has ? d.reds.has(n) : redsArr.includes(n));

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

  // 底部统计行：500.com 走势图标准的"出现次数 / 平均遗漏 / 最大遗漏 / 当前遗漏"
  if (stats && statRows.length) {
    const bandTop = padTop + cellH * draws.length + 8;
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
        svg.appendChild(el("rect", {
          x: 0, y, width: W, height: cellH,
          fill: "rgba(255,255,255,.018)",
        }));
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
          fill,
          "font-weight": weight,
        });
        t.textContent = String(display);
        svg.appendChild(t);
      }
    });
  }

  container.appendChild(svg);
}
