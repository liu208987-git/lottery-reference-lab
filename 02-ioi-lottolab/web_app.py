"""彩票预测可视化与机器自学习 Web 应用

运行：python web_app.py
访问：http://localhost:5000

功能：
1. 双色球/大乐透 预测展示
2. 命中历史统计列表 + 可视化分析
3. 机器自学习：自动回测优化算法参数
"""

from __future__ import annotations

import contextlib
import importlib
import io
import json
import sqlite3
import subprocess
import sys
import threading
from math import comb
from pathlib import Path
from datetime import datetime

from flask import Flask, jsonify, render_template, request

import ssq_db as ssq_db_mod
import dlt_db as dlt_db_mod
from history_sources import sync_game
from ssq_prediction_audit import (
    settle_available as ssq_settle,
    scoreboard as ssq_scoreboard,
    issue_report as ssq_issue_report,
    evaluate_tickets as ssq_evaluate_tickets,
    AUDIT_DB_PATH as SSQ_AUDIT_PATH,
)
from dlt_prediction_audit import (
    settle_available as dlt_settle,
    scoreboard as dlt_scoreboard,
    issue_report as dlt_issue_report,
    evaluate_tickets as dlt_evaluate_tickets,
    AUDIT_DB_PATH as DLT_AUDIT_PATH,
)
from auto_optimizer import run_optimization, load_optimizer_state, get_progress
from ticket_ranking import rank_tickets, ranking_metadata
from app_paths import DATA_ROOT


ROOT = Path(__file__).resolve().parent
app = Flask(__name__, template_folder=str(ROOT / "templates"), static_folder=str(ROOT / "static"))

# 优化任务状态（线程安全）
_optimize_lock = threading.Lock()
_optimize_status: dict = {}

PRODUCTION_ALGORITHMS = {
    "ssq": "ssq-v15-stability-gated",
    "dlt": "dlt-v7-transfer-coverage",
}
SINGLE_ALGORITHMS = {
    "ssq": "ssq-v15-single-ensemble",
    "dlt": "dlt-v7-single-ensemble",
}

# 版本升级不能切断既有生产统计。历史接口把旧生产算法和当前生产算法
# 拼成一条连续序列；同一期存在多版本时优先采用当前版本，避免重复计数。
PRODUCTION_HISTORY_ALGORITHMS = {
    "ssq": (
        "ssq-v8", "ssq-v13-empirical-adaptive",
        "ssq-v14-jackpot-adaptive", "ssq-v15-stability-gated",
    ),
    "dlt": (
        "dlt-sina-v4", "dlt-v5-empirical-adaptive",
        "dlt-v6-jackpot-adaptive", "dlt-v7-transfer-coverage",
    ),
}


def _run_prediction(game: str) -> str:
    """Run prediction in source mode or inside the packaged desktop process."""
    script = "ssq_predict.py" if game == "ssq" else "dlt_predict.py"
    if not getattr(sys, "frozen", False):
        result = subprocess.run(
            [sys.executable, script, "--no-update"],
            cwd=str(ROOT), capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"预测脚本失败: {(result.stderr or result.stdout)[:500]}")
        from single_ticket_ensemble import generate_live_single
        generate_live_single(game)
        return result.stdout

    # A one-file executable cannot launch its embedded .py files as scripts.
    # Reloading also refreshes the DLT runtime parameters after self-learning.
    module_name = "ssq_predict" if game == "ssq" else "dlt_predict"
    module = importlib.import_module(module_name)
    module = importlib.reload(module)
    output = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        module.main(["--no-update"])
    from single_ticket_ensemble import generate_live_single
    generate_live_single(game)
    return output.getvalue()


# ============================================================
# 数据库查询辅助
# ============================================================

def _get_audit_db_path(game: str) -> Path:
    return SSQ_AUDIT_PATH if game == "ssq" else DLT_AUDIT_PATH


def _get_db_module(game: str):
    return ssq_db_mod if game == "ssq" else dlt_db_mod


