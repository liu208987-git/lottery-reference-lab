/* ===== 彩票预测可视化平台 - 前端逻辑 ===== */

let currentGame = "ssq";
let charts = {};

// Desktop WebView2 can restore the last scroll position between launches.
// The application should always open on the IOI brand and overview header.
if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
}
window.addEventListener("load", () => window.scrollTo(0, 0), { once: true });

// ============================================================
// 工具函数
// ============================================================

function showToast(msg, type = "info") {
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function formatBalls(reds, blues) {
    let html = "";
    for (const r of reds) {
        html += `<span class="ball ball-red">${String(r).padStart(2, "0")}</span>`;
    }
    if (blues) {
        for (const b of blues) {
            html += `<span class="ball ball-blue">${String(b).padStart(2, "0")}</span>`;
        }
    }
    return html;
}

function hitBadge(maxRed) {
    const cls = maxRed >= 4 ? "hit-4" : maxRed >= 3 ? "hit-3" : maxRed >= 2 ? "hit-2" : "hit-" + maxRed;
    const unit = currentGame === "ssq" ? "红" : "前区";
    return `<span class="hit-badge ${cls}">${maxRed}${unit}</span>`;
}

// 所有命中趋势和分布统一只显示最近30期
function chartWindowLimit() {
    return 30;
}

async function fetchJSON(url, options) {
    const res = await fetch(url, options);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "请求失败");
    return data;
}

// ============================================================
// 仪表盘
// ============================================================

async function loadDashboard() {
    try {
        const data = await fetchJSON("/api/dashboard");
        for (const game of ["ssq", "dlt"]) {
            const d = data[game];
            const name = game === "ssq" ? "双色球" : "大乐透";
            document.getElementById(`${game}-total`).textContent = d.total_draws;
            document.getElementById(`${game}-range`).textContent = `${d.range[0]} ~ ${d.range[1]}`;
            document.getElementById(`${game}-settled`).textContent = d.settled_count;
            document.getElementById(`${game}-ge4`).textContent = d.ge4_count;
            document.getElementById(`${game}-ge3`).textContent = d.ge3_count;
            document.getElementById(`${game}-blue`).textContent = d.blue_hit_count;
            document.getElementById(`${game}-prize`).textContent = d.prize_count;
            const denominator = d.settled_count || 0;
            const rateText = value => denominator ? `${(value / denominator * 100).toFixed(2)}%` : "暂无样本";
            document.getElementById(`${game}-settled-sub`).textContent = d.backtest_note || `${d.algorithm_version.label} 生产回测`;
            document.getElementById(`${game}-ge4-sub`).textContent = rateText(d.ge4_count);
            document.getElementById(`${game}-ge3-sub`).textContent = rateText(d.ge3_count);
            document.getElementById(`${game}-blue-sub`).textContent = rateText(d.blue_hit_count);
            document.getElementById(`${game}-prize-sub`).textContent = rateText(d.prize_count);
            // 渲染奖项等级汇总
            renderPrizeBreakdown(game, d.prize_breakdown || {}, name, d.algorithm_version);
        }
    } catch (e) {
        showToast("加载仪表盘失败: " + e.message, "error");
    }
}

// 奖项等级中文数字映射
const PRIZE_CN_MAP = {"一":1,"二":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9};

function renderPrizeBreakdown(game, breakdown, gameName, versionInfo) {
    const container = document.getElementById(`${game}-prize-breakdown`);
    const prizes = Object.keys(breakdown);
    if (prizes.length === 0) {
        container.innerHTML = "";
        return;
    }
    // 按等级排序（一等在前）
    prizes.sort((a, b) => {
        const ra = PRIZE_CN_MAP[a.charAt(0)] || 99;
        const rb = PRIZE_CN_MAP[b.charAt(0)] || 99;
        return ra - rb;
    });
    let html = `<div class="prize-breakdown-title"><span>${gameName}奖项等级汇总（已结算全量）</span>`;
    if (versionInfo && versionInfo.label) {
        html += `<span class="algo-version-badge">算法 ${versionInfo.label} · ${versionInfo.desc}</span>`;
    }
    html += `</div>`;
    for (const prize of prizes) {
        const lv = PRIZE_CN_MAP[prize.charAt(0)] || 9;
        const short = prize.replace(/等奖.*/, "等").replace(/等奖$/, "等");
        html += `<div class="prize-chip lv${lv}">`;
        html += `<span class="chip-name">${short}</span>`;
        html += `<span class="chip-count">${breakdown[prize]}</span>`;
        html += `</div>`;
    }
    container.innerHTML = html;
}

function signedPercent(value) {
    const percentage = Number(value || 0) * 100;
    return `${percentage > 0 ? "+" : ""}${percentage.toFixed(2)}`;
}

