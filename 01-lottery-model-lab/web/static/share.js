(function attachLotteryShare(root, factory) {
  "use strict";

  const api = factory(root);
  root.LotteryShare = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window, function createLotteryShare(root) {
  "use strict";

  /**
   * 独立分享模块，无外部依赖。
   *
   * 主要接口：
   * - formatPredictionText(result, modelOrder): 每模型一行，只输出号码。
   * - renderPredictionCard(result, options): 用 Canvas 同步生成 PNG Blob。
   * - sharePredictionCard(result, options): 优先 Web Share 文件，失败后下载，再回退复制。
   * - downloadPredictionCard(result, options): 生成并下载卡片。
   * - copyPredictionText(result, modelOrder, options): 复制纯号码文本。
   *
   * 可测试纯函数：getPredictionRows、formatPredictionText、buildCardLayout。
   */

  const VERSION = "1.0.0";

  const MODEL_LABELS = Object.freeze({
    uniform_random: "等概率随机",
    bayesian_all: "全历史贝叶斯",
    bayesian_recent_120: "滚动窗口贝叶斯",
    exp_decay_60: "指数衰减贝叶斯",
    hot_cold: "冷热差",
    overdue_gap: "遗漏值",
    markov_transition: "一阶转移",
    cooccurrence_network: "共现网络",
    chaos_logistic: "Logistic 混沌",
    meihua_yishu: "梅花易数实验",
    xiaoliu_ren: "小六壬实验",
    ga_ensemble: "遗传算法集成",
  });

  const DEFAULT_MODEL_ORDER = Object.freeze([
    "ga_ensemble",
    "bayesian_all",
    "bayesian_recent_120",
    "exp_decay_60",
    "hot_cold",
    "overdue_gap",
    "markov_transition",
    "cooccurrence_network",
    "chaos_logistic",
    "meihua_yishu",
    "xiaoliu_ren",
    "uniform_random",
  ]);

  // 与项目 Ramp 主视觉、Linear 紧凑信息密度保持一致。
  const DEFAULT_THEME = Object.freeze({
    background: "#ffffff",
    surface: "#f4f2f0",
    ink: "#000000",
    inkSoft: "#333333",
    muted: "#808080",
    line: "rgba(0, 0, 0, 0.10)",
    lineStrong: "rgba(0, 0, 0, 0.28)",
    accent: "#dfff00",
    front: "#c82a25",
    back: "#1764d6",
  });

  const SANS_FONT =
    '"Helvetica Neue", Helvetica, "PingFang SC", "Microsoft YaHei", Arial, sans-serif';
  const MONO_FONT =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function asPositiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function normalizeNumbers(values) {
    if (!Array.isArray(values)) return [];
    const unique = new Set();
    values.forEach((value) => {
      const number = Number(value);
      if (Number.isInteger(number) && number > 0) unique.add(number);
    });
    return Array.from(unique).sort((left, right) => left - right);
  }

  function zoneModels(result, zone) {
    const models = result && result.zones && result.zones[zone] && result.zones[zone].models;
    return models && typeof models === "object" ? models : {};
  }

  function collectAvailableModels(result) {
    const names = [];
    const seen = new Set();
    [zoneModels(result, "front"), zoneModels(result, "back")].forEach((models) => {
      Object.keys(models).forEach((name) => {
        if (!seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
      });
    });
    return names;
  }

  function resolveModelOrder(result, modelOrder) {
    const available = collectAvailableModels(result);
    const availableSet = new Set(available);
    const requested = Array.isArray(modelOrder) ? modelOrder : DEFAULT_MODEL_ORDER;
    const ordered = [];
    const seen = new Set();

    requested.forEach((name) => {
      const normalized = String(name);
      if (availableSet.has(normalized) && !seen.has(normalized)) {
        seen.add(normalized);
        ordered.push(normalized);
      }
    });

    // 显式传入顺序时，它同时充当筛选器；默认顺序则兜底收录未知的新模型。
    if (!Array.isArray(modelOrder)) {
      available.forEach((name) => {
        if (!seen.has(name)) ordered.push(name);
      });
    }
    return ordered;
  }

  function getPredictionRows(result, modelOrder, modelLabels) {
    const frontModels = zoneModels(result, "front");
    const backModels = zoneModels(result, "back");
    const labels = { ...MODEL_LABELS, ...(modelLabels || {}) };

    return resolveModelOrder(result, modelOrder)
      .map((model) => {
        const front = normalizeNumbers(frontModels[model] && frontModels[model].numbers);
        const back = normalizeNumbers(backModels[model] && backModels[model].numbers);
        return {
          model,
          label: labels[model] || model,
          front,
          back,
          isPrimary: model === "ga_ensemble",
        };
      })
      .filter((row) => row.front.length || row.back.length);
  }

  function formatBallNumber(number) {
    return String(number).padStart(2, "0");
  }

  function formatPredictionRow(row) {
    const front = normalizeNumbers(row && row.front).map(formatBallNumber).join(" ");
    const back = normalizeNumbers(row && row.back).map(formatBallNumber).join(" ");
    if (front && back) return `${front} | ${back}`;
    return front || back;
  }

  function formatPredictionText(result, modelOrder) {
    return getPredictionRows(result, modelOrder)
      .map(formatPredictionRow)
      .filter(Boolean)
      .join("\n");
  }

  function layoutNumberGroups(row, metrics) {
    const positions = [];
    const separators = [];
    const lineStep = metrics.ballSize + metrics.wrapGap;
    let line = 0;
    let x = metrics.numberX;

    function newLine() {
      line += 1;
      x = metrics.numberX;
    }

    function ensureWidth(width) {
      if (x > metrics.numberX && x + width > metrics.contentRight) newLine();
    }

    function addBall(number, zone) {
      ensureWidth(metrics.ballSize);
      positions.push({ number, zone, x, y: line * lineStep });
      x += metrics.ballSize + metrics.ballGap;
    }

    row.front.forEach((number) => addBall(number, "front"));
    if (row.back.length) {
      if (row.front.length) {
        const separatorWidth = metrics.separatorGap + metrics.ballSize;
        ensureWidth(separatorWidth);
        separators.push({
          x: x + metrics.separatorGap / 2 - metrics.ballGap / 2,
          y: line * lineStep,
        });
        x += metrics.separatorGap;
      }
      row.back.forEach((number) => addBall(number, "back"));
    }

    return {
      positions,
      separators,
      lineCount: line + 1,
      height: metrics.ballSize + line * lineStep,
    };
  }

  function buildCardLayout(result, options) {
    const settings = options || {};
    const width = Math.round(clamp(asPositiveNumber(settings.width, 720), 360, 1440));
    const compact = width < 520;
    const padding = Math.round(clamp(width * 0.067, compact ? 24 : 36, 64));
    const labelWidth = Math.round(clamp(width * 0.235, compact ? 92 : 120, 170));
    const labelGap = compact ? 12 : 18;
    const numberX = padding + labelWidth + labelGap;
    const contentRight = width - padding;
    const numberWidth = contentRight - numberX;
    const ballGap = compact ? 5 : 8;
    const separatorGap = compact ? 14 : 20;
    const desiredBallSize = compact ? 27 : 40;
    const rows = getPredictionRows(result, settings.modelOrder, settings.modelLabels);
    const largestCount = Math.max(
      1,
      ...rows.map((row) => row.front.length + row.back.length),
    );
    const largestGroupGaps = Math.max(0, largestCount - 2) * ballGap;
    const hasSplitRow = rows.some((row) => row.front.length && row.back.length);
    const fittedBallSize = Math.floor(
      (numberWidth - largestGroupGaps - (hasSplitRow ? separatorGap : 0)) / largestCount,
    );
    const ballSize = Math.round(clamp(Math.min(desiredBallSize, fittedBallSize), 22, 42));
    const wrapGap = compact ? 7 : 10;
    const rowPadding = compact ? 14 : 17;
    const minimumRowHeight = compact ? 66 : 78;
    const headerHeight = compact ? 166 : 184;
    const footerHeight = compact ? 78 : 88;
    const emptyHeight = compact ? 168 : 220;

    const numberMetrics = {
      ballSize,
      ballGap,
      separatorGap,
      wrapGap,
      numberX,
      contentRight,
    };
    let cursorY = headerHeight;
    const rowLayouts = rows.map((row) => {
      const groups = layoutNumberGroups(row, numberMetrics);
      const height = Math.max(minimumRowHeight, groups.height + rowPadding * 2);
      const layout = {
        ...row,
        ...groups,
        y: cursorY,
        height,
        groupOffsetY: Math.round((height - groups.height) / 2),
      };
      cursorY += height;
      return layout;
    });

    const contentBottom = rows.length ? cursorY : headerHeight + emptyHeight;
    const naturalHeight = contentBottom + footerHeight;
    const defaultMinimumHeight = Math.round(width * (compact ? 1.48 : 1.38));
    const minimumHeight = Math.round(
      Math.max(0, asPositiveNumber(settings.minHeight, defaultMinimumHeight)),
    );
    const height = Math.max(naturalHeight, minimumHeight);

    return {
      width,
      height,
      compact,
      padding,
      labelWidth,
      labelGap,
      numberX,
      contentRight,
      ballSize,
      headerHeight,
      footerHeight,
      footerY: height - footerHeight,
      emptyHeight,
      rows: rowLayouts,
    };
  }

  function roundRectPath(context, x, y, width, height, radius) {
    const safeRadius = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + safeRadius, y);
    context.lineTo(x + width - safeRadius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
    context.lineTo(x + width, y + height - safeRadius);
    context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
    context.lineTo(x + safeRadius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
    context.lineTo(x, y + safeRadius);
    context.quadraticCurveTo(x, y, x + safeRadius, y);
    context.closePath();
  }

  function fitText(context, value, maxWidth) {
    const text = String(value == null ? "" : value);
    if (!text || context.measureText(text).width <= maxWidth) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (context.measureText(`${text.slice(0, middle)}…`).width <= maxWidth) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low ? `${text.slice(0, low)}…` : "";
  }

  function drawBrandMark(context, x, y, size, theme) {
    context.save();
    context.lineWidth = Math.max(3, size * 0.23);
    context.strokeStyle = theme.ink;
    context.beginPath();
    context.arc(x + size / 2, y + size / 2, size * 0.34, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = theme.accent;
    context.beginPath();
    context.arc(x + size / 2, y + size / 2, size * 0.34, -0.62, 0.62);
    context.stroke();
    context.restore();
  }

  function drawLegendItem(context, x, y, color, label, compact, theme) {
    const radius = compact ? 4 : 5;
    context.fillStyle = color;
    context.beginPath();
    context.arc(x + radius, y, radius, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = theme.muted;
    context.font = `400 ${compact ? 10 : 12}px ${SANS_FONT}`;
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText(label, x + radius * 2 + 7, y);
    return radius * 2 + 7 + context.measureText(label).width;
  }

  function drawBall(context, ball, x, y, size, theme, compact) {
    const color = ball.zone === "back" ? theme.back : theme.front;
    const centerX = x + size / 2;
    const centerY = y + size / 2;
    context.fillStyle = color;
    context.beginPath();
    context.arc(centerX, centerY, size / 2, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = theme.background;
    context.font = `600 ${Math.round(size * (compact ? 0.38 : 0.36))}px ${MONO_FONT}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(formatBallNumber(ball.number), centerX, centerY + 0.5);
  }

  function drawPredictionCard(context, result, layout, options, theme) {
    const compact = layout.compact;
    const padding = layout.padding;
    const lotteryName = String((result && result.lottery_name) || "彩票");
    const lotteryCode = String((result && result.lottery_code) || "").toLowerCase();
    const issue = String((result && result.issue) || "—");
    const targetDate = String((result && result.target_date) || "—");
    const isSsq = lotteryCode === "ssq";
    const frontLabel = isSsq ? "红球" : "前区";
    const backLabel = isSsq ? "蓝球" : "后区";
    const title = String(options.title || `${lotteryName}预测实验`);
    const hasFront = layout.rows.some((row) => row.front.length);
    const hasBack = layout.rows.some((row) => row.back.length);

    context.fillStyle = theme.background;
    context.fillRect(0, 0, layout.width, layout.height);

    const brandY = compact ? 27 : 36;
    const markSize = compact ? 19 : 23;
    drawBrandMark(context, padding, brandY - markSize / 2, markSize, theme);
    context.fillStyle = theme.inkSoft;
    context.font = `600 ${compact ? 9 : 11}px ${MONO_FONT}`;
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText("LOTTERY MODEL LAB", padding + markSize + 9, brandY);

    const countText = `${layout.rows.length} 组模型`;
    context.fillStyle = theme.muted;
    context.font = `400 ${compact ? 9 : 11}px ${MONO_FONT}`;
    context.textAlign = "right";
    context.fillText(countText, layout.width - padding, brandY);

    const titleY = compact ? 69 : 82;
    context.fillStyle = theme.ink;
    context.font = `400 ${compact ? 27 : 34}px ${SANS_FONT}`;
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText(fitText(context, title, layout.width - padding * 2), padding, titleY);

    const metaY = compact ? 105 : 122;
    context.fillStyle = theme.muted;
    context.font = `400 ${compact ? 11 : 13}px ${MONO_FONT}`;
    context.fillText(`${issue} 期  ·  ${targetDate}`, padding, metaY);

    const legendY = compact ? 137 : 154;
    let legendX = padding;
    if (hasFront) {
      legendX += drawLegendItem(
        context,
        legendX,
        legendY,
        theme.front,
        frontLabel,
        compact,
        theme,
      );
    }
    if (hasBack) {
      if (hasFront) legendX += compact ? 15 : 20;
      drawLegendItem(context, legendX, legendY, theme.back, backLabel, compact, theme);
    }

    context.strokeStyle = theme.line;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, layout.headerHeight - 0.5);
    context.lineTo(layout.width, layout.headerHeight - 0.5);
    context.stroke();

    if (!layout.rows.length) {
      const centerY = layout.headerHeight + layout.emptyHeight / 2;
      context.fillStyle = theme.surface;
      roundRectPath(
        context,
        padding,
        centerY - (compact ? 38 : 48),
        layout.width - padding * 2,
        compact ? 76 : 96,
        8,
      );
      context.fill();
      context.fillStyle = theme.muted;
      context.font = `400 ${compact ? 13 : 15}px ${SANS_FONT}`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("暂无可分享的预测结果", layout.width / 2, centerY);
    }

    layout.rows.forEach((row) => {
      if (row.isPrimary) {
        context.fillStyle = theme.surface;
        context.fillRect(0, row.y, layout.width, row.height);
        context.fillStyle = theme.accent;
        context.fillRect(0, row.y, compact ? 4 : 5, row.height);
      }

      context.fillStyle = theme.ink;
      context.font = `500 ${compact ? 11 : 13}px ${SANS_FONT}`;
      context.textAlign = "left";
      context.textBaseline = "middle";
      context.fillText(
        fitText(context, row.label, layout.labelWidth),
        padding,
        row.y + row.height / 2,
      );

      row.separators.forEach((separator) => {
        const separatorY = row.y + row.groupOffsetY + separator.y;
        context.strokeStyle = theme.lineStrong;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(separator.x, separatorY + layout.ballSize * 0.18);
        context.lineTo(separator.x, separatorY + layout.ballSize * 0.82);
        context.stroke();
      });

      row.positions.forEach((ball) => {
        drawBall(
          context,
          ball,
          ball.x,
          row.y + row.groupOffsetY + ball.y,
          layout.ballSize,
          theme,
          compact,
        );
      });

      context.strokeStyle = theme.line;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(0, row.y + row.height - 0.5);
      context.lineTo(layout.width, row.y + row.height - 0.5);
      context.stroke();
    });

    const footerY = layout.footerY;
    context.fillStyle = theme.background;
    context.fillRect(0, footerY, layout.width, layout.footerHeight);
    context.strokeStyle = theme.line;
    context.beginPath();
    context.moveTo(0, footerY + 0.5);
    context.lineTo(layout.width, footerY + 0.5);
    context.stroke();

    const warning = String(
      options.warning ||
        (result && result.warning) ||
        "实验性排序结果，不代表中奖概率高于官方随机基线。",
    );
    context.fillStyle = theme.muted;
    context.font = `400 ${compact ? 9 : 11}px ${SANS_FONT}`;
    context.textAlign = "left";
    context.textBaseline = "middle";
    const footerTextWidth = layout.width - padding * 2 - (compact ? 68 : 96);
    context.fillText(
      fitText(context, warning, footerTextWidth),
      padding,
      footerY + layout.footerHeight / 2,
    );
    context.fillStyle = theme.ink;
    context.font = `600 ${compact ? 9 : 11}px ${MONO_FONT}`;
    context.textAlign = "right";
    context.fillText(
      lotteryCode ? lotteryCode.toUpperCase() : "LAB",
      layout.width - padding,
      footerY + layout.footerHeight / 2,
    );
  }

  function resolvePixelRatio(layout, options) {
    const requested = asPositiveNumber(
      options.pixelRatio,
      asPositiveNumber(options.devicePixelRatio, asPositiveNumber(root.devicePixelRatio, 1)),
    );
    const cappedRequested = clamp(requested, 0.5, 3);
    const maxCanvasPixels = asPositiveNumber(options.maxCanvasPixels, 16000000);
    const maxCanvasDimension = asPositiveNumber(options.maxCanvasDimension, 16384);
    const budgetRatio = Math.sqrt(maxCanvasPixels / (layout.width * layout.height));
    const dimensionRatio = Math.min(
      maxCanvasDimension / layout.width,
      maxCanvasDimension / layout.height,
    );
    return clamp(Math.min(cappedRequested, budgetRatio, dimensionRatio), 0.1, 3);
  }

  function createCanvas(options) {
    if (options.canvas) return options.canvas;
    const documentObject = options.document || root.document;
    if (!documentObject || typeof documentObject.createElement !== "function") {
      throw new Error("当前环境不支持 Canvas，请在浏览器中生成分享卡片");
    }
    return documentObject.createElement("canvas");
  }

  function dataUrlToBlob(dataUrl, options) {
    const parts = String(dataUrl).split(",");
    if (parts.length < 2) throw new Error("Canvas PNG 编码失败");
    const header = parts[0];
    const mimeMatch = header.match(/^data:([^;,]+)/);
    const mime = mimeMatch ? mimeMatch[1] : "image/png";
    const decodeBase64 = options.atob || root.atob;
    if (typeof decodeBase64 !== "function") throw new Error("当前环境不支持 PNG 编码");
    const binary = decodeBase64(parts.slice(1).join(","));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const BlobConstructor = options.Blob || root.Blob;
    if (typeof BlobConstructor !== "function") throw new Error("当前环境不支持 Blob");
    return new BlobConstructor([bytes], { type: mime });
  }

  function renderPredictionCard(result, options) {
    const settings = options || {};
    const theme = { ...DEFAULT_THEME, ...(settings.theme || {}) };
    const layout = buildCardLayout(result, settings);
    const pixelRatio = resolvePixelRatio(layout, settings);
    const canvas = createCanvas(settings);
    canvas.width = Math.max(1, Math.round(layout.width * pixelRatio));
    canvas.height = Math.max(1, Math.round(layout.height * pixelRatio));
    if (canvas.style) {
      canvas.style.width = `${layout.width}px`;
      canvas.style.height = `${layout.height}px`;
    }

    const context = canvas.getContext && canvas.getContext("2d");
    if (!context) throw new Error("无法创建 Canvas 2D 上下文");
    if (typeof context.setTransform === "function") {
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    } else {
      context.scale(pixelRatio, pixelRatio);
    }
    context.imageSmoothingEnabled = true;
    drawPredictionCard(context, result || {}, layout, settings, theme);

    if (typeof canvas.toDataURL !== "function") {
      throw new Error("当前 Canvas 无法导出 PNG");
    }
    // 同步转 Blob，确保随后调用 Web Share 时仍处于点击产生的用户手势中。
    return dataUrlToBlob(canvas.toDataURL("image/png"), settings);
  }

  function makePredictionFilename(result, extension) {
    const code = String((result && result.lottery_code) || (result && result.lottery_name) || "lottery");
    const issue = String((result && result.issue) || "prediction");
    const suffix = String(extension || "png").replace(/^\.+/, "") || "png";
    const base = `${code}-${issue}-prediction`
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return `${base || "lottery-prediction"}.${suffix}`;
  }

  function createPredictionFile(blob, result, options) {
    const settings = options || {};
    const FileConstructor = settings.File || root.File;
    if (typeof FileConstructor !== "function") return null;
    const filename = settings.filename || makePredictionFilename(result, "png");
    return new FileConstructor([blob], filename, {
      type: blob.type || "image/png",
      lastModified: asPositiveNumber(settings.lastModified, Date.now()),
    });
  }

  function downloadBlob(blob, filename, options) {
    const settings = options || {};
    const documentObject = settings.document || root.document;
    const urlObject = settings.URL || root.URL;
    if (
      !documentObject ||
      typeof documentObject.createElement !== "function" ||
      !urlObject ||
      typeof urlObject.createObjectURL !== "function"
    ) {
      throw new Error("当前环境不支持文件下载");
    }

    const objectUrl = urlObject.createObjectURL(blob);
    const anchor = documentObject.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename || "lottery-prediction.png";
    anchor.rel = "noopener";
    anchor.style.display = "none";
    const host = documentObject.body || documentObject.documentElement;
    if (host && typeof host.appendChild === "function") host.appendChild(anchor);
    anchor.click();
    if (typeof anchor.remove === "function") anchor.remove();
    const defer = settings.setTimeout || root.setTimeout;
    if (typeof defer === "function") {
      defer(() => urlObject.revokeObjectURL(objectUrl), 1000);
    } else {
      urlObject.revokeObjectURL(objectUrl);
    }
    return anchor.download;
  }

  async function copyText(text, options) {
    const settings = options || {};
    const value = String(text == null ? "" : text);
    if (!value) throw new Error("没有可复制的预测号码");
    const navigatorObject = settings.navigator || root.navigator;
    let clipboardError = null;

    if (
      navigatorObject &&
      navigatorObject.clipboard &&
      typeof navigatorObject.clipboard.writeText === "function"
    ) {
      try {
        await navigatorObject.clipboard.writeText(value);
        return value;
      } catch (error) {
        clipboardError = error;
      }
    }

    const documentObject = settings.document || root.document;
    if (!documentObject || typeof documentObject.createElement !== "function") {
      throw clipboardError || new Error("当前环境不支持剪切板");
    }
    const textarea = documentObject.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    const host = documentObject.body || documentObject.documentElement;
    if (!host || typeof host.appendChild !== "function") {
      throw clipboardError || new Error("当前环境不支持剪切板");
    }
    host.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let copied = false;
    try {
      copied = Boolean(documentObject.execCommand && documentObject.execCommand("copy"));
    } finally {
      if (typeof textarea.remove === "function") textarea.remove();
      else if (textarea.parentNode) textarea.parentNode.removeChild(textarea);
    }
    if (!copied) throw clipboardError || new Error("复制失败，请手动选择号码文本");
    return value;
  }

  function copyPredictionText(result, modelOrder, options) {
    return copyText(formatPredictionText(result, modelOrder), options);
  }

  function downloadPredictionCard(result, options) {
    const settings = options || {};
    const blob = settings.blob || renderPredictionCard(result, settings);
    const filename = settings.filename || makePredictionFilename(result, "png");
    downloadBlob(blob, filename, settings);
    return { method: "download", blob, filename };
  }

  async function sharePredictionCard(result, options) {
    const settings = options || {};
    const text = formatPredictionText(result, settings.modelOrder);
    const blob = settings.blob || renderPredictionCard(result, settings);
    const filename = settings.filename || makePredictionFilename(result, "png");
    const file = createPredictionFile(blob, result, { ...settings, filename });
    const navigatorObject = settings.navigator || root.navigator;
    let shareError = null;

    if (navigatorObject && typeof navigatorObject.share === "function" && file) {
      const filePayload = { files: [file] };
      let canShareFiles = true;
      if (typeof navigatorObject.canShare === "function") {
        try {
          canShareFiles = navigatorObject.canShare(filePayload);
        } catch (error) {
          canShareFiles = false;
          shareError = error;
        }
      }
      if (canShareFiles) {
        try {
          // 图片分享只发送一个文件载荷。额外的 title/text 会被部分系统
          // “复制”目标拆成多个剪贴板项，造成看似重复的图片或附件。
          // 调用发生在第一次 await 之前，保留移动浏览器的 transient activation。
          const sharing = navigatorObject.share({ files: [file] });
          await sharing;
          return { method: "web-share", blob, file, filename, text };
        } catch (error) {
          if (error && error.name === "AbortError") {
            return { method: "cancelled", blob, file, filename, text };
          }
          // Web Share 已实际交给系统后，不再自动下载或复制。某些平台会在
          // 已完成复制后才让 Promise 拒绝，继续回退会制造第二个副作用。
          const message = error && error.message ? `：${error.message}` : "";
          throw new Error(`系统图片分享失败，请重试${message}`);
        }
      }
    }

    try {
      downloadBlob(blob, filename, settings);
      return { method: "download", blob, file, filename, text, shareError };
    } catch (downloadError) {
      if (!text) throw downloadError;
      await copyText(text, settings);
      return {
        method: "copy",
        blob,
        file,
        filename,
        text,
        shareError: shareError || downloadError,
      };
    }
  }

  return Object.freeze({
    VERSION,
    MODEL_LABELS,
    DEFAULT_MODEL_ORDER,
    DEFAULT_THEME,
    normalizeNumbers,
    getPredictionRows,
    formatPredictionRow,
    formatPredictionText,
    buildCardLayout,
    renderPredictionCard,
    makePredictionFilename,
    createPredictionFile,
    downloadBlob,
    downloadPredictionCard,
    copyText,
    copyPredictionText,
    sharePredictionCard,
  });
});
