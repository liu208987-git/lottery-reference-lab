const state = {
  status: null,
  metrics: [],
  audit: null,
  pollingTimer: null,
  syncPollingTimer: null,
  predictionPollingTimer: null,
  lastPredictionProgressVersion: null,
  predictionStartedAt: 0,
  imageShareInFlight: false,
  lastPrediction: null,
};

const predictionModelOrder = [
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
];

const modelNames = {
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
};

const zoneNames = {
  front: "前区 / 红球",
  back: "后区 / 蓝球",
};

const modelComputations = {
  uniform_random: "固定 k/N 概率；稳定哈希只用于打破同分排序。",
  bayesian_all: "累计全历史出现次数，并用已冻结先验强度向公平概率收缩。",
  bayesian_recent_120: "只读取嵌套选择后的滚动窗口，计算平滑包含概率。",
  exp_decay_60: "按冻结半衰期衰减旧记录，近期样本获得更高权重。",
  hot_cold: "比较短窗口与长窗口频率差，检验冷热号直觉。",
  overdue_gap: "计算每个号码距上次出现的期数，作为遗漏值对照。",
  markov_transition: "以前一期号码为条件，聚合跨期转移计数并做收缩。",
  cooccurrence_network: "以前一期号码为锚，汇总历史同期共现边权。",
  chaos_logistic: "由目标期号与日期初始化 Logistic 映射，生成确定性排序。",
  meihua_yishu: "换算农历年月日与亥时，按起卦分量映射为号码特征。",
  xiaoliu_ren: "按月、日、时三宫轮转生成六宫特征，再映射为号码分数。",
  ga_ensemble: "读取验证期冻结的非负权重，融合十个基础模型。",
};

const predictionPipelineStages = [
  [2, "数据校验"],
  [15, "历法编码"],
  [38, "前区模型"],
  [58, "前区集成"],
  [68, "后区模型"],
  [88, "后区集成"],
  [98, "封装结果"],
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `请求失败：${response.status}`);
  }
  return payload;
}