async function loadSingleTicket() {
    const container = document.getElementById("single-ticket-content");
    container.innerHTML = `<div class="loading single-loading"><div class="spinner"></div><p>加载单注决策层...</p></div>`;
    try {
        const data = await fetchJSON(`/api/single-ticket/${currentGame}`);
        const ticket = data.recommended_ticket;
        const compressed = data.compressed_ticket;
        const comparison = data.backtest.comparison;
        const aggregate = data.backtest.aggregate;
        const baseline = data.backtest.baseline;
        const supported = data.strategy === "aggregate";
        const windows = [
            ["全历史", comparison.all_history_current_rules],
            ["后30%", comparison.last_30_percent_current_rules],
            ["近100期", comparison.last_100_current_rules],
        ];
        let html = `<section class="single-decision ${supported ? "single-supported" : "single-fallback"}">`;
        html += `<div class="single-decision-head">`;
        html += `<div><span class="section-kicker">ONE-BET DECISION</span>`;
        html += `<h4>第 ${data.issue} 期单注采用建议</h4></div>`;
        html += `<span class="single-strategy-badge">${data.strategy_label}</span></div>`;
        html += `<div class="single-ticket-main">${formatBalls(ticket.reds, ticket.blues)}</div>`;
        html += `<div class="single-reason">${data.recommendation_reason}；训练截止 ${data.trained_through}。</div>`;
        html += `<div class="single-comparison-grid">`;
        for (const [label, row] of windows) {
            const positive = row.absolute_change > 0;
            html += `<div class="single-comparison-item">`;
            html += `<span>${label} · ${row.draws}期</span>`;
            html += `<strong>${(row.aggregate_rate * 100).toFixed(2)}% <i>vs</i> ${(row.baseline_rate * 100).toFixed(2)}%</strong>`;
            html += `<small class="${positive ? "delta-up" : "delta-down"}">${signedPercent(row.absolute_change)} 个百分点</small>`;
            html += `</div>`;
        }
        html += `</div>`;

        const differs =
            JSON.stringify(ticket.reds) !== JSON.stringify(compressed.reds)
            || JSON.stringify(ticket.blues) !== JSON.stringify(compressed.blues);
        if (differs) {
            html += `<div class="compressed-alternative"><span>聚合算法原始输出（回测未采用）</span>`;
            html += `<div>${formatBalls(compressed.reds, compressed.blues)}</div></div>`;
        }

        const levels = currentGame === "ssq"
            ? ["一等奖", "二等奖", "三等奖", "四等奖", "五等奖", "六等奖"]
            : ["一等奖", "二等奖", "三等奖", "四等奖", "五等奖", "六等奖", "七等奖"];
        html += `<details class="single-details"><summary>查看全部奖级与命中统计</summary>`;
        html += `<div class="single-detail-summary">统一按现行规则重分类 · 聚合 ${aggregate.current_rule_wins}/${aggregate.draws} · 原首选 ${baseline.current_rule_wins}/${baseline.draws}</div>`;
        html += `<div class="table-wrap single-prize-table"><table><thead><tr><th>奖级</th><th>聚合单注</th><th>原首选单注</th></tr></thead><tbody>`;
        for (const level of levels) {
            html += `<tr><td>${level}</td><td>${aggregate.current_rule_prizes[level] || 0}</td><td>${baseline.current_rule_prizes[level] || 0}</td></tr>`;
        }
        html += `</tbody></table></div>`;
        html += `<div class="single-hit-lines">`;
        html += `<span>聚合前区命中分布：${Object.entries(aggregate.red_hit_distribution).map(([k,v]) => `${k}个=${v}`).join("　")}</span>`;
        html += `<span>聚合后区命中分布：${Object.entries(aggregate.blue_hit_distribution).map(([k,v]) => `${k}个=${v}`).join("　")}</span>`;
        html += `</div></details>`;
        html += `<div class="single-caveat">高奖模式以同成本五注的高阶联合命中为晋升目标。</div>`;
        html += `</section>`;
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<div class="ranking-notice"><strong>单注决策层暂不可用</strong><span>${e.message}</span></div>`;
    }
}

// ============================================================
// 预测展示
// ============================================================

async function loadPredictions() {
    const container = document.getElementById("prediction-content");
    container.innerHTML = `<div class="loading"><div class="spinner"></div><p>加载预测中...</p></div>`;
    try {
        const pred = await fetchJSON(`/api/predictions/${currentGame}`);
        let html = "";

        // 预测信息
        const modelName = pred.model?.red || "unknown";
        const isSettled = pred.settled_at !== null;
        html += `<div style="margin-bottom:12px;color:var(--text-dim);font-size:14px;">`;
        html += `预测期号：<strong style="color:#fff">${pred.issue}</strong> | `;
        html += `算法：<strong style="color:#fff">${pred.algorithm}</strong> | `;
        html += `状态：<strong style="color:${isSettled ? "var(--green)" : "var(--yellow)"}">${isSettled ? "已结算" : "待开奖"}</strong>`;
        html += `</div>`;
        html += `<div class="ranking-notice"><strong>预算购买顺序（预测时锁定）</strong>`;
        html += `<span>资金购买K注时固定选择优先1～K。结构指数只用于安排顺序，不是真实中奖概率；严格回测尚未证明优先1比其余号码更容易中奖。</span></div>`;

        // 5注号码：从优先1开始的固定前缀购买顺序
        const analysis = pred.ticket_analysis || [];
        const ticketOrder = analysis.length > 0
            ? analysis.map(a => a.index)
            : pred.tickets.map((_, i) => i);

        for (let rank = 0; rank < ticketOrder.length; rank++) {
            const i = ticketOrder[rank];
            const [reds, blues] = pred.tickets[i];
            const a = analysis.find(x => x.index === i);

            let info = "";
            if (isSettled && pred.metrics) {
                const detail = pred.metrics.details[i];
                if (detail) {
                    info = `红中${detail.red_hits} 蓝中${detail.blue_hits}`;
                    if (detail.prize) info += ` ${detail.prize}`;
                }
            }
            html += `<div class="ticket${rank === 0 ? ' ticket-priority-top' : ''}">`;
            html += `<div class="ticket-num">优先购买 ${rank + 1}${rank === 0 ? ' ◈' : ''}</div>`;
            html += `<div class="ticket-balls">${formatBalls(reds, blues)}</div>`;
            if (info) {
                html += `<div class="ticket-info">${info}</div>`;
            }
            // 每注概率分析
            if (a) {
                const indexColor = a.priority_index >= 70 ? "var(--green)" : a.priority_index >= 50 ? "var(--yellow)" : "var(--text-dim)";
                html += `<div class="ticket-analysis">`;
                html += `<div class="ticket-analysis-row">`;
                html += `<span class="priority-pill">走期实测优先指数：<strong style="color:${indexColor}">${a.priority_index}/100</strong></span>`;
                html += `<span>排序依据：<strong style="color:var(--blue)">只读取本期开奖前数据</strong></span>`;
                html += `</div></div>`;
            }
            html += `</div>`;
        }

        const validation = pred.ranking_validation;
        if (validation) {
            const lift = (validation.rank1_observed_lift - 1) * 100;
            const liftText = `${lift >= 0 ? "+" : ""}${lift.toFixed(1)}%`;
            const validationRecords = validation.validation_records || validation.holdout_records;
            const strictWalkForward = validation.validation_method === "strict_walk_forward_all_periods";
            html += `<div class="ranking-validation">`;
            html += `<div><strong>${strictWalkForward ? "严格走期排序实测" : "排序留出段实测"}</strong><span>${validationRecords}期 · ${strictWalkForward ? "每期只使用开奖前数据" : "前70%选参数 / 后30%独立验证"}</span></div>`;
            html += `<div class="ranking-validation-metrics">`;
            html += `<span>优先1中奖率 <strong>${(validation.rank1_win_rate * 100).toFixed(2)}%</strong></span>`;
            html += `<span>五名次平均 <strong>${(validation.all_rank_average * 100).toFixed(2)}%</strong></span>`;
            html += `<span>相对平均 <strong>${liftText}</strong></span>`;
            html += `<span class="weak-signal">未通过单调性验收 · 不可解释为概率排序</span>`;
            html += `</div></div>`;
            if (validation.rank_win_rates?.length === 5) {
                html += `<div class="ranking-validation" style="margin-top:8px"><div><strong>优先1～5逐注中奖率</strong><span>${validation.rank_win_rates.map((v, i) => `${i + 1}:${(v * 100).toFixed(2)}%`).join("　")}</span></div>`;
                if (validation.prefix_fixed_rois?.length === 5) {
                    html += `<div class="ranking-validation-metrics"><span>买前1～5注固定奖金ROI</span><span><strong>${validation.prefix_fixed_rois.map(v => `${(v * 100).toFixed(2)}%`).join("　")}</strong></span></div>`;
                }
                html += `</div>`;
            }
        }

        // 回测概率汇总
        if (pred.probability) {
            const p = pred.probability;
            html += `<div style="margin-top:12px;padding:12px;background:rgba(78,138,255,0.08);border:1px solid rgba(78,138,255,0.2);border-radius:8px;">`;
            html += `<strong style="color:var(--blue)">5注滚动验证（最近${p.validation_periods || 100}期）</strong><br>`;
            html += `<div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;font-size:13px;">`;
            html += `<span>5注任中≥4红：<strong style="color:var(--yellow)">${(p.p_ge4_red * 100).toFixed(2)}%</strong></span>`;
            html += `<span>5注任中≥3红：<strong style="color:var(--green)">${(p.p_ge3_red * 100).toFixed(2)}%</strong></span>`;
            html += `<span>蓝球命中率：<strong style="color:var(--blue)">${(p.blue_rate * 100).toFixed(2)}%</strong></span>`;
            html += `</div></div>`;
        }

        // 如果已结算，显示命中总结
        if (isSettled && pred.metrics) {
            const m = pred.metrics;
            html += `<div style="margin-top:12px;padding:12px;background:rgba(255,255,255,0.03);border-radius:8px;">`;
            html += `<strong>命中总结：</strong>最高红球${m.max_red_hits} | `;
            html += `后区覆盖中${m.union_blue_hits || 0}个（单注最高${m.max_blue_hits || 0}个） | `;
            html += `中奖票${m.winning_tickets}注 | `;
            html += `最好奖级：${m.best_prize_name || "未中奖"}`;
            html += `</div>`;
        }

        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<div class="loading"><p>暂无预测数据，请先运行预测程序</p></div>`;
    }
}

// ============================================================
// 命中历史
// ============================================================

async function loadHistory() {
    const container = document.getElementById("history-table-body");
    container.innerHTML = `<tr><td colspan="7" class="loading"><div class="spinner"></div></td></tr>`;
    try {
        const data = await fetchJSON(`/api/history/${currentGame}?limit=50`);
        if (!data || data.length === 0) {
            container.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-dim)">暂无已结算的预测记录</td></tr>`;
            return;
        }

        let html = "";
        for (const item of data) {
            const m = item.metrics;
            if (!m) continue;
            const actual = item.actual;
            // SSQ存储blue(单数int)，DLT存储blues(复数list)，兼容两种
            const reds = actual && actual.reds ? actual.reds : [];
            const blues = actual ? (actual.blues || (actual.blue != null ? [actual.blue] : [])) : [];
            const redsStr = reds.length > 0 ? reds.map(r => String(r).padStart(2, "0")).join(" ") : "-";
            const bluesStr = blues.length > 0 ? blues.map(b => String(b).padStart(2, "0")).join(" ") : "-";
            const bestPrize = m.best_prize_name || "-";
            const prizeColor = m.winning_tickets > 0 ? "var(--green)" : "var(--text-dim)";

            html += `<tr>`;
            html += `<td>${item.issue}</td>`;
            html += `<td>${item.algorithm}</td>`;
            html += `<td>${redsStr} + ${bluesStr}</td>`;
            html += `<td>${hitBadge(m.max_red_hits)}</td>`;
            const backHits = Number(m.union_blue_hits || 0);
            html += `<td><span class="back-hit ${backHits ? "is-hit" : ""}">${backHits ? `中${backHits}个` : "未中"}</span></td>`;
            html += `<td>${m.winning_tickets}</td>`;
            html += `<td style="color:${prizeColor};font-weight:600">${bestPrize}</td>`;
            html += `</tr>`;
        }
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--red)">加载失败: ${e.message}</td></tr>`;
    }
}