def _recompute_metrics(game: str, item: dict) -> dict:
    """Use the source rule table and enrich old ledgers with exact back-zone hits.

    Some packaged builds wrote mojibake prize names and older rows predate the
    explicit max/total back-zone counters.  Recomputing from locked tickets and
    the stored actual draw keeps the original prediction intact while making
    every API row use one unambiguous settlement vocabulary.
    """
    actual = item.get("actual")
    tickets = item.get("tickets") or []
    if not actual or not tickets:
        return item.get("metrics") or {}
    if game == "ssq":
        return ssq_evaluate_tickets(
            tickets, actual.get("reds") or [], actual.get("blue")
        )
    return dlt_evaluate_tickets(
        tickets,
        actual.get("reds") or [],
        actual.get("blues") or [],
        issue=str(item.get("issue") or ""),
    )


def _hydrate_prediction_row(game: str, row) -> dict:
    item = dict(row)
    item.pop("history_rank", None)
    item["tickets"] = json.loads(item.pop("tickets_json"))
    item["model"] = json.loads(item.pop("model_json"))
    actual_raw = item.pop("actual_json")
    metrics_raw = item.pop("metrics_json")
    item["actual"] = json.loads(actual_raw) if actual_raw else None
    item["metrics"] = json.loads(metrics_raw) if metrics_raw else None
    if item["actual"] is not None:
        item["metrics"] = _recompute_metrics(game, item)
    return item


def _get_all_settled(game: str, limit: int = 200) -> list[dict]:
    """获取跨生产版本连续、按期号去重的已结算预测记录。"""
    path = _get_audit_db_path(game)
    if not path.exists():
        return []
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    algorithms = PRODUCTION_HISTORY_ALGORITHMS[game]
    placeholders = ",".join("?" for _ in algorithms)
    rows = conn.execute(
        f"""
        WITH ranked_production AS (
            SELECT predictions.*,
                   ROW_NUMBER() OVER (
                       PARTITION BY issue
                       ORDER BY CASE WHEN algorithm=? THEN 0 ELSE 1 END,
                                generated_at DESC
                   ) AS history_rank
            FROM predictions
            WHERE settled_at IS NOT NULL
              AND algorithm IN ({placeholders})
        )
        SELECT * FROM ranked_production
        WHERE history_rank=1
        ORDER BY issue DESC
        LIMIT ?
        """,
        (PRODUCTION_ALGORITHMS[game], *algorithms, limit),
    ).fetchall()
    conn.close()
    return [_hydrate_prediction_row(game, row) for row in rows]


def _get_current_algorithm_settled(
    game: str,
    limit: int = 5000,
) -> list[dict]:
    """读取页面顶部统计所用的当前算法严格走期台账。"""
    path = _get_audit_db_path(game)
    if not path.exists():
        return []
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    rows = connection.execute(
        """
        SELECT * FROM predictions
        WHERE settled_at IS NOT NULL AND algorithm=?
        ORDER BY issue DESC
        LIMIT ?
        """,
        (PRODUCTION_ALGORITHMS[game], limit),
    ).fetchall()
    connection.close()
    return [_hydrate_prediction_row(game, row) for row in rows]


def _get_latest_prediction(game: str) -> dict | None:
    """获取最新的未结算预测。"""
    path = _get_audit_db_path(game)
    if not path.exists():
        return None
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT * FROM predictions WHERE algorithm=? "
        "ORDER BY issue DESC, generated_at DESC LIMIT 1",
        (PRODUCTION_ALGORITHMS[game],),
    ).fetchone()
    conn.close()
    if not row:
        return None
    return _hydrate_prediction_row(game, row)


def _get_latest_single_prediction(game: str) -> dict | None:
    path = _get_audit_db_path(game)
    if not path.exists():
        return None
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    row = connection.execute(
        "SELECT * FROM predictions WHERE algorithm=? "
        "ORDER BY issue DESC, generated_at DESC LIMIT 1",
        (SINGLE_ALGORITHMS[game],),
    ).fetchone()
    connection.close()
    if row is None:
        return None
    return _hydrate_prediction_row(game, row)


def _load_single_report(game: str) -> dict | None:
    filename = f"single_ticket_backtest_{game}.json"
    for path in (
        DATA_ROOT / "reports" / filename,
        ROOT / "reports" / filename,
    ):
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    return None