function showToast(message, isError = false) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function navigate(view) {
  if (view === "data-entry" && state.status?.capabilities?.can_write_draws === false) {
    view = "predict";
  }
  document.querySelectorAll(".view").forEach((element) => {
    element.classList.toggle("is-visible", element.id === `view-${view}`);
  });
  document.querySelectorAll(".nav-item").forEach((element) => {
    element.classList.toggle("is-active", element.dataset.view === view);
  });
  if (window.location.hash !== `#${view}`) {
    history.replaceState(null, "", `#${view}`);
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function formatNumber(value, digits = 3) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "—";
}

function formatPercent(value, digits = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(digits)}%` : "—";
}

function formatPValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number < 0.001) return number.toExponential(2);
  return number.toFixed(3);
}

function formatDateTime(value) {
  if (!value) return "尚无结果";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function renderStats() {
  const ssq = state.status.games.ssq;
  const dlt = state.status.games.dlt;
  const cards = [
    ["双色球历史", ssq.record_count.toLocaleString(), `${ssq.earliest_date} → ${ssq.latest_date}`],
    ["大乐透历史", dlt.record_count.toLocaleString(), `${dlt.earliest_date} → ${dlt.latest_date}`],
    [
      "模型训练样本",
      ((ssq.model_record_count ?? ssq.record_count) + (dlt.model_record_count ?? dlt.record_count)).toLocaleString(),
      `完整历史 ${Number(ssq.record_count + dlt.record_count).toLocaleString()} 期；早期数据仍参与审计`,
    ],
    ["最后训练", state.status.results_generated_at ? "已完成" : "未运行", formatDateTime(state.status.results_generated_at)],
  ];
  document.querySelector("#statGrid").innerHTML = cards
    .map(
      ([label, value, detail]) => `
        <article class="stat-card">
          <span class="stat-label">${escapeHtml(label)}</span>
          <strong class="stat-value">${escapeHtml(value)}</strong>
          <span class="stat-detail">${escapeHtml(detail)}</span>
        </article>`,
    )
    .join("");
}

function renderAudit() {
  if (!state.audit) return;
  const config = state.audit.config || {};
  const dltSplit = state.audit.splits?.dlt || {};
  const source = state.audit.source_crosscheck || {};
  const cards = [
    ["整期代理检验", Number(config.whole_draw_shuffle_permutations || 0).toLocaleString(), "保留每期开奖内部组合"],
    ["管线公平模拟", Number(config.pipeline_null_repetitions || 0).toLocaleString(), "每次重新选择模型并训练 GA"],
    ["大乐透训练起点", dltSplit.model_start_date || "全历史", `模型使用 ${Number(dltSplit.model_draw_count || 0).toLocaleString()} 期`],
    ["早期审计保留", Number(dltSplit.excluded_pre_model_count || 0).toLocaleString(), "不进入当前模型状态计算"],
  ];
  document.querySelector("#auditStatGrid").innerHTML = cards
    .map(
      ([label, value, detail]) => `
        <article class="stat-card">
          <span class="stat-label">${escapeHtml(label)}</span>
          <strong class="stat-value">${escapeHtml(value)}</strong>
          <span class="stat-detail">${escapeHtml(detail)}</span>
        </article>`,
    )
    .join("");

  const testNames = {
    order_statistic_q: "顺序统计量 Q",
    pair_cooccurrence_max_t_rejections: "号码对 max-T",
    pair_cooccurrence_bh_fdr_rejections: "号码对 BH-FDR",
    max_cusum_change_point: "最大 CUSUM 变点",
    whole_draw_regime_distribution_shift: "早晚时期分布差异",
  };
  const periodNames = {
    full_history: "完整历史",
    pre_model_window: "2014 年前",
    model_window: "2014 年及以后",
    pre_2014_vs_2014plus: "早期 vs 现代",
  };
  const auditRows = (state.audit.summary || [])
    .filter((row) => row.lottery_code === "dlt" && row.zone === "front")
    .filter((row) => Object.hasOwn(testNames, row.test))
    .sort((a, b) => `${a.period}${a.test}`.localeCompare(`${b.period}${b.test}`));
  const auditBody = document.querySelector("#auditSummaryBody");
  auditBody.innerHTML = auditRows.length
    ? auditRows
        .map((row) => {
          const pValue = Number(row.p_value);
          const signal = Number.isFinite(pValue) && pValue <= 0.05;
          return `
            <tr>
              <td>${escapeHtml(zoneNames[row.zone] || row.zone)}</td>
              <td>${escapeHtml(periodNames[row.period] || row.period)}</td>
              <td>${escapeHtml(testNames[row.test] || row.test)}</td>
              <td>${formatNumber(row.statistic, 3)}</td>
              <td>${formatPValue(row.p_value)}</td>
              <td><span class="audit-verdict ${signal ? "is-signal" : ""}">${signal ? "发现结构" : "未拒绝零假设"}</span></td>
            </tr>`;
        })
        .join("")
    : '<tr><td colspan="6" class="empty-cell">等待 P0 审计结果</td></tr>';

  const preOrder = auditRows.find(
    (row) => row.period === "pre_model_window" && row.test === "order_statistic_q",
  );
  const postOrder = auditRows.find(
    (row) => row.period === "model_window" && row.test === "order_statistic_q",
  );
  document.querySelector("#auditFinding").innerHTML = `
    <strong>2014 年前保留审计，不进入当前大乐透模型。</strong>
    <p>早期前区顺序统计量 Q=${formatNumber(preOrder?.statistic, 2)}，2014 年及以后 Q=${formatNumber(postOrder?.statistic, 2)}。两套官方来源的号码逐期一致，日期冲突 ${Number(source.date_conflict_count ?? source.mismatch_count ?? 0)} 期。</p>
    <ul class="audit-policy-list">
      <li>双色球继续使用完整历史。</li>
      <li>大乐透从 2014-01-01 开始形成频率、转移和共现状态。</li>
      <li>早期数据仍用于年度、球组、变化点和来源审计。</li>
    </ul>`;

  const pipelineRows = (state.audit.pipeline_null || []).filter(
    (row) => row.statistic === "max_holdout_brier_skill",
  );
  document.querySelector("#pipelineNullBody").innerHTML = pipelineRows.length
    ? pipelineRows
        .map(
          (row) => `
            <tr>
              <td>${escapeHtml(row.lottery_name)}</td>
              <td>${escapeHtml(zoneNames[row.zone] || row.zone)}</td>
              <td>${formatPercent(row.observed, 3)}</td>
              <td>${formatPercent(row.global_null_q95 ?? row.null_q95, 3)}</td>
              <td>${formatPValue(row.familywise_empirical_p_value ?? row.empirical_p_value)}</td>
              <td>${Number(row.repetitions).toLocaleString()}</td>
            </tr>`,
        )
        .join("")
    : '<tr><td colspan="6" class="empty-cell">等待完整管线公平模拟</td></tr>';

  const selectedP1Rows = (state.audit.p1_hyperparameters || []).filter(
    (row) => String(row.selected).toLowerCase() === "true" || Number(row.selected) === 1,
  );
  const bootstrapRows = state.audit.moving_block_bootstrap || [];
  const calibrationRows = state.audit.calibration || [];
  const decompositionRows = state.audit.brier_decomposition || [];
  const parameterText = (row) =>
    [
      row.prior_strength !== "" ? `prior=${row.prior_strength}` : "",
      row.window !== "" ? `window=${row.window}` : "",
      row.half_life !== "" ? `half-life=${row.half_life}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  document.querySelector("#p1AuditBody").innerHTML = selectedP1Rows.length
    ? selectedP1Rows
        .map((row) => {
          const metric = state.metrics.find(
            (item) =>
              item.lottery_code === row.lottery_code &&
              item.zone === row.zone &&
              item.model === row.model,
          );
          const bootstrap = bootstrapRows.find(
            (item) =>
              item.lottery_code === row.lottery_code &&
              item.zone === row.zone &&
              item.model === row.model,
          );
          const calibration = calibrationRows.find(
            (item) =>
              item.lottery_code === row.lottery_code &&
              item.zone === row.zone &&
              item.model === row.model,
          );
          const decomposition = decompositionRows.find(
            (item) =>
              item.lottery_code === row.lottery_code &&
              item.zone === row.zone &&
              item.model === row.model,
          );
          return `
            <tr>
              <td>${escapeHtml(row.lottery_name)}</td>
              <td>${escapeHtml(zoneNames[row.zone] || row.zone)}</td>
              <td>${escapeHtml(modelNames[row.model] || row.model)}</td>
              <td>${escapeHtml(parameterText(row))}</td>
              <td>${formatNumber(row.mean_inner_brier, 6)}</td>
              <td>${formatNumber(metric?.combination_nll, 4)}</td>
              <td>${formatNumber(bootstrap?.mean_difference, 6)}</td>
              <td>${formatPValue(bootstrap?.p_value_bonferroni_within_zone ?? bootstrap?.p_value_two_sided)}</td>
              <td>${formatNumber(calibration?.expected_calibration_error, 6)} / ${formatNumber(calibration?.maximum_calibration_error, 6)}</td>
              <td>${formatNumber(decomposition?.reliability, 6)}</td>
              <td>${formatNumber(decomposition?.resolution, 6)}</td>
            </tr>`;
        })
        .join("")
    : '<tr><td colspan="11" class="empty-cell">等待 P1 审计结果</td></tr>';
}