// ============================================================
// 图表：命中趋势
// ============================================================

async function loadCharts() {
    try {
        const data = await fetchJSON(`/api/history/${currentGame}?limit=${chartWindowLimit()}`);
        if (!data || data.length === 0) return;

        // 按期号正序排列
        const sorted = data.filter(d => d.metrics).reverse();

        const labels = sorted.map(d => d.issue);
        const redHits = sorted.map(d => Number(
            d.metrics.total_red_hits
            ?? d.metrics.details.reduce((sum, row) => sum + Number(row.red_hits || 0), 0)
        ));
        const blueHits = sorted.map(d => Number(
            d.metrics.total_blue_hits
            ?? d.metrics.details.reduce((sum, row) => sum + Number(row.blue_hits || 0), 0)
        ));
        const predictedRedSlots = sorted.map(d =>
            d.metrics.details.reduce((sum, row) => sum + row.reds.length, 0)
        );
        const predictedBlueSlots = sorted.map(d =>
            d.metrics.details.reduce((sum, row) => sum + row.blues.length, 0)
        );
        const redMisses = predictedRedSlots.map((count, index) => count - redHits[index]);
        const blueMisses = predictedBlueSlots.map((count, index) => count - blueHits[index]);
        const prizeNames = sorted.map(d => d.metrics.best_prize_name || "未中奖");
        const winningTickets = sorted.map(d => Number(d.metrics.winning_tickets || 0));
        const maxReds = sorted.map(d => d.metrics.max_red_hits);

        // 图表1：五注红蓝预测球位堆叠，实色为命中、淡色为未中。
        renderTrendChart(
            labels, redHits, redMisses, blueHits, blueMisses,
            prizeNames, winningTickets
        );

        // 图表2：奖级分布环形图
        const prizeDist = {};
        for (const d of sorted) {
            const name = d.metrics.best_prize_name || "未中奖";
            // 简化为"X等"格式
            let short = "未中奖";
            if (name !== "未中奖") {
                const m = name.match(/([一二三四五六七八九])等/);
                if (m) short = m[1] + "等";
            }
            prizeDist[short] = (prizeDist[short] || 0) + 1;
        }
        const redDist = {0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0};
        for (const d of sorted) {
            const r = d.metrics.max_red_hits;
            if (r in redDist) redDist[r]++;
        }
        renderDistChart(redDist, prizeDist);

        // 图表3：每期中奖奖级趋势
        const prizeRanks = sorted.map(d => d.metrics.best_prize || 0);
        renderPrizeTrendChart(labels, prizeRanks, prizeNames);

    } catch (e) {
        console.error("图表加载失败:", e);
    }
}

