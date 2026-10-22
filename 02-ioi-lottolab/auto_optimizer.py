"""机器自学习模块：生产算法滚动验证与参数优化。

双色球 v8 是固定的组合几何算法，自学习阶段负责滚动验证并记录表现；
大乐透 v4 继续搜索训练窗口、软混合权重和候选数。
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from datetime import datetime
from itertools import product

import ssq_db as ssq_db_mod
import dlt_db as dlt_db_mod
from app_paths import DATA_ROOT
from fused_predictor import (
    build_enhanced_portfolio,
)
from v8_predictor import build_v8_balanced, v8_rng
from production_seeds import dlt_v4_rng
from ssq_adaptive_predictor import (
    ALGORITHM_NAME as SSQ_ADAPTIVE_ALGORITHM,
    DEFAULT_CONFIG as SSQ_ADAPTIVE_DEFAULTS,
    EmpiricalProfile,
    evaluate_config as evaluate_ssq_adaptive_config,
    normalize_config as normalize_ssq_adaptive_config,
)
from dlt_adaptive_predictor import (
    ALGORITHM_NAME as DLT_ADAPTIVE_ALGORITHM,
    DEFAULT_CONFIG as DLT_ADAPTIVE_DEFAULTS,
    EmpiricalProfile as DltEmpiricalProfile,
    evaluate_config as evaluate_dlt_adaptive_config,
    normalize_config as normalize_dlt_adaptive_config,
)


OPTIMIZER_STATE_PATH = DATA_ROOT / "optimizer_state.json"

# 进度跟踪（供web_app读取）
_progress: dict = {}

# 双色球参数
SSQ_RED_POOL = 33
SSQ_RED_PICK = 6
SSQ_BLUE_POOL = 16
SSQ_BLUE_PICK = 1

# 大乐透参数
DLT_RED_POOL = 35
DLT_RED_PICK = 5
DLT_BLUE_POOL = 12
DLT_BLUE_PICK = 2


def _backtest_config(
    draws: list[dict],
    red_pool: int,
    red_pick: int,
    blue_pool: int,
    blue_pick: int,
    alpha: float,
    train_window: int | None,
    periods: int,
    candidate_count: int = 1000,
    game: str = "ssq",
) -> dict:
    """对单个配置进行前向回测，返回统计指标。

    按生产版本执行：SSQ 用 v8 零重叠均衡组合，DLT 用 v4 指标增强。
    """
    n = len(draws)
    start = max(100, n - periods)
    results = []

    for i in range(start, n):
        if train_window is not None:
            train = draws[max(0, i - train_window):i]
        else:
            train = draws[:i]

        min_train = min(80, train_window or 200)
        if len(train) < max(min_train, 50):
            continue

        actual = draws[i]
        actual_reds = set(actual[f"r{j}"] for j in range(1, red_pick + 1))
        actual_blues = set(actual[f"b{j}"] for j in range(1, blue_pick + 1))

        if game == "ssq":
            rng = v8_rng("ssq", actual["issue"])
            tickets = build_v8_balanced(
                rng, [], red_pool, red_pick, blue_pool, blue_pick, 5)
        else:
            # v4新浪走势指标增强
            rng = dlt_v4_rng(draws[i - 1]["issue"], i)
            tickets = build_enhanced_portfolio(
                rng, train, red_pool, red_pick, blue_pool, blue_pick, 5,
                red_scores=None, blue_scores=None,
                alpha=alpha,
                candidate_count=candidate_count,
            )

        ticket_red_hits = []
        ticket_blue_hits = []
        blue_hit_any = False
        for reds, blues in tickets:
            red_hit = len(set(reds) & actual_reds)
            blue_hit_count = len(set(blues) & actual_blues)
            ticket_red_hits.append(red_hit)
            ticket_blue_hits.append(blue_hit_count)
            if blue_hit_count > 0:
                blue_hit_any = True

        max_red = max(ticket_red_hits)
        # 找到最高红球命中时对应的蓝球命中数
        best_idx = ticket_red_hits.index(max_red)
        best_blue = ticket_blue_hits[best_idx]
        results.append({
            "issue": actual["issue"],
            "max_red": max_red,
            "best_blue": best_blue,
            "blue_hit": blue_hit_any,
            "ticket_red_hits": ticket_red_hits,
            "ticket_blue_hits": ticket_blue_hits,
        })

    total = len(results)
    if total == 0:
        return {"total": 0, "p_ge4": 0, "p_ge3": 0, "p_5red": 0,
                "p_4r2b": 0, "p_big_prize": 0, "blue_rate": 0, "avg_max_red": 0}

    ge4 = sum(1 for r in results if r["max_red"] >= 4)
    ge3 = sum(1 for r in results if r["max_red"] >= 3)
    # 5红全中（双色球三等奖以上，大乐透三等奖以上）
    p5 = sum(1 for r in results if r["max_red"] >= red_pick)
    # 4红+全部蓝球命中（双色球4+1四等奖，大乐透4+2四等奖）
    p4_full_blue = sum(1 for r in results
                       if r["max_red"] >= red_pick - 1
                       and r.get("best_blue", 0) >= blue_pick)
    # 大奖：5红 或 4红+全蓝（三等奖+四等奖以上）
    big_prize = sum(1 for r in results
                    if r["max_red"] >= red_pick
                    or (r["max_red"] >= red_pick - 1
                        and r.get("best_blue", 0) >= blue_pick))
    blue_hits = sum(1 for r in results if r["blue_hit"])
    avg_max_red = sum(r["max_red"] for r in results) / total

    all_ticket_reds = [h for r in results for h in r["ticket_red_hits"]]
    red_dist = Counter(all_ticket_reds)

    return {
        "total": total,
        "p_ge4": ge4 / total,
        "p_ge3": ge3 / total,
        "p_5red": p5 / total,
        "p_4r_full_blue": p4_full_blue / total,
        "p_big_prize": big_prize / total,
        "blue_rate": blue_hits / total,
        "avg_max_red": avg_max_red,
        "ge4_count": ge4,
        "ge3_count": ge3,
        "p5_count": p5,
        "big_prize_count": big_prize,
        "red_dist": dict(red_dist),
        "results": results,
    }


def optimize_ssq(periods: int = 100) -> dict:
    """严格滚动搜索双色球覆盖版与重叠版，并执行长期稳定性闸门。

    每一个目标期只使用此前开奖构造经验阈值和候选组合。候选同时包含旧版
    30红球零重叠基线与最多重叠3红的高奖集中结构，晋升分只奖励同注高阶
    命中，不再把单纯蓝球覆盖当成改进。最近窗口选出的重叠版必须在最长
    200期窗口不劣于覆盖版，否则生产配置保留零重叠覆盖。
    """
    draws = ssq_db_mod.get_all_draws("ASC")
    if len(draws) < 300:
        raise ValueError(f"双色球历史数据不足：{len(draws)}期")

    validation_periods = max(20, min(int(periods), 50))
    candidates = [
        {"portfolio_mode": "coverage", "max_red_overlap": 0,
         "coverage_bonus": 0.0, "candidate_replicates": 12,
         "soft_penalty_weight": 0.50, "rare_rate": 0.005, "tail_rate": 0.005},
        {"portfolio_mode": "jackpot_overlap", "max_red_overlap": 2,
         "coverage_bonus": 0.05, "candidate_replicates": 24,
         "soft_penalty_weight": 0.50, "rare_rate": 0.005, "tail_rate": 0.005},
        {"portfolio_mode": "jackpot_overlap", "max_red_overlap": 3,
         "coverage_bonus": 0.04, "candidate_replicates": 36,
         "soft_penalty_weight": 0.75, "rare_rate": 0.010, "tail_rate": 0.010},
        {"portfolio_mode": "jackpot_overlap", "max_red_overlap": 3,
         "coverage_bonus": 0.12, "candidate_replicates": 36,
         "soft_penalty_weight": 0.50, "rare_rate": 0.005, "tail_rate": 0.005},
    ]
    best_score = float("-inf")
    best_config = None
    best_stats = None
    coverage_config = None
    coverage_stats = None
    all_results = []
    for index, overrides in enumerate(candidates, 1):
        config = normalize_ssq_adaptive_config({
            **SSQ_ADAPTIVE_DEFAULTS,
            **overrides,
        })
        label = (
            f"{config['portfolio_mode']}_ov{config['max_red_overlap']}_"
            f"pool{config['candidate_replicates']}_"
            f"pen{config['soft_penalty_weight']}_"
            f"rare{config['rare_rate']}"
        )
        _progress["ssq"] = {
            "current": index,
            "total": len(candidates),
            "config": label,
        }
        stats = evaluate_ssq_adaptive_config(draws, config, validation_periods)
        score = (
            stats["p_big_prize"] * 2500.0
            + stats["p_5red"] * 600.0
            + stats["p_4red_blue"] * 180.0
            + stats["p_ge4"] * 80.0
            + stats["p_ge3"] * 6.0
            + stats["avg_joint_power"] * 0.015
            + stats["avg_max_red"]
        )
        row = {
            "config": label,
            **overrides,
            "score": score,
            "p_ge4": stats["p_ge4"],
            "p_ge3": stats["p_ge3"],
            "p_5red": stats["p_5red"],
            "p_big_prize": stats["p_big_prize"],
            "blue_rate": stats["blue_rate"],
            "blue_aligned_rate": stats["blue_aligned_rate"],
            "p_4red_blue": stats["p_4red_blue"],
            "avg_joint_power": stats["avg_joint_power"],
            "avg_max_red": stats["avg_max_red"],
        }
        all_results.append(row)
        if config["portfolio_mode"] == "coverage":
            coverage_config = config
            coverage_stats = stats
        if score > best_score:
            best_score = score
            best_config = config
            best_stats = stats

    profile = EmpiricalProfile.from_draws(draws)
    assert (
        best_config is not None
        and best_stats is not None
        and coverage_config is not None
        and coverage_stats is not None
    )

    recent_best_config = best_config
    recent_best_stats = best_stats
    stability_periods = max(
        validation_periods,
        min(200, len(draws) - 100),
    )
    coverage_stability = evaluate_ssq_adaptive_config(
        draws, coverage_config, stability_periods
    )
    if recent_best_config["portfolio_mode"] == "coverage":
        candidate_stability = coverage_stability
    else:
        candidate_stability = evaluate_ssq_adaptive_config(
            draws, recent_best_config, stability_periods
        )
    overlap_promoted = (
        recent_best_config["portfolio_mode"] == "jackpot_overlap"
        and candidate_stability["p_ge4"] >= coverage_stability["p_ge4"]
        and candidate_stability["p_ge3"] >= coverage_stability["p_ge3"]
        and candidate_stability["avg_max_red"] >= coverage_stability["avg_max_red"]
        and candidate_stability["avg_joint_power"]
        >= coverage_stability["avg_joint_power"]
    )
    if not overlap_promoted:
        best_config = coverage_config
        best_stats = coverage_stats

    result = {
        "game": "ssq",
        "optimized_at": datetime.now().isoformat(timespec="seconds"),
        "periods": validation_periods,
        "requested_periods": periods,
        "stability_periods": stability_periods,
        "total_configs": len(candidates),
        "mode": "adaptive_empirical_search",
        "algorithm": SSQ_ADAPTIVE_ALGORITHM,
        "overlap_promoted": overlap_promoted,
        "best_config": best_config,
        "best_stats": {
            "p_ge4": best_stats["p_ge4"],
            "p_ge3": best_stats["p_ge3"],
            "p_5red": best_stats["p_5red"],
            "p_4r_full_blue": best_stats["p_4r_full_blue"],
            "p_big_prize": best_stats["p_big_prize"],
            "blue_rate": best_stats["blue_rate"],
            "blue_aligned_rate": best_stats["blue_aligned_rate"],
            "p_4red_blue": best_stats["p_4red_blue"],
            "avg_joint_power": best_stats["avg_joint_power"],
            "avg_max_red": best_stats["avg_max_red"],
            "ge4_count": best_stats["ge4_count"],
            "ge3_count": best_stats["ge3_count"],
            "p5_count": best_stats["p5_count"],
            "big_prize_count": best_stats["big_prize_count"],
        },
        "learning_profile": profile.summary(
            rare_rate=float(best_config["rare_rate"]),
            tail_rate=float(best_config["tail_rate"]),
        ),
        "stability_stats": {
            "recent_winner_mode": recent_best_config["portfolio_mode"],
            "selected_mode": best_config["portfolio_mode"],
            "recent_winner": {
                key: candidate_stability[key] for key in (
                    "p_ge4", "p_ge3", "p_5red", "p_4red_blue",
                    "p_big_prize", "blue_rate", "blue_aligned_rate",
                    "avg_joint_power", "avg_max_red",
                )
            },
            "coverage_baseline": {
                key: coverage_stability[key] for key in (
                    "p_ge4", "p_ge3", "p_5red", "p_4red_blue",
                    "p_big_prize", "blue_rate", "blue_aligned_rate",
                    "avg_joint_power", "avg_max_red",
                )
            },
        },
        "all_results": sorted(all_results, key=lambda item: -item["score"]),
    }
    return result


def optimize_dlt(periods: int = 100) -> dict:
    """选择大乐透基线、联合版与双色球迁移覆盖版。

    最近窗口负责挑选候选，最长200期窗口负责晋升闸门。只有迁移策略在
    两个窗口都不降低核心前区、同注和中奖指标时，才进入生产配置。
    """
    draws = dlt_db_mod.get_all_draws("ASC")
    if len(draws) < 300:
        raise ValueError(f"大乐透历史数据不足：{len(draws)}期")
    validation_periods = max(20, min(int(periods), 50))

    def score(stats: dict) -> float:
        return (
            stats["p_big_prize"] * 3000.0
            + stats["p_5red"] * 800.0
            + stats["p_4red"] * 240.0
            + stats["p_3r_2b"] * 160.0
            + stats["p_ge4"] * 100.0
            + stats["p_ge3"] * 8.0
            + stats["avg_joint_power"] * 0.02
            + stats["avg_max_red"]
        )

    baseline_configs = [
        normalize_dlt_adaptive_config({
            **DLT_ADAPTIVE_DEFAULTS, "train_window": window,
            "soft_penalty_weight": 0.0, "portfolio_mode": "baseline",
        })
        for window in (50, 100, 200)
    ]
    baseline_rows = []
    total_configs = len(baseline_configs) + 5
    for index, config in enumerate(baseline_configs, 1):
        label = f"v4_win{config['train_window']}"
        _progress["dlt"] = {
            "current": index, "total": total_configs, "config": label
        }
        stats = evaluate_dlt_adaptive_config(
            draws, config, validation_periods, adaptive=False
        )
        baseline_rows.append({
            "config": label, "variant": "v4_baseline", **config,
            "score": score(stats), **stats,
        })
    best_baseline = max(baseline_rows, key=lambda item: item["score"])
    base_config = normalize_dlt_adaptive_config(best_baseline)

    adaptive_overrides = [
        {"strategy": "ssq_transfer_coverage",
         "candidate_replicates": 12,
         "exclude_seen_red": False, "soft_penalty_weight": 0.0,
         "rare_rate": 0.005, "tail_rate": 0.005, "blue_mode": "coverage",
         "portfolio_mode": "coverage"},
        {"exclude_seen_red": False, "soft_penalty_weight": 0.0,
         "rare_rate": 0.005, "tail_rate": 0.005, "blue_mode": "joint",
         "portfolio_mode": "adaptive"},
        {"exclude_seen_red": False, "soft_penalty_weight": 0.5,
         "rare_rate": 0.005, "tail_rate": 0.005, "blue_mode": "joint",
         "portfolio_mode": "adaptive"},
        {"exclude_seen_red": True, "soft_penalty_weight": 0.5,
         "rare_rate": 0.005, "tail_rate": 0.005, "blue_mode": "joint",
         "portfolio_mode": "adaptive"},
        {"exclude_seen_red": False, "soft_penalty_weight": 0.0,
         "rare_rate": 0.005, "tail_rate": 0.005, "blue_mode": "coverage",
         "portfolio_mode": "adaptive"},
    ]
    adaptive_rows = []
    total_configs = len(baseline_configs) + len(adaptive_overrides)
    for offset, overrides in enumerate(adaptive_overrides, 1):
        config = normalize_dlt_adaptive_config({**base_config, **overrides})
        if config["portfolio_mode"] == "coverage":
            label = (
                "v7_transfer_coverage_"
                f"pool{config['candidate_replicates']}_"
                f"pen{config['soft_penalty_weight']}"
            )
        else:
            label = (
                f"v6_{config['blue_mode']}_"
                f"redseen{int(config['exclude_seen_red'])}_"
                f"pen{config['soft_penalty_weight']}"
            )
        _progress["dlt"] = {
            "current": len(baseline_configs) + offset,
            "total": total_configs,
            "config": label,
        }
        stats = evaluate_dlt_adaptive_config(
            draws, config, validation_periods, adaptive=True
        )
        adaptive_rows.append({
            "config": label,
            "variant": (
                "v7_transfer_coverage"
                if config["portfolio_mode"] == "coverage"
                else "v6_adaptive"
            ),
            **config,
            "score": score(stats), **stats,
        })
    best_adaptive = max(adaptive_rows, key=lambda item: item["score"])
    stability_periods = max(
        validation_periods,
        min(200, len(draws) - 100),
    )
    baseline_stability = evaluate_dlt_adaptive_config(
        draws,
        normalize_dlt_adaptive_config(best_baseline),
        stability_periods,
        adaptive=False,
    )
    adaptive_stability = evaluate_dlt_adaptive_config(
        draws,
        normalize_dlt_adaptive_config(best_adaptive),
        stability_periods,
        adaptive=True,
    )
    promoted = (
        best_adaptive["score"] >= best_baseline["score"]
        and best_adaptive["p_ge3"] >= best_baseline["p_ge3"]
        and best_adaptive["avg_joint_power"] >= best_baseline["avg_joint_power"]
        and adaptive_stability["p_ge4"] >= baseline_stability["p_ge4"]
        and adaptive_stability["p_ge3"] >= baseline_stability["p_ge3"]
        and adaptive_stability["avg_max_red"] >= baseline_stability["avg_max_red"]
        and adaptive_stability["avg_joint_power"]
        >= baseline_stability["avg_joint_power"]
        and adaptive_stability["winning_rate"]
        >= baseline_stability["winning_rate"]
    )
    selected = best_adaptive if promoted else best_baseline
    best_config = normalize_dlt_adaptive_config(selected)
    best_stats = selected
    profile = DltEmpiricalProfile.from_draws(draws)

    result = {
        "game": "dlt",
        "optimized_at": datetime.now().isoformat(timespec="seconds"),
        "periods": validation_periods,
        "requested_periods": periods,
        "stability_periods": stability_periods,
        "total_configs": total_configs,
        "mode": "adaptive_empirical_search",
        "algorithm": DLT_ADAPTIVE_ALGORITHM if promoted else "dlt-sina-v4",
        "promoted": promoted,
        "best_config": best_config,
        "best_stats": {
            "p_ge4": best_stats["p_ge4"],
            "p_ge3": best_stats["p_ge3"],
            "p_5red": best_stats["p_5red"],
            "p_4r_full_blue": best_stats["p_big_prize"],
            "p_big_prize": best_stats["p_big_prize"],
            "blue_rate": best_stats["blue_rate"],
            "blue_aligned_rate": best_stats["blue_aligned_rate"],
            "p_4red": best_stats["p_4red"],
            "avg_joint_power": best_stats["avg_joint_power"],
            "avg_max_red": best_stats["avg_max_red"],
            "ge4_count": best_stats["ge4_count"],
            "ge3_count": best_stats["ge3_count"],
            "p5_count": best_stats["p5_count"],
            "big_prize_count": best_stats["big_prize_count"],
            "winning_rate": best_stats["winning_rate"],
            "p_3r_2b": best_stats["p_3r_2b"],
            "prize_counts": best_stats["prize_counts"],
        },
        "baseline_stats": {
            key: best_baseline[key] for key in (
                "p_ge4", "p_ge3", "p_5red", "p_3r_2b", "p_4red",
                "p_big_prize", "blue_rate", "blue_aligned_rate",
                "avg_joint_power", "winning_rate", "avg_max_red", "prize_counts"
            )
        },
        "stability_stats": {
            "selected_candidate": {
                key: adaptive_stability[key] for key in (
                    "p_ge4", "p_ge3", "p_5red", "p_3r_2b", "p_4red",
                    "p_big_prize", "blue_rate", "blue_aligned_rate",
                    "avg_joint_power", "winning_rate", "avg_max_red",
                    "prize_counts",
                )
            },
            "baseline": {
                key: baseline_stability[key] for key in (
                    "p_ge4", "p_ge3", "p_5red", "p_3r_2b", "p_4red",
                    "p_big_prize", "blue_rate", "blue_aligned_rate",
                    "avg_joint_power", "winning_rate", "avg_max_red",
                    "prize_counts",
                )
            },
        },
        "learning_profile": profile.summary(
            rare_rate=float(best_config["rare_rate"]),
            tail_rate=float(best_config["tail_rate"]),
        ),
        "all_results": sorted(
            baseline_rows + adaptive_rows, key=lambda item: -item["score"]
        ),
    }
    return result


def save_optimizer_state(state: dict) -> None:
    """保存优化结果到本地文件。"""
    existing = {}
    if OPTIMIZER_STATE_PATH.exists():
        try:
            existing = json.loads(OPTIMIZER_STATE_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            existing = {}
    existing[state["game"]] = state
    OPTIMIZER_STATE_PATH.write_text(
        json.dumps(existing, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_optimizer_state(game: str) -> dict | None:
    """读取指定彩种的上次优化结果。"""
    if not OPTIMIZER_STATE_PATH.exists():
        return None
    try:
        data = json.loads(OPTIMIZER_STATE_PATH.read_text(encoding="utf-8"))
        return data.get(game)
    except (json.JSONDecodeError, OSError):
        return None


def get_optimized_config(game: str) -> dict:
    """获取自学习最优参数，不存在时返回None。"""
    state = load_optimizer_state(game)
    if state and state.get("best_config"):
        return state["best_config"]
    return None


def get_progress(game: str) -> dict:
    """获取当前优化进度。"""
    return _progress.get(game, {})


def run_optimization(game: str, periods: int = 50) -> dict:
    """执行优化并保存结果。"""
    if game == "ssq":
        result = optimize_ssq(periods)
    elif game == "dlt":
        result = optimize_dlt(periods)
    else:
        raise ValueError(f"未知彩种: {game}")
    save_optimizer_state(result)
    _progress.pop(game, None)
    return result