function renderFreshness() {
  const badge = document.querySelector("#freshnessBadge");
  badge.classList.remove("is-fresh", "is-stale");
  if (state.status.app_mode === "public") {
    badge.textContent = "公开试玩 · 只读快照";
    badge.classList.add("is-fresh");
    return;
  }
  if (state.status.results_stale) {
    badge.textContent = "数据有更新，待训练";
    badge.classList.add("is-stale");
  } else {
    badge.textContent = "模型与数据一致";
    badge.classList.add("is-fresh");
  }
}

function renderLeaders() {
  const body = document.querySelector("#leaderTableBody");
  const rows = state.status.best_models || [];
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-cell">等待首次训练结果</td></tr>';
    return;
  }
  body.innerHTML = rows
    .sort((a, b) => `${a.lottery_code}${a.zone}`.localeCompare(`${b.lottery_code}${b.zone}`))
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.lottery_name)}</td>
          <td>${escapeHtml(zoneNames[row.zone] || row.zone)}</td>
          <td>${escapeHtml(modelNames[row.model] || row.model)}</td>
          <td>${formatNumber(row.mean_hits)}</td>
          <td>${formatPercent(Number(row.hit_lift) - 1)}</td>
          <td>${formatPercent(row.brier_skill_vs_uniform, 2)}</td>
        </tr>`,
    )
    .join("");
}

function renderTraining(training) {
  const container = document.querySelector("#trainingState");
  const log = document.querySelector("#trainingLog");
  const button = document.querySelector("#trainButton");
  container.className = `training-state is-${training.status || "idle"}`;
  const labels = {
    disabled: "公开快照已就绪",
    idle: "等待训练",
    queued: "训练已排队",
    running: "模型训练中",
    completed: "训练已完成",
    failed: "训练失败",
  };
  container.innerHTML = `
    <span class="status-dot"></span>
    <div>
      <strong>${escapeHtml(labels[training.status] || training.status)}</strong>
      <p>${escapeHtml(training.message || "")}</p>
    </div>`;
  button.disabled = ["queued", "running"].includes(training.status);
  button.textContent = button.disabled ? "训练中" : "重新训练";
  if (training.output) {
    log.hidden = false;
    log.textContent = training.output;
  } else {
    log.hidden = true;
  }
}

function renderSync(sync) {
  const snapshot = sync || {};
  const trusted = snapshot.trusted_time || {};
  const games = snapshot.games || {};
  const button = document.querySelector("#syncButton");
  const busy = ["queued", "running"].includes(snapshot.status);
  button.disabled = busy;
  button.textContent = busy ? "扫描中" : "立即扫描";

  const statusLabels = {
    disabled: "公开只读快照",
    idle: "等待扫描",
    queued: "扫描已排队",
    running: "联网扫描中",
    completed: "扫描完成",
    partial: "部分完成",
    failed: "扫描失败",
  };
  const sourceLabel = trusted.uses_network_time
    ? "HTTPS 网络时间"
    : trusted.source === "local_clock_fallback"
      ? "本机时间降级"
      : "尚未校时";
  const items = [
    ["状态", statusLabels[snapshot.status] || snapshot.status || "等待扫描"],
    ["可信日期", trusted.current_date || "—"],
    ["本次补入", `${Number(snapshot.appended_count || 0).toLocaleString()} 期`],
    ["最后扫描", snapshot.finished_at ? formatDateTime(snapshot.finished_at) : "—"],
  ];
  document.querySelector("#syncSummary").innerHTML = items
    .map(
      ([label, value]) => `
        <div class="sync-summary-item">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>`,
    )
    .join("");

  const gameLabels = { ssq: "双色球", dlt: "大乐透" };
  const gameStatusLabels = {
    updates_available: "发现新数据",
    up_to_date: "已是最新",
    error: "扫描异常",
  };
  document.querySelector("#syncGameList").innerHTML = Object.entries(games)
    .map(([code, game]) => {
      const appended = Number(game.appended_count || 0);
      const detail = game.error
        ? game.error
        : `${game.query_start_date || "—"} → ${game.query_end_date || "—"} · 接口 ${Number(game.fetched_count || 0)} 条 · 补入 ${appended} 期`;
      return `
        <div class="sync-game-row ${game.error ? "is-error" : ""}">
          <strong>${escapeHtml(gameLabels[code] || code)}</strong>
          <span>${escapeHtml(gameStatusLabels[game.status] || game.status || "等待")}</span>
          <p>${escapeHtml(detail)}</p>
        </div>`;
    })
    .join("");

  const message = [snapshot.message || "服务启动后会自动执行一次。", `时间源：${sourceLabel}`];
  if (trusted.errors?.length) message.push(`校时告警 ${trusted.errors.length} 条`);
  document.querySelector("#syncMessage").textContent = message.join(" · ");
}

function applyCapabilities() {
  const capabilities = state.status?.capabilities || {};
  const publicMode = state.status?.app_mode === "public";
  document.body.classList.toggle("is-public-mode", publicMode);
  document.querySelector("#trainButton").hidden = capabilities.can_train === false;
  document.querySelector('[data-view="data-entry"]').hidden =
    capabilities.can_write_draws === false;
  if (capabilities.can_write_draws === false) {
    document.querySelector("#view-data-entry").hidden = true;
    if (window.location.hash === "#data-entry") navigate("predict");
  }
}

function applySuggestedValues(gameCode, target) {
  if (!state.status) return;
  const game = state.status.games[gameCode];
  document.querySelector(`#${target}Issue`).value = game.suggested_next_issue;
  document.querySelector(`#${target}Date`).value = game.suggested_next_date;
}