# 算法版本显示映射
ALGORITHM_VERSION_MAP = {
    "ssq-v8": {"label": "v8", "desc": "零重叠均衡覆盖"},
    "ssq-v13-empirical-adaptive": {
        "label": "v13", "desc": "V8覆盖 · 实证排除自学习"
    },
    "ssq-v14-jackpot-adaptive": {
        "label": "v14", "desc": "高奖重叠 · 同注联合自学习"
    },
    "ssq-v15-stability-gated": {
        "label": "v15", "desc": "多窗口闸门 · 实证命中自学习"
    },
    "ssq-v5": {"label": "v5", "desc": "红蓝分别优化"},
    "dlt-sina-v4": {"label": "v4", "desc": "指标增强"},
    "dlt-v5-empirical-adaptive": {
        "label": "v5", "desc": "V4指标 · 实证自学习"
    },
    "dlt-v6-jackpot-adaptive": {
        "label": "v6", "desc": "同注联合 · 高奖晋升闸门"
    },
    "dlt-v7-transfer-coverage": {
        "label": "v7", "desc": "双色球迁移 · 严格走期自学习"
    },
    "ssq-v6": {"label": "v6", "desc": "集成策略"},
    "dlt-v6": {"label": "v6", "desc": "集成策略"},
}

# 默认算法版本（无预测数据时显示）
DEFAULT_VERSION = {
    "ssq": {"label": "v15", "desc": "多窗口闸门 · 实证命中自学习"},
    "dlt": {"label": "v7", "desc": "双色球迁移 · 严格走期自学习"},
}


def _get_algorithm_version(game: str) -> dict:
    """获取当前算法版本标签（基于最新预测记录，无数据时回退默认）。"""
    path = _get_audit_db_path(game)
    if path.exists():
        conn = sqlite3.connect(path)
        row = conn.execute(
            "SELECT algorithm FROM predictions WHERE algorithm=? "
            "ORDER BY issue DESC, generated_at DESC LIMIT 1",
            (PRODUCTION_ALGORITHMS[game],),
        ).fetchone()
        conn.close()
        if row and row[0]:
            algo = row[0]
            info = ALGORITHM_VERSION_MAP.get(algo, {"label": algo, "desc": ""})
            return {"name": algo, **info}
    return {"name": "", **DEFAULT_VERSION[game]}


def _get_recent_draws(game: str, limit: int = 50) -> list[dict]:
    """获取最近N期开奖记录。"""
    db = _get_db_module(game)
    rows = db.get_all_draws("DESC")[:limit]
    return rows


def _format_draw(row: dict, game: str) -> dict:
    """格式化开奖记录。"""
    red_pick = 6 if game == "ssq" else 5
    blue_pick = 1 if game == "ssq" else 2
    reds = [row[f"r{i}"] for i in range(1, red_pick + 1)]
    blues = [row[f"b{i}"] for i in range(1, blue_pick + 1)]
    return {
        "issue": row["issue"],
        "reds": reds,
        "blues": blues,
    }