function renderTrendChart(
    labels, redHits, redMisses, blueHits, blueMisses,
    prizeNames, winningTickets
) {
    const ctx = document.getElementById("chart-trend").getContext("2d");
    if (charts.trend) charts.trend.destroy();

    // 柱顶直接标明实际中奖情况。
    const barPrizePlugin = {
        id: "barPrizeLabels",
        afterDatasetsDraw(chart) {
            const {ctx} = chart;
            const meta = chart.getDatasetMeta(chart.data.datasets.length - 1);
            ctx.save();
            ctx.font = "bold 8px sans-serif";
            meta.data.forEach((bar, i) => {
                const won = winningTickets[i] > 0;
                const short = won
                    ? prizeNames[i].replace(/等奖.*/, "等").replace(/等奖$/, "等")
                    : "未中奖";
                const label = won ? `${winningTickets[i]}注·${short}` : "未中";
                ctx.fillStyle = won ? "#2af5b1" : "#7f96b8";
                ctx.save();
                ctx.translate(bar.x - 2, bar.y - 6);
                ctx.rotate(-Math.PI / 3);
                ctx.textAlign = "left";
                ctx.fillText(label, 0, 0);
                ctx.restore();
            });
            ctx.restore();
        },
    };

    charts.trend = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels,
            datasets: [
                {
                    label: "红球/前区实际命中",
                    data: redHits,
                    backgroundColor: "rgba(233,69,96,0.96)",
                    borderColor: "#ff6f91",
                    borderWidth: 1,
                    stack: "fiveTickets",
                },
                {
                    label: "红球/前区预测未中",
                    data: redMisses,
                    backgroundColor: "rgba(233,69,96,0.20)",
                    borderColor: "rgba(255,111,145,0.34)",
                    borderWidth: 1,
                    stack: "fiveTickets",
                },
                {
                    label: "蓝球/后区实际命中",
                    data: blueHits,
                    backgroundColor: "rgba(78,138,255,0.98)",
                    borderColor: "#79b4ff",
                    borderWidth: 1,
                    stack: "fiveTickets",
                },
                {
                    label: "蓝球/后区预测未中",
                    data: blueMisses,
                    backgroundColor: "rgba(78,138,255,0.18)",
                    borderColor: "rgba(121,180,255,0.34)",
                    borderWidth: 1,
                    stack: "fiveTickets",
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { top: 36 } },
            plugins: {
                legend: {
                    display: true,
                    labels: { color: "#b9c8e0", boxWidth: 12, boxHeight: 8 },
                },
                tooltip: {
                    callbacks: {
                        afterBody: function(ctx) {
                            const index = ctx[0].dataIndex;
                            return [
                                `实际结果: ${winningTickets[index] ? `中${winningTickets[index]}注` : "未中奖"}`,
                                `最佳奖级: ${prizeNames[index]}`,
                            ];
                        },
                    },
                },
            },
            scales: {
                y: {
                    beginAtZero: true,
                    stacked: true,
                    title: { display: true, text: "五注预测球位（实色=命中）", color: "#8892b0" },
                    ticks: { color: "#8892b0", precision: 0 },
                    grid: { color: "rgba(255,255,255,0.05)" },
                },
                x: { ticks: { color: "#8892b0", maxRotation: 90, autoSkip: true, maxTicksLimit: 20 }, grid: { display: false } },
            },
        },
        plugins: [barPrizePlugin],
    });
}