function buildNumberInputs(gameCode) {
  if (!state.status) return;
  const game = state.status.games[gameCode];
  const isSsq = gameCode === "ssq";
  document.querySelector("#frontLegend").textContent = `${isSsq ? "红球" : "前区"} · ${game.front_pick} 个，1–${game.front_pool}`;
  document.querySelector("#backLegend").textContent = `${isSsq ? "蓝球" : "后区"} · ${game.back_pick} 个，1–${game.back_pool}`;
  document.querySelector("#frontInputs").innerHTML = Array.from(
    { length: game.front_pick },
    (_, index) => `<input aria-label="${isSsq ? "红球" : "前区"} ${index + 1}" inputmode="numeric" min="1" max="${game.front_pool}" required />`,
  ).join("");
  document.querySelector("#backInputs").innerHTML = Array.from(
    { length: game.back_pick },
    (_, index) => `<input aria-label="${isSsq ? "蓝球" : "后区"} ${index + 1}" inputmode="numeric" min="1" max="${game.back_pool}" required />`,
  ).join("");
}

function renderBalls(numbers, zone = "neutral") {
  const safeZone = ["front", "back"].includes(zone) ? zone : "neutral";
  return `<div class="ball-row ball-row-${safeZone}">${numbers
    .map(
      (number) =>
        `<span class="ball ball-${safeZone}">${escapeHtml(String(number).padStart(2, "0"))}</span>`,
    )
    .join("")}</div>`;
}

async function loadRecentDraws(gameCode) {
  const container = document.querySelector("#recentDraws");
  container.innerHTML = '<div class="empty-cell">读取中</div>';
  try {
    const rows = await api(`/api/draws?lottery_code=${gameCode}&limit=12`);
    container.innerHTML = rows
      .map(
        (row) => `
          <article class="recent-item">
            <div class="recent-item-header">
              <strong>${escapeHtml(row.issue)}</strong>
              <span>${escapeHtml(row.draw_date)}</span>
            </div>
            <div class="recent-number-groups">
              ${renderBalls(row.front, "front")}
              ${renderBalls(row.back, "back")}
            </div>
          </article>`,
      )
      .join("");
  } catch (error) {
    container.innerHTML = `<div class="empty-cell">${escapeHtml(error.message)}</div>`;
  }
}