def _compute_ticket_analysis(
    tickets, draws, game, *, frozen_priority_indices=None,
):
    """计算理论值，并保持预测生成时已经锁定的购买顺序。"""
    if game == "ssq":
        red_pool, red_pick, blue_pool, blue_pick = 33, 6, 16, 1
    else:
        red_pool, red_pick, blue_pool, blue_pick = 35, 5, 12, 2

    if (
        frozen_priority_indices
        and len(frozen_priority_indices) == len(tickets)
    ):
        # Prediction writers store tickets in priority order.  Never rank them
        # again after a draw is published, otherwise the historical display
        # silently uses future data and can change the user's original order.
        ranking = [
            {
                "index": index,
                "rank": index + 1,
                "priority_index": float(frozen_priority_indices[index]),
                "raw_score": 0.0,
                "structure_score": 0.0,
                "frequency_score": 0.0,
            }
            for index in range(len(tickets))
        ]
    else:
        ranking = rank_tickets(tickets, draws, game)
    rank_by_index = {item["index"]: item for item in ranking}

    # 理论概率（单注）
    results = []
    for i, (reds, blues) in enumerate(tickets):
        priority = rank_by_index[i]
        if game == "ssq":
            C33_6 = comb(33, 6)
            p_red = [comb(6, k) * comb(27, 6 - k) / C33_6 for k in range(7)]
            p_b = 1 / 16
            # 各奖级概率
            p_prizes = {
                "一等奖(6+1)": p_red[6] * p_b,
                "二等奖(6+0)": p_red[6] * (1 - p_b),
                "三等奖(5+1)": p_red[5] * p_b,
                "四等奖(5+0/4+1)": p_red[5] * (1 - p_b) + p_red[4] * p_b,
                "五等奖(4+0/3+1)": p_red[4] * (1 - p_b) + p_red[3] * p_b,
                "六等奖(2+1/1+1/0+1)": (p_red[2] + p_red[1] + p_red[0]) * p_b,
            }
            p_ge4 = p_red[4] + p_red[5] + p_red[6]
            p_ge3 = p_red[3] + p_red[4] + p_red[5] + p_red[6]
            p_blue = p_b
            p_jackpot = p_red[6] * p_b
        else:  # dlt
            C35_5 = comb(35, 5)
            p_red = [comb(5, k) * comb(30, 5 - k) / C35_5 for k in range(6)]
            C12_2 = comb(12, 2)
            p_b = [comb(2, k) * comb(10, 2 - k) / C12_2 for k in range(3)]
            p_prizes = {
                "一等奖(5+2)": p_red[5] * p_b[2],
                "二等奖(5+1)": p_red[5] * p_b[1],
                "三等奖(5+0/4+2)": (
                    p_red[5] * p_b[0] + p_red[4] * p_b[2]),
                "四等奖(4+1)": p_red[4] * p_b[1],
                "五等奖(4+0/3+2)": (
                    p_red[4] * p_b[0] + p_red[3] * p_b[2]),
                "六等奖(3+1/2+2)": (
                    p_red[3] * p_b[1] + p_red[2] * p_b[2]),
                "七等奖(3+0/2+1/1+2/0+2)": (
                    p_red[3] * p_b[0] + p_red[2] * p_b[1] +
                    p_red[1] * p_b[2] + p_red[0] * p_b[2]),
            }
            p_ge4 = p_red[4] + p_red[5]
            p_ge3 = p_red[3] + p_red[4] + p_red[5]
            p_blue = p_b[1] + p_b[2]
            p_jackpot = p_red[5] * p_b[2]

        # 找出最可能的中奖等级（概率最高的奖级）
        most_likely = max(p_prizes, key=p_prizes.get)

        results.append({
            "index": i,
            "rank": priority["rank"],
            "reds": reds,
            "blues": blues,
            "score": priority["raw_score"],
            "structure_score": priority["structure_score"],
            "frequency_score": priority["frequency_score"],
            "priority_index": priority["priority_index"],
            "confidence": priority["priority_index"],
            "weight": 1.0,
            "theoretical_equal_probability": True,
            "p_jackpot": p_jackpot,
            "p_ge4_red": p_ge4,
            "p_ge3_red": p_ge3,
            "p_blue": p_blue,
            "most_likely_prize": most_likely,
            "most_likely_p": p_prizes[most_likely],
            "p_prizes": p_prizes,
        })

    results.sort(key=lambda item: item["rank"])
    return results


# ============================================================
# 路由：页面
# ============================================================

@app.route("/")
def index():
    return render_template("index.html")


# ============================================================
# API：仪表盘
# ============================================================