async function loadDiagnostics() {
    const container = document.getElementById("failure-diagnostics");
    if (!container) return;
    container.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
    try {
        const d = await fetchJSON(`/api/diagnostics/${currentGame}?limit=30`);
        const area = currentGame === "ssq" ? "红球" : "前区";
        let html = `<div class="diagnostic-summary">`;
        html += `<div><span>30期中奖</span><strong>${d.win_periods}/${d.periods}</strong></div>`;
        html += `<div><span>号码池平均命中</span><strong>${d.average_union_red_hits.toFixed(2)} ${area}</strong></div>`;
        html += `<div><span>单注平均最高</span><strong>${d.average_max_red_hits.toFixed(2)} ${area}</strong></div>`;
        html += `<div><span>后区覆盖 / 对齐</span><strong>${d.blue_covered_periods} / ${d.blue_aligned_periods}</strong></div>`;
        html += `<div><span>命中拆散期数</span><strong>${d.fragmented_periods}</strong></div>`;
        html += `</div>`;
        html += `<div class="diagnostic-findings"><div><b>主要结论</b><span>${d.finding}</span></div>`;
        html += `<div><b>算法动作</b><span>${d.algorithm_action}</span></div></div>`;
        html += `<div class="diagnostic-reasons">`;
        for (const row of d.primary_reasons) {
            html += `<div><span>${row.reason}</span><strong>${row.periods}期 · ${(row.share_of_misses * 100).toFixed(1)}%</strong></div>`;
        }
        html += `</div>`;
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<div class="loading"><p>诊断加载失败：${e.message}</p></div>`;
    }
}

function renderDistChart(redDist, prizeDist) {
    const ctx = document.getElementById("chart-dist").getContext("2d");
    if (charts.dist) charts.dist.destroy();

    // 如果有奖级分布，用奖级分布代替红球分布
    if (prizeDist && Object.values(prizeDist).some(v => v > 0)) {
        const prizeOrder = ["未中奖", "九等", "八等", "七等", "六等", "五等", "四等", "三等", "二等", "一等"];
        const labels = prizeOrder.filter(k => prizeDist[k] !== undefined && prizeDist[k] > 0);
        const data = labels.map(k => prizeDist[k]);
        const colors = labels.map(k => {
            if (k === "未中奖") return "rgba(136,146,176,0.3)";
            if (k === "一等") return "rgba(233,69,96,1)";
            if (k === "二等") return "rgba(255,99,132,0.9)";
            if (k === "三等") return "rgba(255,165,0,1)";
            if (k === "四等") return "rgba(255,214,10,0.9)";
            if (k === "五等") return "rgba(255,214,10,0.7)";
            if (k === "六等") return "rgba(0,212,170,0.9)";
            if (k === "七等") return "rgba(0,212,170,0.7)";
            if (k === "八等") return "rgba(0,212,170,0.5)";
            return "rgba(78,138,255,0.6)";
        });
        charts.dist = new Chart(ctx, {
            type: "doughnut",
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: colors,
                    borderColor: "#16213e",
                    borderWidth: 2,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: "right", labels: { color: "#e0e0e0" } },
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                const total = data.reduce((a, b) => a + b, 0);
                                const pct = (ctx.parsed / total * 100).toFixed(1);
                                return `${labels[ctx.dataIndex]}: ${ctx.parsed}期 (${pct}%)`;
                            },
                        },
                    },
                },
            },
        });
        return;
    }

    // 回退：红球命中分布
    const labels = Object.keys(redDist).map(k => k + "红");
    const data = Object.values(redDist);
    charts.dist = new Chart(ctx, {
        type: "doughnut",
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: [
                    "rgba(136,146,176,0.3)",
                    "rgba(136,146,176,0.5)",
                    "rgba(78,138,255,0.6)",
                    "rgba(0,212,170,0.7)",
                    "rgba(255,214,10,0.8)",
                    "rgba(255,165,0,0.9)",
                    "rgba(233,69,96,1)",
                ],
                borderColor: "#16213e",
                borderWidth: 2,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: "right", labels: { color: "#e0e0e0" } },
            },
        },
    });
}

function renderPrizeTrendChart(labels, prizeRanks, prizeNames) {
    const ctx = document.getElementById("chart-cumulative").getContext("2d");
    if (charts.cumulative) charts.cumulative.destroy();

    // 重映射：未中=0(底), 九等=1, ..., 一等=9(顶)
    const mapped = prizeRanks.map(r => r === 0 ? 0 : 10 - r);

    // 点颜色：未中=灰, 九等=浅绿, 八等=绿, 七等=黄, 六等+=橙红
    const pointColors = prizeRanks.map(r => {
        if (r === 0) return "rgba(136,146,176,0.4)";
        if (r >= 9) return "rgba(0,212,170,0.7)";
        if (r >= 8) return "rgba(0,212,170,0.9)";
        if (r >= 7) return "rgba(255,214,10,0.9)";
        if (r >= 6) return "rgba(255,165,0,1)";
        return "rgba(233,69,96,1)";
    });

    // 简短奖级名
    const shortNames = prizeNames.map(n => {
        if (!n || n === "未中奖") return "";
        return n.replace(/等奖.*/, "等").replace(/等奖$/, "等");
    });

    // 自定义插件：在中奖点旁直接绘制奖级文字
    const prizeLabelPlugin = {
        id: "prizeLabels",
        afterDatasetsDraw(chart) {
            const {ctx, data, scales: {x, y}} = chart;
            const meta = chart.getDatasetMeta(0);
            ctx.save();
            ctx.font = "bold 11px sans-serif";
            ctx.textAlign = "center";
            meta.data.forEach((point, i) => {
                if (prizeRanks[i] > 0) {
                    const label = shortNames[i];
                    ctx.fillStyle = pointColors[i].replace(/[\d.]+\)$/, "1)");
                    ctx.fillText(label, point.x, point.y - 10);
                }
            });
            ctx.restore();
        },
    };

    charts.cumulative = new Chart(ctx, {
        type: "line",
        data: {
            labels: labels,
            datasets: [{
                label: "中奖奖级",
                data: mapped,
                borderColor: "rgba(78,138,255,0.5)",
                backgroundColor: "rgba(78,138,255,0.05)",
                fill: true,
                tension: 0.3,
                pointRadius: prizeRanks.map(r => r > 0 ? 6 : 2),
                pointHoverRadius: 8,
                pointBackgroundColor: pointColors,
                pointBorderColor: pointColors.map(c => c.replace(/[\d.]+\)$/, "1)")),
                borderWidth: 2,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: ctx => `第${ctx[0].label}期`,
                        label: ctx => prizeNames[ctx.dataIndex],
                    },
                },
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 9,
                    title: { display: true, text: "奖级", color: "#8892b0" },
                    ticks: {
                        color: "#8892b0",
                        stepSize: 1,
                        callback: v => {
                            const names = {0:"未中",1:"九等",2:"八等",3:"七等",4:"六等",5:"五等",6:"四等",7:"三等",8:"二等",9:"一等"};
                            return names[v] || v;
                        },
                    },
                    grid: { color: "rgba(255,255,255,0.05)" },
                },
                x: { ticks: { color: "#8892b0", maxRotation: 90, autoSkip: true, maxTicksLimit: 20 }, grid: { display: false } },
            },
        },
        plugins: [prizeLabelPlugin],
    });
}

// ============================================================
// 同步数据
// ============================================================

async function syncData() {
    const btn = document.getElementById("btn-sync");
    btn.disabled = true;
    btn.textContent = "同步中...";
    try {
        const result = await fetchJSON(`/api/sync/${currentGame}`, { method: "POST" });
        const s = result.sync;
        const msg = `同步完成：新增${s.added}期，共${s.total}期。结算${result.settled}条预测。`;
        showToast(msg, "success");
        // 同步刷新仪表盘概览和所有数据
        await loadDashboard();
        await loadAll();
    } catch (e) {
        showToast("同步失败: " + e.message, "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "同步最新数据";
    }
}

// ============================================================
// 机器自学习优化
// ============================================================

async function startOptimize() {
    const btn = document.getElementById("btn-optimize");
    btn.disabled = true;
    btn.textContent = "流水线运行中...";
    setPipelineStage("syncing");

    try {
        await fetchJSON(`/api/optimize/${currentGame}?periods=100`, { method: "POST" });
        showToast("生产流水线已启动：同步 → 自学习 → 预测", "info");

        // 轮询状态
        pollOptimizeStatus();
    } catch (e) {
        showToast("启动流水线失败: " + e.message, "error");
        btn.disabled = false;
        btn.textContent = "同步 · 自学习 · 生成预测";
        setPipelineStage("error");
    }
}

function setPipelineStage(stage) {
    const el = document.getElementById("pipeline-stage");
    if (!el) return;
    const labels = {
        syncing: "正在同步开奖数据",
        optimizing: "正在执行滚动自学习",
        predicting: "正在生成并锁定预测",
        done: "流水线运行完成",
        error: "流水线运行异常",
        idle: "流水线待命",
    };
    el.className = `pipeline-state ${stage === "error" ? "error" : ["syncing", "optimizing", "predicting"].includes(stage) ? "running" : ""}`;
    el.innerHTML = `<i></i><span>${labels[stage] || labels.idle}</span>`;
}

let pollTimer = null;
function pollOptimizeStatus() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
        try {
            const status = await fetchJSON(`/api/optimize/status/${currentGame}`);
            if (status.status === "done" && status.result) {
                clearInterval(pollTimer);
                pollTimer = null;
                const btn = document.getElementById("btn-optimize");
                btn.disabled = false;
                btn.textContent = "同步 · 自学习 · 生成预测";
                renderOptimizeResult(status.result);
                setPipelineStage("done");
                showToast("数据同步、自学习与预测已全部完成", "success");
                await loadDashboard();
                await Promise.all([loadSingleTicket(), loadPredictions(), loadHistory(), loadCharts(), loadDiagnostics(), loadRecentDraws()]);
            } else if (status.status === "error") {
                clearInterval(pollTimer);
                pollTimer = null;
                const btn = document.getElementById("btn-optimize");
                btn.disabled = false;
                btn.textContent = "同步 · 自学习 · 生成预测";
                setPipelineStage("error");
                showToast("流水线失败: " + status.error, "error");
            } else if (status.status === "running") {
                setPipelineStage(status.stage || "optimizing");
                const prog = status.progress || {};
                const pct = prog.total ? Math.round(prog.current / prog.total * 100) : 0;
                const stageCopy = {
                    syncing: "正在同步并校验最新开奖数据",
                    optimizing: `正在滚动验证/优化最近${status.periods}期`,
                    predicting: "正在生成并锁定下一期预测",
                }[status.stage] || "生产流水线运行中";
                document.getElementById("optimize-result").innerHTML =
                    `<div class="loading"><div class="spinner"></div>` +
                    `<p>${stageCopy}${status.stage === "optimizing" ? ` (${prog.current || 0}/${prog.total || 1})` : ""}</p>` +
                    `<div style="width:100%;max-width:300px;height:6px;background:rgba(255,255,255,0.1);border-radius:3px;margin-top:8px;">` +
                    `<div style="width:${pct}%;height:100%;background:var(--green);border-radius:3px;transition:width 0.3s;"></div></div>` +
                    `<p style="margin-top:4px;font-size:12px;color:var(--text-dim)">${prog.config || ""}</p></div>`;
            }
        } catch (e) {
            // 忽略轮询错误
        }
    }, 3000);
}

function renderOptimizeResult(result) {
    const container = document.getElementById("optimize-result");
    const bc = result.best_config;
    const bs = result.best_stats;
    const hitArea = result.game === "dlt" ? "前区" : "红";
    const backArea = result.game === "dlt" ? "后区" : "蓝球";

    let html = `<div class="optimize-result">`;
    html += `<div style="margin-bottom:12px;color:var(--text-dim);font-size:13px;">`;
    html += `运行时间：${result.optimized_at} | ${result.mode === "fixed_strategy_validation" ? "固定策略验证" : `测试${result.total_configs}个配置`} | 近期${result.periods}期`;
    if (result.stability_periods) html += ` | 稳定性闸门${result.stability_periods}期`;
    html += `</div>`;

    html += `<div class="config-grid">`;
    if (result.mode === "adaptive_empirical_search") {
        if (result.game === "dlt") {
            html += `<div class="config-item"><div class="label">生产策略</div><div class="value">v7 实证迁移自学习</div></div>`;
            html += `<div class="config-item"><div class="label">V4训练窗口</div><div class="value">${bc.train_window}期</div></div>`;
            html += `<div class="config-item"><div class="label">候选组合</div><div class="value">${bc.candidate_replicates || bc.candidate_count}组</div></div>`;
            html += `<div class="config-item"><div class="label">双区覆盖</div><div class="value">${bc.portfolio_mode === "coverage" ? "25前区＋10后区" : "联合候选"}</div></div>`;
        } else {
            html += `<div class="config-item"><div class="label">生产策略</div><div class="value">v15 多窗口实证自学习</div></div>`;
            html += `<div class="config-item"><div class="label">五注模式</div><div class="value">${bc.portfolio_mode === "coverage" ? "30红覆盖对照" : "高奖适度重叠"}</div></div>`;
            html += `<div class="config-item"><div class="label">最大两注重叠</div><div class="value">${bc.max_red_overlap}红</div></div>`;
            html += `<div class="config-item"><div class="label">随机候选强度</div><div class="value">${bc.candidate_replicates}档</div></div>`;
            html += `<div class="config-item"><div class="label">重叠版晋升</div><div class="value">${result.overlap_promoted ? "通过" : "未通过 · 保留覆盖"}</div></div>`;
        }
    } else if (result.mode === "fixed_strategy_validation") {
        html += `<div class="config-item"><div class="label">生产策略</div><div class="value">v8 均衡覆盖</div></div>`;
        html += `<div class="config-item"><div class="label">红球覆盖</div><div class="value">${bc.red_coverage}/33</div></div>`;
        html += `<div class="config-item"><div class="label">蓝球覆盖</div><div class="value">${bc.blue_coverage}/16</div></div>`;
    } else {
        html += `<div class="config-item"><div class="label">训练窗口</div><div class="value">${bc.train_window}期</div></div>`;
        html += `<div class="config-item"><div class="label">软混合 Alpha</div><div class="value">${bc.alpha}</div></div>`;
        html += `<div class="config-item"><div class="label">候选规模</div><div class="value">${bc.candidate_count}</div></div>`;
    }
    html += `<div class="config-item"><div class="label">P(≥4${hitArea})</div><div class="value" style="color:var(--yellow)">${(bs.p_ge4 * 100).toFixed(1)}%</div></div>`;
    html += `<div class="config-item"><div class="label">P(≥3${hitArea})</div><div class="value" style="color:var(--green)">${(bs.p_ge3 * 100).toFixed(1)}%</div></div>`;
    html += `<div class="config-item"><div class="label">${backArea}同注对齐率</div><div class="value" style="color:var(--blue)">${((bs.blue_aligned_rate ?? bs.blue_rate) * 100).toFixed(1)}%</div></div>`;
    html += `</div>`;

    if (result.mode === "adaptive_empirical_search") {
        html += `<div style="margin-top:16px;"><strong>滚动验证配置：</strong></div>`;
        html += `<table style="margin-top:8px;"><thead><tr>`;
        html += `<th>配置</th><th>P(≥4${hitArea})</th><th>P(≥3${hitArea})</th><th>${backArea}同注</th><th>联合强度</th>`;
        html += `</tr></thead><tbody>`;
        for (const r of result.all_results.slice(0, 5)) {
            const configLabel = result.game === "dlt"
                ? `${r.config}`
                : `${r.portfolio_mode === "coverage" ? "覆盖" : `重叠≤${r.max_red_overlap}`}/${r.candidate_replicates}`;
            html += `<tr><td>${configLabel}</td>`;
            html += `<td style="color:var(--yellow)">${(r.p_ge4 * 100).toFixed(1)}%</td>`;
            html += `<td style="color:var(--green)">${(r.p_ge3 * 100).toFixed(1)}%</td>`;
            html += `<td>${((r.blue_aligned_rate ?? r.blue_rate) * 100).toFixed(1)}%</td><td>${Number(r.avg_joint_power || 0).toFixed(1)}</td></tr>`;
        }
        html += `</tbody></table>`;
    } else if (result.mode !== "fixed_strategy_validation") {
        html += `<div style="margin-top:16px;"><strong>Top 5 配置：</strong></div>`;
        html += `<table style="margin-top:8px;"><thead><tr>`;
        html += `<th>配置</th><th>P(≥4前区)</th><th>P(≥3前区)</th><th>后区率</th><th>均最高</th>`;
        html += `</tr></thead><tbody>`;
        for (const r of result.all_results.slice(0, 5)) {
            html += `<tr><td>窗口${r.window}/α${r.alpha}/候选${r.candidates}</td>`;
            html += `<td style="color:var(--yellow)">${(r.p_ge4 * 100).toFixed(1)}%</td>`;
            html += `<td style="color:var(--green)">${(r.p_ge3 * 100).toFixed(1)}%</td>`;
            html += `<td>${(r.blue_rate * 100).toFixed(1)}%</td><td>${r.avg_max_red.toFixed(2)}</td></tr>`;
        }
        html += `</tbody></table>`;
    }
    html += `</div>`;

    container.innerHTML = html;
}

async function loadOptimizeStatus() {
    try {
        const status = await fetchJSON(`/api/optimize/status/${currentGame}`);
        if (status.status === "done" && status.result) {
            renderOptimizeResult(status.result);
            setPipelineStage("done");
        } else if (status.status === "running") {
            document.getElementById("optimize-result").innerHTML =
                `<div class="loading"><div class="spinner"></div><p>优化进行中...</p></div>`;
            pollOptimizeStatus();
            setPipelineStage(status.stage || "optimizing");
        }
    } catch (e) {
        // 忽略
    }
}

// ============================================================
// 最近开奖
// ============================================================

async function loadRecentDraws() {
    const container = document.getElementById("recent-draws-body");
    try {
        const data = await fetchJSON(`/api/draws/${currentGame}?limit=50`);
        let html = "";
        for (const d of data) {
            html += `<tr>`;
            html += `<td>${d.issue}</td>`;
            html += `<td>${formatBalls(d.reds, d.blues)}</td>`;
            html += `</tr>`;
        }
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<tr><td colspan="2" style="text-align:center;color:var(--red)">加载失败</td></tr>`;
    }
}

// ============================================================
// 切换彩种
// ============================================================

function switchGame(game) {
    if (game === currentGame) return;
    currentGame = game;

    // 更新标签状态
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.getElementById(`tab-${game}`).classList.add("active");

    // 更新标题
    const name = game === "ssq" ? "双色球" : "大乐透";
    document.getElementById("current-game-name").textContent = name;
    document.getElementById("learning-description").textContent = game === "ssq"
        ? "双色球 V15 用最近50期发现变化、200期拦截短期误切换，只按走期命中决定五注策略；完成后自动锁定下一期预测。"
        : "大乐透 V7 复用双色球的候选覆盖与多窗口晋升流程，只按走期命中决定生产配置；完成后自动锁定下一期预测。";

    // 重新加载数据
    loadAll();
}

// ============================================================
// 加载全部
// ============================================================

async function loadAll() {
    await Promise.all([
        loadSingleTicket(),
        loadPredictions(),
        loadHistory(),
        loadCharts(),
        loadDiagnostics(),
        loadRecentDraws(),
        loadOptimizeStatus(),
    ]);
}

// ============================================================
// 初始化
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
    await loadDashboard();
    await loadAll();

    // 每5分钟自动刷新仪表盘
    setInterval(loadDashboard, 300000);
});