function renderMetrics() {
  const gameFilter = document.querySelector("#metricsGameFilter").value;
  const zoneFilter = document.querySelector("#metricsZoneFilter").value;
  const rows = state.metrics
    .filter((row) => gameFilter === "all" || row.lottery_code === gameFilter)
    .filter((row) => zoneFilter === "all" || row.zone === zoneFilter)
    .sort((a, b) => Number(b.brier_skill_vs_uniform) - Number(a.brier_skill_vs_uniform));
  const container = document.querySelector("#metricList");
  if (!rows.length) {
    container.innerHTML = `
      <div class="result-empty compact-empty">
        <h2>等待模型训练</h2>
        <p>训练完成后会在这里显示所有模型的最终留出集结果。</p>
      </div>`;
    return;
  }
  container.innerHTML = rows
    .map((row) => {
      const skill = Number(row.brier_skill_vs_uniform);
      const width = Math.max(4, Math.min(100, ((skill + 0.02) / 0.04) * 100));
      return `
        <article class="metric-row">
          <div class="metric-name">
            <strong>${escapeHtml(modelNames[row.model] || row.model)}</strong>
            <span>${escapeHtml(row.lottery_name)} · ${escapeHtml(zoneNames[row.zone])} · ${escapeHtml(row.model_group)}</span>
          </div>
          <div>
            <div class="metric-bar" title="Brier Skill ${formatPercent(skill, 2)}">
              <div class="metric-bar-fill ${skill > 0 ? "is-positive" : ""}" style="width:${width}%"></div>
            </div>
          </div>
          <div class="metric-number">
            <strong>${formatNumber(row.mean_hits)}</strong>
            <span>平均命中</span>
          </div>
          <div class="metric-number">
            <strong>${formatNumber(row.combination_nll, 3)}</strong>
            <span>组合 NLL</span>
          </div>
          <div class="metric-number">
            <strong>${formatPercent(skill, 2)}</strong>
            <span>Brier 技能</span>
          </div>
        </article>`;
    })
    .join("");
}

function renderPredictionProgress(job) {
  state.lastPredictionProgressVersion = [
    job.updated_at || "",
    job.status || "",
    job.stage || "",
    job.progress || 0,
  ].join("|");
  const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
  const jobGameCode = job.request?.lottery_code || document.querySelector("#predictGame").value;
  const activeStageIndex = predictionPipelineStages.reduce(
    (selected, [threshold], index) => (progress >= threshold ? index : selected),
    -1,
  );
  const models = ["finalize", "completed"].includes(job.stage)
    ? []
    : Array.isArray(job.models)
      ? job.models
      : [];
  const orderedModels = predictionModelOrder.filter((name) => models.includes(name));
  models.forEach((name) => {
    if (!orderedModels.includes(name)) orderedModels.push(name);
  });
  const focusedModel = orderedModels.length === 1 ? orderedModels[0] : null;
  const modelGroupLabel = focusedModel
    ? modelNames[focusedModel] || focusedModel
    : orderedModels.length
      ? `${orderedModels.length} 个模型联合更新`
      : "数据与约束管线";
  const modelGroupDetail = focusedModel
    ? modelComputations[focusedModel] || job.detail
    : orderedModels.length
      ? job.detail || "当前阶段正在更新多个独立模型。"
      : job.detail || "正在准备模型状态。";
  const recentEvents = Array.isArray(job.events) ? job.events.slice(-5).reverse() : [];
  const zoneLabel =
    job.zone === "front"
      ? jobGameCode === "ssq"
        ? "红球"
        : "前区"
      : job.zone === "back"
        ? jobGameCode === "ssq"
          ? "蓝球"
          : "后区"
        : "全局";

  document.querySelector("#predictionResult").innerHTML = `
    <div class="prediction-progress" aria-busy="true">
      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(job.title || "启动预测实验流水线")}，进度 ${Math.round(progress)}%</p>
      <div class="progress-signal" aria-hidden="true">
        <span></span><span></span><span></span><span></span><span></span>
      </div>
      <div class="progress-heading">
        <div>
          <p class="eyebrow">LIVE EXPERIMENT PIPELINE · ${escapeHtml(zoneLabel)}</p>
          <h2>${escapeHtml(job.title || "启动预测实验流水线")}</h2>
          <p>${escapeHtml(job.detail || "正在准备模型状态。")}</p>
        </div>
        <strong class="progress-percent">${Math.round(progress)}%</strong>
      </div>
      <div class="progress-track" role="progressbar" aria-label="预测实验进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}">
        <span style="width:${progress}%"></span>
      </div>
      <div class="pipeline-stages" tabindex="0" aria-label="预测流水线阶段，可横向滚动">
        ${predictionPipelineStages
          .map(
            ([, label], index) => `
              <div class="pipeline-stage ${index < activeStageIndex ? "is-complete" : ""} ${index === activeStageIndex ? "is-active" : ""}">
                <i>${String(index + 1).padStart(2, "0")}</i>
                <span>${escapeHtml(label)}</span>
              </div>`,
          )
          .join("")}
      </div>
      <div class="active-computation">
        <div class="active-computation-meta">
          <span>${escapeHtml(zoneLabel)} · ${escapeHtml(job.stage || "startup")}</span>
          <i>${orderedModels.length ? `${orderedModels.length} MODEL${orderedModels.length > 1 ? "S" : ""}` : "PIPELINE"}</i>
        </div>
        <strong>${escapeHtml(modelGroupLabel)}</strong>
        <p>${escapeHtml(modelGroupDetail)}</p>
      </div>
      ${
        orderedModels.length
          ? `<div class="computation-grid">
              ${orderedModels
                .map(
                  (name) => `
                    <article class="computation-card ${name === focusedModel ? "is-active" : "is-participating"}">
                      <div>
                        <span>${escapeHtml(modelNames[name] || name)}</span>
                        <i>${name === focusedModel ? "当前模型" : "本阶段参与"}</i>
                      </div>
                      <p>${escapeHtml(modelComputations[name] || "生成该模型的固定大小号码排序与包含概率。")}</p>
                    </article>`,
                )
                .join("")}
            </div>`
          : `<div class="progress-console">
              <span>snapshot.lock()</span>
              <span>walk_forward = true</span>
              <span>holdout_visible = false</span>
            </div>`
      }
      ${
        recentEvents.length
          ? `<ol class="progress-events" aria-label="预测流水线最近阶段">
              ${recentEvents
                .map(
                  (event, index) => `
                    <li class="${index === 0 ? "is-latest" : ""}">
                      <i>${String(Math.round(Number(event.progress || 0))).padStart(2, "0")}%</i>
                      <span>
                        <strong>${escapeHtml(event.title || event.stage || "阶段更新")}</strong>
                        <small>${escapeHtml(event.detail || "")}</small>
                      </span>
                    </li>`,
                )
                .join("")}
            </ol>`
          : ""
      }
      <p class="progress-footnote">所有模型只能读取目标期之前的记录；最终留出结果不会参与本次选号排序。</p>
    </div>`;
}