@app.route("/api/dashboard")
def api_dashboard():
    """获取仪表盘概览数据（基于全量SQL聚合统计）。"""
    data = {}
    for game in ("ssq", "dlt"):
        db = _get_db_module(game)
        total = db.get_count()
        lo, hi = db.get_issue_range()
        latest_pred = _get_latest_prediction(game)

        # 页面顶部只统计当前算法的严格走期回填，避免把旧版本样本掺入
        # v15/v7 的命中率。升级后的历史明细仍保留跨版本连续查询。
        ge4_count = 0
        ge3_count = 0
        blue_hits = 0
        prize_count = 0
        settled_count = 0
        settled_range = [None, None]
        prize_breakdown: dict[str, int] = {}
        settled_records = _get_current_algorithm_settled(
            game, limit=max(total + 100, 5000)
        )
        statistics_scope = "current_algorithm_walk_forward"
        if not settled_records:
            # 首次升级、尚未完成回填时保持页面可用，并明确标记回退口径。
            settled_records = _get_all_settled(
                game, limit=max(total + 100, 5000)
            )
            statistics_scope = "legacy_lineage_fallback"
        settled_count = len(settled_records)
        if settled_records:
            issues = [str(item["issue"]) for item in settled_records]
            settled_range = [min(issues), max(issues)]
        for item in settled_records:
            metrics = item.get("metrics") or {}
            max_red = int(metrics.get("max_red_hits") or 0)
            ge4_count += int(max_red >= 4)
            ge3_count += int(max_red >= 3)
            blue_hits += int(bool(metrics.get("blue_covered")))
            prize_count += int(int(metrics.get("winning_tickets") or 0) > 0)
            prize_name = metrics.get("best_prize_name")
            if prize_name:
                prize_breakdown[prize_name] = prize_breakdown.get(prize_name, 0) + 1

        data[game] = {
            "total_draws": total,
            "range": [lo, hi],
            "latest_prediction": latest_pred,
            "settled_count": settled_count,
            "settled_range": settled_range,
            "backtest_note": (
                (
                    "v15逐期重训实测 · 前100期仅训练"
                    if game == "ssq"
                    else "v7逐期重训实测 · 前100期仅训练"
                )
                if statistics_scope == "current_algorithm_walk_forward"
                else "新版本回填未完成 · 暂显历史连续口径"
            ),
            "statistics_algorithm": PRODUCTION_ALGORITHMS[game],
            "statistics_scope": statistics_scope,
            "ge4_count": ge4_count,
            "ge3_count": ge3_count,
            "blue_hit_count": blue_hits,
            "prize_count": prize_count,
            "prize_breakdown": prize_breakdown,
            "algorithm_version": _get_algorithm_version(game),
        }
    return jsonify(data)


# ============================================================
# API：预测
# ============================================================

@app.route("/api/predictions/<game>")
def api_predictions(game: str):
    """获取最新预测，包含每注中奖概率分析。"""
    if game not in ("ssq", "dlt"):
        return jsonify({"error": "未知彩种"}), 400
    pred = _get_latest_prediction(game)
    if not pred:
        return jsonify({"error": "暂无预测记录"}), 404

    # 添加回测概率
    from auto_optimizer import load_optimizer_state
    opt = load_optimizer_state(game)
    if opt and opt.get("best_stats"):
        stats = opt["best_stats"]
        if game == "ssq":
            pred["probability"] = {
                "p_ge4_red": stats.get("p_ge4", 0),
                "p_ge3_red": stats.get("p_ge3", 0),
                "blue_rate": stats.get("blue_rate", 0),
                "validation_periods": opt.get("periods", 100),
            }
        else:
            pred["probability"] = {
                "p_ge4_red": stats.get("p_ge4", 0),
                "p_ge3_red": stats.get("p_ge3", 0),
                "blue_rate": stats.get("blue_rate", 0),
                "validation_periods": opt.get("periods", 100),
            }

    # 计算每注的概率分析
    db_mod = _get_db_module(game)
    draws = db_mod.get_all_draws("ASC")
    trained_through = str(pred.get("trained_through") or "")
    if trained_through:
        # Old ledgers without stored ranking metadata are reconstructed using
        # exactly the information available when the prediction was made.
        draws = [row for row in draws if str(row["issue"]) <= trained_through]
    tickets = [(list(r), list(b)) for r, b in pred["tickets"]]
    ranking_config = (pred.get("model") or {}).get("ranking") or {}
    frozen_indices = ranking_config.get("priority_indices")
    if not (
        isinstance(frozen_indices, list)
        and len(frozen_indices) == len(tickets)
    ):
        frozen_indices = None
    try:
        pred["ticket_analysis"] = _compute_ticket_analysis(
            tickets,
            draws,
            game,
            frozen_priority_indices=frozen_indices,
        )
    except Exception as e:
        pred["ticket_analysis"] = []
    pred["ranking_frozen"] = frozen_indices is not None
    pred["ranking_history_through"] = trained_through or None
    pred["ranking_validation"] = ranking_metadata(game)

    return jsonify(pred)