function renderPrediction(result) {
  state.lastPrediction = result;
  const order = predictionModelOrder;
  const frontZone = result.zones.front;
  const backZone = result.zones.back;
  const isSsq = result.lottery_code === "ssq";
  const labels = {
    front: isSsq ? "红球" : "前区",
    back: isSsq ? "蓝球" : "后区",
  };

  const renderModelZone = (modelName, zoneCode, zone) => {
    const prediction = zone?.models?.[modelName];
    if (!prediction) {
      return `
        <div class="ticket-zone ticket-zone-${zoneCode} is-empty">
          <div class="ticket-zone-label">
            <strong>${escapeHtml(labels[zoneCode])}</strong>
            <span>暂无结果</span>
          </div>
        </div>`;
    }
    return `
      <div class="ticket-zone ticket-zone-${zoneCode}">
        <div class="ticket-zone-label">
          <strong>${escapeHtml(labels[zoneCode])}</strong>
          <span>${zone.pick_count} / ${zone.pool_size}</span>
        </div>
        ${renderBalls(prediction.numbers, zoneCode)}
      </div>`;
  };

  const models = order
    .filter((name) => frontZone?.models?.[name] || backZone?.models?.[name])
    .map(
      (name) => `
        <article class="model-ticket ${name === "ga_ensemble" ? "is-primary" : ""}">
          <div class="model-ticket-header">
            <strong>${escapeHtml(modelNames[name] || name)}</strong>
            <span>${name === "ga_ensemble" ? "验证集选权 · 留出集检验" : "独立模型"}</span>
          </div>
          <div class="ticket-zones">
            ${renderModelZone(name, "front", frontZone)}
            ${renderModelZone(name, "back", backZone)}
          </div>
        </article>`,
    )
    .join("");

  document.querySelector("#predictionResult").innerHTML = `
    <div class="prediction-header">
      <div>
        <span>${escapeHtml(result.lottery_name)} · ${escapeHtml(result.issue)}</span>
        <h2>${escapeHtml(result.target_date)}</h2>
      </div>
      <div class="prediction-header-side">
        <div class="prediction-actions" aria-label="分享预测结果">
          <button class="button button-compact" id="shareImageButton" type="button">分享图片</button>
          <button class="button button-compact" id="copyPredictionButton" type="button">复制文本</button>
        </div>
        <div class="prediction-legend" aria-label="号码颜色图例">
          <span><i class="legend-ball is-front" aria-hidden="true"></i>${escapeHtml(labels.front)}</span>
          <span><i class="legend-ball is-back" aria-hidden="true"></i>${escapeHtml(labels.back)}</span>
        </div>
      </div>
    </div>
    <div class="prediction-model-grid">${models}</div>
    <p class="form-note">${escapeHtml(result.warning)}</p>`;

  document.querySelector("#shareImageButton").addEventListener("click", sharePredictionImage);
  document.querySelector("#copyPredictionButton").addEventListener("click", copyPredictionText);
}