@app.route("/api/single-ticket/<game>")
def api_single_ticket(game: str):
    """Return the locked compressed ticket plus its one-bet comparison."""
    if game not in ("ssq", "dlt"):
        return jsonify({"error": "未知彩种"}), 400
    report = _load_single_report(game)
    single = _get_latest_single_prediction(game)
    production = _get_latest_prediction(game)
    if not report or not single or not production:
        return jsonify({"error": "暂无单注聚合结果"}), 404

    compressed_reds, compressed_blues = single["tickets"][0]
    source_reds, source_blues = production["tickets"][0]
    all_comparison = report["comparison"]["all_history_current_rules"]
    holdout_comparison = report["comparison"]["last_30_percent_current_rules"]
    aggregate_supported = (
        all_comparison["absolute_change"] > 0
        and holdout_comparison["absolute_change"] > 0
    )
    if aggregate_supported:
        strategy = "aggregate"
        strategy_label = "采用聚合单注"
        recommendation_reason = "全历史与后30%同成本回测均高于原首选单注"
        recommended_reds, recommended_blues = compressed_reds, compressed_blues
    else:
        strategy = "baseline_first_ticket"
        strategy_label = "保留原算法首选"
        recommendation_reason = "聚合单注未在全历史与后30%同时提高"
        recommended_reds, recommended_blues = source_reds, source_blues

    return jsonify({
        "game": game,
        "issue": production["issue"],
        "trained_through": production["trained_through"],
        "strategy": strategy,
        "strategy_label": strategy_label,
        "recommendation_reason": recommendation_reason,
        "recommended_ticket": {
            "reds": recommended_reds,
            "blues": recommended_blues,
        },
        "compressed_ticket": {
            "reds": compressed_reds,
            "blues": compressed_blues,
            "algorithm": single["algorithm"],
            "generated_at": single["generated_at"],
        },
        "source_first_ticket": {
            "reds": source_reds,
            "blues": source_blues,
            "algorithm": production["algorithm"],
        },
        "backtest": {
            "draws": report["draws"],
            "history_range": report["history_range"],
            "aggregate": report["aggregate"],
            "baseline": report["baseline_first_ticket"],
            "best_of_five": report["best_of_five_context"],
            "comparison": report["comparison"],
            "coverage": report["coverage"],
        },
    })


# ============================================================
# API：命中历史
# ============================================================

@app.route("/api/history/<game>")
def api_history(game: str):
    """获取命中历史列表。"""
    if game not in ("ssq", "dlt"):
        return jsonify({"error": "未知彩种"}), 400
    limit = request.args.get("limit", 200, type=int)
    settled = _get_all_settled(game, limit=limit)
    return jsonify(settled)


def _recent_failure_diagnostics(game: str, records: list[dict]) -> dict:
    """Explain misses from locked five-ticket settlements, not fitted draws."""
    focus_hits = 4 if game == "ssq" else 3
    primary_reasons: dict[str, int] = {}
    max_red_distribution: dict[str, int] = {}
    win_periods = 0
    blue_covered_periods = 0
    blue_aligned_periods = 0
    fragmented_periods = 0
    union_total = 0
    max_total = 0

    def add_reason(label: str) -> None:
        primary_reasons[label] = primary_reasons.get(label, 0) + 1

    for item in records:
        metrics = item.get("metrics") or {}
        details = metrics.get("details") or []
        if not details:
            continue
        max_red = max(int(detail.get("red_hits") or 0) for detail in details)
        union_red = int(metrics.get("union_red_hits") or 0)
        max_blue = max(int(detail.get("blue_hits") or 0) for detail in details)
        best_red_blue = max(
            int(detail.get("blue_hits") or 0)
            for detail in details
            if int(detail.get("red_hits") or 0) == max_red
        )
        winning = int(metrics.get("winning_tickets") or 0) > 0
        max_total += max_red
        union_total += union_red
        max_red_distribution[str(max_red)] = (
            max_red_distribution.get(str(max_red), 0) + 1
        )
        win_periods += int(winning)
        blue_covered_periods += int(max_blue > 0)
        blue_aligned_periods += int(best_red_blue > 0)
        fragmented_periods += int(
            union_red >= focus_hits and max_red < focus_hits
        )
        if winning:
            continue

        # Mutually exclusive primary cause for a compact 30-period ledger.
        if game == "ssq":
            if max_red >= 3 and best_red_blue == 0:
                add_reason("前区已有3个以上，但蓝球未落在同一注")
            elif max_blue == 0 and max_red < 3:
                add_reason("前区集中度不足，同时蓝球漏失")
            elif max_blue > 0 and best_red_blue == 0:
                add_reason("蓝球命中，但落在低红球注")
            else:
                add_reason("同注红蓝组合未达到奖级")
        else:
            if max_blue > 0 and best_red_blue == 0:
                add_reason("后区命中，但落在低前区注")
            elif max_blue == 0 and max_red < 3:
                add_reason("前区不足3个，同时后区漏失")
            else:
                add_reason("同注前后区组合未达到奖级")

    periods = len(records)
    miss_periods = periods - win_periods
    ordered_reasons = [
        {"reason": reason, "periods": count,
         "share_of_misses": count / miss_periods if miss_periods else 0.0}
        for reason, count in sorted(
            primary_reasons.items(), key=lambda pair: (-pair[1], pair[0])
        )
    ]
    if game == "ssq":
        finding = (
            "五注红球大覆盖把实际命中拆散：号码池经常覆盖到开奖红球，"
            "但单注没有形成4红以上；蓝球漏失随后直接造成空奖。"
        )
        action = (
            "高奖模式改为允许红球适度重叠（任意两注最多3个），"
            "自学习只按同注高阶命中晋升，不再奖励单纯蓝球覆盖。"
        )
    else:
        finding = (
            "后区覆盖已经很高，但命中的后区常与最高前区不在同一注；"
            "继续追求10个后区全覆盖只会抬高漂亮指标，不会抬高有效奖级。"
        )
        action = (
            "优化目标改成同注前后区联合得分，并设置基线晋升闸门；"
            "后区从纯覆盖改为兼顾与高前区票的对齐。"
        )
    return {
        "game": game,
        "periods": periods,
        "issue_from": records[-1]["issue"] if records else None,
        "issue_to": records[0]["issue"] if records else None,
        "win_periods": win_periods,
        "miss_periods": miss_periods,
        "win_rate": win_periods / periods if periods else 0.0,
        "average_union_red_hits": union_total / periods if periods else 0.0,
        "average_max_red_hits": max_total / periods if periods else 0.0,
        "max_red_distribution": max_red_distribution,
        "blue_covered_periods": blue_covered_periods,
        "blue_aligned_periods": blue_aligned_periods,
        "fragmented_periods": fragmented_periods,
        "focus_hits": focus_hits,
        "primary_reasons": ordered_reasons,
        "finding": finding,
        "algorithm_action": action,
    }


@app.route("/api/diagnostics/<game>")
def api_diagnostics(game: str):
    """Return a concrete audit of the latest 30 locked production forecasts."""
    if game not in ("ssq", "dlt"):
        return jsonify({"error": "未知彩种"}), 400
    limit = max(1, min(request.args.get("limit", 30, type=int), 100))
    return jsonify(_recent_failure_diagnostics(
        game, _get_all_settled(game, limit=limit)
    ))


# ============================================================
# API：排行榜
# ============================================================

@app.route("/api/scoreboard/<game>")
def api_scoreboard(game: str):
    """获取算法排行榜。"""
    if game not in ("ssq", "dlt"):
        return jsonify({"error": "未知彩种"}), 400
    if game == "ssq":
        board = ssq_scoreboard()
    else:
        board = dlt_scoreboard()
    return jsonify(board)


# ============================================================
# API：最近开奖
# ============================================================

@app.route("/api/draws/<game>")
def api_draws(game: str):
    """获取最近开奖记录。"""
    if game not in ("ssq", "dlt"):
        return jsonify({"error": "未知彩种"}), 400
    limit = request.args.get("limit", 50, type=int)
    rows = _get_recent_draws(game, limit)
    return jsonify([_format_draw(r, game) for r in rows])