async function sharePredictionImage(event) {
  const button = event.currentTarget;
  if (state.imageShareInFlight) return;
  if (!state.lastPrediction || !window.LotteryShare) {
    showToast("分享模块尚未就绪", true);
    return;
  }
  state.imageShareInFlight = true;
  button.disabled = true;
  button.textContent = "生成中";
  try {
    const result = await window.LotteryShare.sharePredictionCard(state.lastPrediction, {
      modelOrder: predictionModelOrder,
      width: 720,
    });
    const messages = {
      "web-share": "已打开系统分享",
      download: "分享卡片已下载",
      copy: "当前环境不支持图片分享，已复制号码文本",
      cancelled: "已取消分享",
    };
    showToast(messages[result.method] || "分享卡片已生成");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.imageShareInFlight = false;
    button.disabled = false;
    button.textContent = "分享图片";
  }
}

async function copyPredictionText(event) {
  const button = event.currentTarget;
  if (!state.lastPrediction || !window.LotteryShare) {
    showToast("分享模块尚未就绪", true);
    return;
  }
  button.disabled = true;
  try {
    const text = await window.LotteryShare.copyPredictionText(
      state.lastPrediction,
      predictionModelOrder,
    );
    const lineCount = text ? text.split("\n").length : 0;
    showToast(`已复制 ${lineCount} 行预测号码`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function resetPredictionButton(button) {
  button.disabled = false;
  button.classList.remove("is-running");
  button.removeAttribute("aria-busy");
}

async function pollPredictionJob(jobId, button) {
  try {
    const job = await api(`/api/predict-status?job_id=${encodeURIComponent(jobId)}`);
    const version = [
      job.updated_at || "",
      job.status || "",
      job.stage || "",
      job.progress || 0,
    ].join("|");
    if (job.status === "completed") {
      if (version !== state.lastPredictionProgressVersion) renderPredictionProgress(job);
      window.clearTimeout(state.predictionPollingTimer);
      const elapsed = performance.now() - state.predictionStartedAt;
      const revealDelay = Math.max(260, 1800 - elapsed);
      state.predictionPollingTimer = window.setTimeout(() => {
        renderPrediction(job.result);
        resetPredictionButton(button);
        showToast("预测实验已完成");
      }, revealDelay);
      return;
    }
    if (job.status === "failed") {
      throw new Error(job.error || job.detail || "预测实验失败");
    }
    if (version !== state.lastPredictionProgressVersion) renderPredictionProgress(job);
    state.predictionPollingTimer = window.setTimeout(
      () => pollPredictionJob(jobId, button),
      380,
    );
  } catch (error) {
    window.clearTimeout(state.predictionPollingTimer);
    resetPredictionButton(button);
    document.querySelector("#predictionResult").innerHTML = `
      <div class="result-empty">
        <span class="result-kicker">PIPELINE STOPPED</span>
        <h2>预测实验未完成</h2>
        <p>${escapeHtml(error.message)}</p>
      </div>`;
    showToast(error.message, true);
  }
}

async function startPredictionJob(payload, button) {
  window.clearTimeout(state.predictionPollingTimer);
  state.lastPredictionProgressVersion = null;
  state.predictionStartedAt = performance.now();
  button.disabled = true;
  button.classList.add("is-running");
  button.setAttribute("aria-busy", "true");
  const response = await api("/api/predict", {
    method: "POST",
    body: JSON.stringify({ ...payload, async: true }),
  });
  renderPredictionProgress(response.job);
  await pollPredictionJob(response.job.job_id, button);
}

async function loadStatus() {
  state.status = await api("/api/status");
  applyCapabilities();
  renderStats();
  renderFreshness();
  renderLeaders();
  renderTraining(state.status.training);
  renderSync(state.status.sync);
  applySuggestedValues(document.querySelector("#predictGame").value, "predict");
  if (state.status.capabilities?.can_write_draws !== false) {
    applySuggestedValues(document.querySelector("#entryGame").value, "entry");
    buildNumberInputs(document.querySelector("#entryGame").value);
    await loadRecentDraws(document.querySelector("#entryGame").value);
  }
}

async function loadMetrics() {
  state.metrics = await api("/api/metrics");
  renderMetrics();
  if (state.audit) renderAudit();
}

async function loadAudit() {
  state.audit = await api("/api/audit");
  renderAudit();
}

async function startTraining() {
  try {
    const result = await api("/api/train", { method: "POST", body: "{}" });
    renderTraining(result.training);
    showToast("训练任务已启动");
    beginTrainingPolling();
  } catch (error) {
    showToast(error.message, true);
  }
}

function beginTrainingPolling() {
  window.clearInterval(state.pollingTimer);
  state.pollingTimer = window.setInterval(async () => {
    try {
      const training = await api("/api/training-status");
      renderTraining(training);
      if (["completed", "failed"].includes(training.status)) {
        window.clearInterval(state.pollingTimer);
        if (training.status === "completed") {
          showToast("训练与留出回测完成");
          await Promise.all([loadStatus(), loadMetrics(), loadAudit()]);
        } else {
          showToast("训练失败，请查看日志", true);
        }
      }
    } catch (error) {
      window.clearInterval(state.pollingTimer);
      showToast(error.message, true);
    }
  }, 1800);
}

async function startSync() {
  try {
    const result = await api("/api/sync", { method: "POST", body: "{}" });
    renderSync(result.sync);
    showToast("已开始联网校时和缺失开奖扫描");
    beginSyncPolling();
  } catch (error) {
    showToast(error.message, true);
  }
}

function beginSyncPolling() {
  window.clearInterval(state.syncPollingTimer);
  state.syncPollingTimer = window.setInterval(async () => {
    try {
      const sync = await api("/api/sync-status");
      renderSync(sync);
      if (["completed", "partial", "failed"].includes(sync.status)) {
        window.clearInterval(state.syncPollingTimer);
        if (sync.status === "completed") {
          showToast(
            Number(sync.appended_count || 0) > 0
              ? `自动补入 ${Number(sync.appended_count).toLocaleString()} 期，请重新训练`
              : "扫描完成，当前开奖数据已是最新",
          );
        } else if (sync.status === "partial") {
          showToast("部分彩种扫描完成，请查看扫描详情", true);
        } else {
          showToast("自动扫描失败，请查看扫描详情", true);
        }
        await loadStatus();
      }
    } catch (error) {
      window.clearInterval(state.syncPollingTimer);
      showToast(error.message, true);
    }
  }, 1200);
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.view));
  });
  document.querySelectorAll("[data-jump]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.jump));
  });
  window.addEventListener("hashchange", () => {
    const view = window.location.hash.slice(1);
    if (["overview", "audit", "predict", "data-entry", "models"].includes(view)) navigate(view);
  });

  document.querySelector("#trainButton").addEventListener("click", startTraining);
  document.querySelector("#syncButton").addEventListener("click", startSync);
  document.querySelector("#predictGame").addEventListener("change", (event) => {
    applySuggestedValues(event.target.value, "predict");
  });
  document.querySelector("#entryGame").addEventListener("change", async (event) => {
    applySuggestedValues(event.target.value, "entry");
    buildNumberInputs(event.target.value);
    await loadRecentDraws(event.target.value);
  });
  document.querySelector("#metricsGameFilter").addEventListener("change", renderMetrics);
  document.querySelector("#metricsZoneFilter").addEventListener("change", renderMetrics);

  document.querySelector("#predictionForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    try {
      const payload = {
        lottery_code: document.querySelector("#predictGame").value,
        issue: document.querySelector("#predictIssue").value.trim(),
        draw_date: document.querySelector("#predictDate").value,
      };
      await startPredictionJob(payload, button);
    } catch (error) {
      resetPredictionButton(button);
      showToast(error.message, true);
    }
  });

  document.querySelector("#dataEntryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    const values = (selector) =>
      [...document.querySelectorAll(selector)].map((input) => Number(input.value));
    button.disabled = true;
    button.textContent = "保存中";
    try {
      const payload = {
        lottery_code: document.querySelector("#entryGame").value,
        issue: document.querySelector("#entryIssue").value.trim(),
        draw_date: document.querySelector("#entryDate").value,
        front: values("#frontInputs input"),
        back: values("#backInputs input"),
      };
      await api("/api/draws", { method: "POST", body: JSON.stringify(payload) });
      showToast("开奖记录已保存，请重新训练模型");
      document.querySelectorAll(".number-inputs input").forEach((input) => (input.value = ""));
      await loadStatus();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = "保存开奖记录";
    }
  });
}

async function initialize() {
  bindEvents();
  const initialView = window.location.hash.slice(1);
  navigate(["overview", "audit", "predict", "data-entry", "models"].includes(initialView) ? initialView : "overview");
  try {
    await Promise.all([loadStatus(), loadMetrics(), loadAudit()]);
    if (["queued", "running"].includes(state.status.training.status)) beginTrainingPolling();
    if (["queued", "running"].includes(state.status.sync?.status)) beginSyncPolling();
  } catch (error) {
    showToast(`无法连接本地服务：${error.message}`, true);
  }
}

document.addEventListener("DOMContentLoaded", initialize);