# ============================================================
# API：同步数据
# ============================================================

@app.route("/api/sync/<game>", methods=["POST"])
def api_sync(game: str):
    """同步最新开奖数据并结算预测。"""
    if game not in ("ssq", "dlt"):
        return jsonify({"error": "未知彩种"}), 400
    try:
        db = _get_db_module(game)
        db.init_db()
        result = sync_game(game, db)
        # 结算已开奖的预测
        rows = db.get_all_draws("ASC")
        if game == "ssq":
            settled = ssq_settle(rows)
        else:
            settled = dlt_settle(rows)
        return jsonify({
            "sync": result,
            "settled": settled,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ============================================================
# API：机器自学习优化
# ============================================================

@app.route("/api/optimize/<game>", methods=["POST"])
def api_optimize(game: str):
    """异步执行：同步数据 → 结算 → 自学习 → 生成下一期预测。"""
    if game not in ("ssq", "dlt"):
        return jsonify({"error": "未知彩种"}), 400

    with _optimize_lock:
        key = f"{game}"
        if key in _optimize_status and _optimize_status[key].get("status") == "running":
            return jsonify({"error": "优化正在进行中，请稍候"}), 409

        periods = request.args.get("periods", 100, type=int)
        _optimize_status[key] = {
            "status": "running",
            "stage": "syncing",
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "game": game,
            "periods": periods,
        }

    def _run():
        try:
            db = _get_db_module(game)
            db.init_db()
            sync_result = sync_game(game, db)
            rows = db.get_all_draws("ASC")
            settled = ssq_settle(rows) if game == "ssq" else dlt_settle(rows)
            _optimize_status[key] = {
                **_optimize_status[key],
                "stage": "optimizing",
                "sync": sync_result,
                "settled": settled,
            }
            result = run_optimization(game, periods)
            _optimize_status[key] = {
                **_optimize_status[key],
                "stage": "predicting",
                "result": result,
            }
            prediction_output = _run_prediction(game)
            _optimize_status[key] = {
                "status": "done",
                "stage": "done",
                "started_at": _optimize_status[key]["started_at"],
                "finished_at": datetime.now().isoformat(timespec="seconds"),
                "game": game,
                "result": result,
                "sync": sync_result,
                "settled": settled,
                "prediction_output": prediction_output[-2000:],
            }
        except Exception as e:
            _optimize_status[key] = {
                "status": "error",
                "stage": "error",
                "started_at": _optimize_status[key]["started_at"],
                "finished_at": datetime.now().isoformat(timespec="seconds"),
                "game": game,
                "error": str(e),
            }

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return jsonify({"message": "同步、自学习与预测流水线已启动", "status": _optimize_status[key]})


@app.route("/api/optimize/status/<game>")
def api_optimize_status(game: str):
    """获取优化状态。"""
    if game not in ("ssq", "dlt"):
        return jsonify({"error": "未知彩种"}), 400
    key = game
    if key in _optimize_status and _optimize_status[key].get("status") == "running":
        prog = get_progress(game)
        return jsonify({**_optimize_status[key], "progress": prog})
    if key in _optimize_status:
        return jsonify(_optimize_status[key])
    # 检查是否有历史优化结果
    saved = load_optimizer_state(game)
    if saved:
        return jsonify({"status": "done", "result": saved})
    return jsonify({"status": "never"})


@app.route("/api/regenerate/<game>", methods=["POST"])
def api_regenerate(game: str):
    """用最新自学习参数重新生成预测。"""
    if game not in ("ssq", "dlt"):
        return jsonify({"error": "未知彩种"}), 400
    try:
        _run_prediction(game)
        return jsonify({"message": "预测已用最新参数重新生成"})
    except subprocess.TimeoutExpired:
        return jsonify({"error": "预测超时"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ============================================================
# 主入口
# ============================================================

if __name__ == "__main__":
    print("=" * 60)
    print("彩票预测可视化与机器自学习平台")
    print("访问地址: http://localhost:5000")
    print("=" * 60)
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
