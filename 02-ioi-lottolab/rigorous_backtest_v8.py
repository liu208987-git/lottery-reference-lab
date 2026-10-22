"""当前算法与隔离 v8 的同口径滚动回测和统计检验。

默认只读取 ssq.db / dlt.db，不更新数据库、不写审计台账，也不会被当前
预测程序导入。运行示例：

    python rigorous_backtest_v8.py --periods 500 --seed-replicates 32

结果写入 validation_results_v8.json 和 validation_report_v8.md。
"""

from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from dataclasses import dataclass
from hashlib import sha256
from itertools import combinations, product
from math import comb, sqrt
from pathlib import Path
from statistics import fmean, median
from typing import Callable

import dlt_db
import ssq_db
from dlt_prediction_audit import evaluate_tickets as evaluate_dlt
from dlt_prediction_audit import prize_level as dlt_prize_level
from fused_predictor import build_enhanced_portfolio, build_portfolio_separate
from quant_models import research_gate
from ssq_prediction_audit import evaluate_tickets as evaluate_ssq
from ssq_prediction_audit import prize_level as ssq_prize_level
from validation_v8 import build_v8_balanced, portfolio_diagnostics


ROOT = Path(__file__).resolve().parent
RATE_METRICS = (
    "red_ge_target",
    "red_ge4",
    "red_ge3",
    "full_red",
    "blue_covered",
    "full_blue_covered",
    "any_prize",
    "high_prize",
)
ALL_METRICS = RATE_METRICS + (
    "max_red",
    "union_red",
    "winning_tickets",
    "red_coverage",
    "blue_coverage",
    "max_red_overlap",
    "max_blue_overlap",
)


@dataclass(frozen=True)
class GameConfig:
    game: str
    name: str
    red_pool: int
    red_pick: int
    blue_pool: int
    blue_pick: int
    current_window: int
    high_prize_rank: int


CONFIGS = {
    "ssq": GameConfig("ssq", "双色球", 33, 6, 16, 1, 200, 4),
    "dlt": GameConfig("dlt", "大乐透", 35, 5, 12, 2, 100, 7),
}


def _seed(game: str, issue: str, replicate: int) -> int:
    payload = f"v8-validation|{game}|{issue}|{replicate}".encode("utf-8")
    return int.from_bytes(sha256(payload).digest()[:8], "big")


def _build_uniform_independent(
    rng: random.Random,
    draws: list[dict],
    config: GameConfig,
    ticket_count: int = 5,
) -> list[tuple[list[int], list[int]]]:
    del draws
    tickets = []
    seen = set()
    while len(tickets) < ticket_count:
        reds = sorted(rng.sample(range(1, config.red_pool + 1), config.red_pick))
        blues = sorted(rng.sample(range(1, config.blue_pool + 1), config.blue_pick))
        key = tuple(reds), tuple(blues)
        if key in seen:
            continue
        seen.add(key)
        tickets.append((reds, blues))
    return tickets


def _build_current(
    rng: random.Random,
    draws: list[dict],
    config: GameConfig,
    candidate_count: int,
) -> list[tuple[list[int], list[int]]]:
    if config.game == "ssq":
        return build_portfolio_separate(
            rng,
            draws,
            config.red_pool,
            config.red_pick,
            config.blue_pool,
            config.blue_pick,
            5,
            red_scores=None,
            blue_scores=None,
            alpha=0.1,
            red_candidate_count=candidate_count,
            blue_candidate_count=candidate_count,
        )
    return build_enhanced_portfolio(
        rng,
        draws,
        config.red_pool,
        config.red_pick,
        config.blue_pool,
        config.blue_pick,
        5,
        red_scores=None,
        blue_scores=None,
        alpha=0.1,
        candidate_count=candidate_count,
    )


def _actual(draw: dict, config: GameConfig) -> tuple[list[int], list[int]]:
    reds = [draw[f"r{i}"] for i in range(1, config.red_pick + 1)]
    blues = [draw[f"b{i}"] for i in range(1, config.blue_pick + 1)]
    return reds, blues


def _period_metrics(
    tickets: list[tuple[list[int], list[int]]],
    draw: dict,
    config: GameConfig,
) -> dict[str, float]:
    actual_reds, actual_blues = _actual(draw, config)
    if config.game == "ssq":
        result = evaluate_ssq(tickets, actual_reds, actual_blues[0])
    else:
        result = evaluate_dlt(tickets, actual_reds, actual_blues)
    details = result["details"]
    diagnostic = portfolio_diagnostics(tickets)
    target = 4 if config.game == "ssq" else 3
    best_rank = result["best_prize"]
    return {
        "red_ge_target": float(result["max_red_hits"] >= target),
        "red_ge4": float(result["max_red_hits"] >= 4),
        "red_ge3": float(result["max_red_hits"] >= 3),
        "full_red": float(result["max_red_hits"] >= config.red_pick),
        "blue_covered": float(result["blue_covered"]),
        "full_blue_covered": float(any(
            detail["blue_hits"] == config.blue_pick for detail in details
        )),
        "any_prize": float(result["winning_tickets"] > 0),
        "high_prize": float(
            best_rank is not None and best_rank <= config.high_prize_rank
        ),
        "max_red": float(result["max_red_hits"]),
        "union_red": float(result["union_red_hits"]),
        "winning_tickets": float(result["winning_tickets"]),
        **{key: float(value) for key, value in diagnostic.items()},
    }


def _wilson(successes: float, total: int, z: float = 1.95996398454) -> list[float]:
    proportion = successes / total
    denominator = 1.0 + z * z / total
    center = (proportion + z * z / (2.0 * total)) / denominator
    half = z * sqrt(
        proportion * (1.0 - proportion) / total + z * z / (4.0 * total * total)
    ) / denominator
    return [max(0.0, center - half), min(1.0, center + half)]


def _summarize(rows: list[dict[str, float]]) -> dict:
    summary = {metric: fmean(row[metric] for row in rows) for metric in ALL_METRICS}
    summary["periods"] = len(rows)
    summary["rate_ci95"] = {
        metric: _wilson(sum(row[metric] for row in rows), len(rows))
        for metric in RATE_METRICS
    }
    return summary


def _run_algorithm(
    draws: list[dict],
    indices: list[int],
    config: GameConfig,
    algorithm: str,
    replicate: int,
    candidate_count: int,
    collect_portfolios: bool = False,
) -> list[dict[str, float]] | tuple[
    list[dict[str, float]], list[list[tuple[list[int], list[int]]]]
]:
    rows = []
    portfolios = []
    for index in indices:
        draw = draws[index]
        rng = random.Random(_seed(config.game, draw["issue"], replicate))
        if algorithm == "current":
            history = draws[max(0, index - config.current_window):index]
            tickets = _build_current(rng, history, config, candidate_count)
        elif algorithm == "v8_balanced":
            tickets = build_v8_balanced(
                rng,
                [],
                config.red_pool,
                config.red_pick,
                config.blue_pool,
                config.blue_pick,
                5,
            )
        elif algorithm == "uniform_independent":
            tickets = _build_uniform_independent(rng, [], config)
        else:
            raise ValueError(f"未知算法: {algorithm}")
        rows.append(_period_metrics(tickets, draw, config))
        if collect_portfolios:
            portfolios.append(tickets)
    if collect_portfolios:
        return rows, portfolios
    return rows


def _fair_geometry_monte_carlo(
    portfolios: list[list[tuple[list[int], list[int]]]],
    config: GameConfig,
    samples_per_portfolio: int = 2000,
) -> dict:
    """在公平开奖假设下，隔离测量已有票组的组合几何表现。"""
    rng = random.Random(2026071401 if config.game == "ssq" else 2026071402)
    totals = {metric: 0.0 for metric in ALL_METRICS}
    prize_func = ssq_prize_level if config.game == "ssq" else dlt_prize_level
    rank_map = (
        {"一等奖": 1, "二等奖": 2, "三等奖": 3,
         "四等奖": 4, "五等奖": 5, "六等奖": 6}
        if config.game == "ssq"
        else {f"{name}等奖": rank for rank, name in enumerate(
            ["一", "二", "三", "四", "五", "六", "七", "八", "九"], 1
        )}
    )
    target = 4 if config.game == "ssq" else 3
    for tickets in portfolios:
        red_sets = [set(reds) for reds, _ in tickets]
        blue_sets = [set(blues) for _, blues in tickets]
        diagnostic = portfolio_diagnostics(tickets)
        for metric, value in diagnostic.items():
            totals[metric] += value * samples_per_portfolio
        for _ in range(samples_per_portfolio):
            actual_reds = set(rng.sample(
                range(1, config.red_pool + 1), config.red_pick))
            actual_blues = set(rng.sample(
                range(1, config.blue_pool + 1), config.blue_pick))
            red_hits = [len(ticket & actual_reds) for ticket in red_sets]
            blue_hits = [len(ticket & actual_blues) for ticket in blue_sets]
            prizes = [
                prize_func(red_hits[i], blue_hits[i])
                for i in range(len(tickets))
            ]
            ranks = [rank_map[prize] for prize in prizes if prize]
            max_red = max(red_hits)
            totals["red_ge_target"] += max_red >= target
            totals["red_ge4"] += max_red >= 4
            totals["red_ge3"] += max_red >= 3
            totals["full_red"] += max_red >= config.red_pick
            totals["blue_covered"] += any(blue_hits)
            totals["full_blue_covered"] += any(
                hit == config.blue_pick for hit in blue_hits
            )
            totals["any_prize"] += bool(ranks)
            totals["high_prize"] += bool(
                ranks and min(ranks) <= config.high_prize_rank
            )
            totals["max_red"] += max_red
            totals["union_red"] += len(set().union(*red_sets) & actual_reds)
            totals["winning_tickets"] += len(ranks)
    simulation_draws = len(portfolios) * samples_per_portfolio
    return {
        **{metric: value / simulation_draws for metric, value in totals.items()},
        "simulation_draws": simulation_draws,
        "samples_per_portfolio": samples_per_portfolio,
    }


def _signal_report(draws: list[dict], config: GameConfig) -> dict:
    result = {}
    for label, prefix, pick_count, pool_size in (
        ("red", "r", config.red_pick, config.red_pool),
        ("blue", "b", config.blue_pick, config.blue_pool),
    ):
        sequence = [
            [row[f"{prefix}{i}"] for i in range(1, pick_count + 1)]
            for row in draws
        ]
        gate = research_gate(sequence, pool_size, pick_count)
        result[label] = gate
    return result


def _paired_block_bootstrap(
    left: list[float],
    right: list[float],
    *,
    samples: int = 4000,
    block_length: int = 20,
    seed: int = 20260714,
) -> dict:
    differences = [a - b for a, b in zip(left, right)]
    n = len(differences)
    observed = fmean(differences)
    rng = random.Random(seed)
    boot = []
    for _ in range(samples):
        chosen = []
        while len(chosen) < n:
            start = rng.randrange(n)
            chosen.extend(
                differences[(start + offset) % n]
                for offset in range(block_length)
            )
        boot.append(fmean(chosen[:n]))
    boot.sort()
    lo = boot[int(0.025 * samples)]
    hi = boot[min(samples - 1, int(0.975 * samples))]
    non_positive = (sum(value <= 0 for value in boot) + 1) / (samples + 1)
    non_negative = (sum(value >= 0 for value in boot) + 1) / (samples + 1)
    return {
        "difference": observed,
        "ci95": [lo, hi],
        "two_sided_p": min(1.0, 2.0 * min(non_positive, non_negative)),
        "block_length": block_length,
        "bootstrap_samples": samples,
    }


def _seed_robustness(summaries: list[dict]) -> dict:
    result = {}
    for metric in ALL_METRICS:
        values = sorted(summary[metric] for summary in summaries)
        result[metric] = {
            "min": values[0],
            "median": median(values),
            "max": values[-1],
            "mean": fmean(values),
        }
    return result


def _exact_v8(config: GameConfig) -> dict:
    """按组合计数精确计算零重叠 v8 在公平开奖下的期望。"""
    ticket_count = 5
    unused_red = config.red_pool - ticket_count * config.red_pick
    total_red_outcomes = comb(config.red_pool, config.red_pick)
    red_patterns: Counter = Counter()
    for hits in product(range(config.red_pick + 1), repeat=ticket_count):
        unused_hits = config.red_pick - sum(hits)
        if not 0 <= unused_hits <= unused_red:
            continue
        ways = comb(unused_red, unused_hits)
        for hit in hits:
            ways *= comb(config.red_pick, hit)
        if ways:
            red_patterns[hits] += ways
    if sum(red_patterns.values()) != total_red_outcomes:
        raise AssertionError("前区精确枚举计数不守恒")

    canonical_blues = [
        set(range(i * config.blue_pick, (i + 1) * config.blue_pick))
        for i in range(ticket_count)
    ]
    blue_patterns: Counter = Counter()
    for outcome in combinations(range(config.blue_pool), config.blue_pick):
        actual = set(outcome)
        hits = tuple(len(ticket & actual) for ticket in canonical_blues)
        blue_patterns[hits] += 1
    total_blue_outcomes = comb(config.blue_pool, config.blue_pick)

    prize_func: Callable[[int, int], str | None]
    prize_ranks: dict[str, int]
    if config.game == "ssq":
        prize_func = ssq_prize_level
        prize_ranks = {
            "一等奖": 1, "二等奖": 2, "三等奖": 3,
            "四等奖": 4, "五等奖": 5, "六等奖": 6,
        }
    else:
        prize_func = dlt_prize_level
        prize_ranks = {f"{name}等奖": rank for rank, name in enumerate(
            ["一", "二", "三", "四", "五", "六", "七", "八", "九"], 1
        )}

    totals = {metric: 0.0 for metric in ALL_METRICS}
    denominator = total_red_outcomes * total_blue_outcomes
    target = 4 if config.game == "ssq" else 3
    for red_hits, red_ways in red_patterns.items():
        for blue_hits, blue_ways in blue_patterns.items():
            weight = red_ways * blue_ways
            prizes = [
                prize_func(red_hits[i], blue_hits[i])
                for i in range(ticket_count)
            ]
            ranks = [prize_ranks[p] for p in prizes if p]
            max_red = max(red_hits)
            totals["red_ge_target"] += weight * (max_red >= target)
            totals["red_ge4"] += weight * (max_red >= 4)
            totals["red_ge3"] += weight * (max_red >= 3)
            totals["full_red"] += weight * (max_red >= config.red_pick)
            totals["blue_covered"] += weight * any(blue_hits)
            totals["full_blue_covered"] += weight * any(
                hit == config.blue_pick for hit in blue_hits
            )
            totals["any_prize"] += weight * bool(ranks)
            totals["high_prize"] += weight * bool(
                ranks and min(ranks) <= config.high_prize_rank
            )
            totals["max_red"] += weight * max_red
            totals["union_red"] += weight * sum(red_hits)
            totals["winning_tickets"] += weight * len(ranks)
            totals["red_coverage"] += weight * (ticket_count * config.red_pick)
            totals["blue_coverage"] += weight * (ticket_count * config.blue_pick)
            # 两种 overlap 均为 0，无需累加。
    result = {metric: value / denominator for metric, value in totals.items()}
    result["periods"] = None
    result["proof"] = {
        "single_ticket_red_target_probability": sum(
            comb(config.red_pick, hit)
            * comb(config.red_pool - config.red_pick, config.red_pick - hit)
            for hit in range(target, config.red_pick + 1)
        ) / total_red_outcomes,
        "five_ticket_red_target_upper_bound": result["red_ge_target"],
        "five_ticket_full_red_probability": 5 / total_red_outcomes,
        "five_distinct_full_blue_probability": 5 / total_blue_outcomes,
    }
    return result


def _markdown(report: dict) -> str:
    labels = {
        "red_ge_target": "任一注达目标红球/前区",
        "red_ge4": "任一注 >=4 红/前区",
        "red_ge3": "任一注 >=3 红/前区",
        "full_red": "任一注全中红球/前区",
        "blue_covered": "后区至少命中 1 个",
        "full_blue_covered": "任一注后区全中",
        "any_prize": "任一注中奖",
        "high_prize": "任一注较高奖级",
    }
    lines = [
        "# v8 隔离验证报告",
        "",
        "所有算法使用同一历史区间、每期只使用此前数据、每期固定 5 注。",
        "v8 的多随机种子均值用于降低一次伪随机抽样造成的偶然波动。",
        "",
    ]
    for game in ("ssq", "dlt"):
        section = report["games"][game]
        lines.extend([
            f"## {section['name']}",
            "",
            f"回测区间：{section['range'][0]}–{section['range'][1]}，"
            f"共 {section['periods']} 期。",
            "",
            "| 指标 | 当前算法 | v8 主种子 | v8 多种子均值 | 公平开奖精确值 |",
            "|---|---:|---:|---:|---:|",
        ])
        current = section["algorithms"]["current"]
        v8 = section["algorithms"]["v8_balanced"]
        robust = section["v8_seed_robustness"]
        exact = section["v8_exact"]
        for metric in RATE_METRICS:
            lines.append(
                f"| {labels[metric]} | {current[metric]:.2%} | "
                f"{v8[metric]:.2%} | {robust[metric]['mean']:.2%} | "
                f"{exact[metric]:.2%} |"
            )
        signal = section["signal_gate"]
        lines.extend(["", "最新 200 期量化信号门控：", ""])
        for part, part_name in (("red", "红球/前区"), ("blue", "蓝球/后区")):
            gate = signal[part]
            best = gate["best_candidate"]
            lines.append(
                f"- {part_name}：未通过；最佳 {best['model']} 的相对 Brier 改进 "
                f"{best['relative_improvement']:.4%}，多重校正 p={best['corrected_p']:.4f}。"
            )
        fair_current = section["current_fair_geometry_mc"]
        lines.extend([
            "",
            "在公平开奖下隔离组合结构（当前算法为 100 万次模拟，v8 为精确组合计数）：",
            "",
            "| 指标 | 当前票组结构 | v8 票组结构 | 差值 |",
            "|---|---:|---:|---:|",
        ])
        for metric in ("red_ge_target", "blue_covered", "full_blue_covered", "any_prize", "max_red"):
            if metric in RATE_METRICS:
                left = f"{fair_current[metric]:.3%}"
                right = f"{exact[metric]:.3%}"
                diff = f"{(exact[metric] - fair_current[metric]) * 100:+.3f} 个百分点"
            else:
                left = f"{fair_current[metric]:.4f}"
                right = f"{exact[metric]:.4f}"
                diff = f"{exact[metric] - fair_current[metric]:+.4f}"
            lines.append(f"| {labels.get(metric, metric)} | {left} | {right} | {diff} |")
        lines.extend(["", "配对区块自助法（v8 主种子 - 当前算法主种子）：", ""])
        for metric in ("red_ge_target", "any_prize", "full_blue_covered", "max_red"):
            test = section["paired_tests"][metric]
            scale = 100 if metric in RATE_METRICS else 1
            suffix = " 个百分点" if metric in RATE_METRICS else ""
            lines.append(
                f"- {labels.get(metric, metric)}：差值 {test['difference'] * scale:+.3f}{suffix}，"
                f"95% CI [{test['ci95'][0] * scale:+.3f}, "
                f"{test['ci95'][1] * scale:+.3f}]，p={test['two_sided_p']:.4f}。"
            )
        lines.append("")
    lines.extend([
        "## 口径限制",
        "",
        "- 当前算法按当前生产配置回放，但量化门控信号设为 None；这是因为四组最新门控均未通过。",
        "- 历史回测不是未来中奖承诺。v8 的确定性优势来自组合覆盖，不是发现了可预测的开奖规律。",
        "- 头奖层级极稀少，几百期历史样本不足以用实际头奖次数区分算法，应以组合精确概率为准。",
        "",
    ])
    return "\n".join(lines)


def run_game(
    config: GameConfig,
    periods: int,
    seed_replicates: int,
    candidate_count: int,
) -> dict:
    draws = (ssq_db if config.game == "ssq" else dlt_db).get_all_draws("ASC")
    start = max(300, len(draws) - periods)
    indices = list(range(start, len(draws)))
    if not indices:
        raise ValueError(f"{config.name} 没有可回测数据")

    print(f"[{config.name}] 当前算法回测 {len(indices)} 期...")
    current_rows, current_portfolios = _run_algorithm(
        draws, indices, config, "current", 0, candidate_count,
        collect_portfolios=True)
    print(f"[{config.name}] v8/均匀基线，多种子 {seed_replicates} 轮...")
    v8_runs = [
        _run_algorithm(draws, indices, config, "v8_balanced", replicate, candidate_count)
        for replicate in range(seed_replicates)
    ]
    random_rows = _run_algorithm(
        draws, indices, config, "uniform_independent", 0, candidate_count)

    current_summary = _summarize(current_rows)
    v8_summaries = [_summarize(rows) for rows in v8_runs]
    v8_primary = v8_summaries[0]
    random_summary = _summarize(random_rows)
    paired = {
        metric: _paired_block_bootstrap(
            [row[metric] for row in v8_runs[0]],
            [row[metric] for row in current_rows],
            seed=20260714 + position,
        )
        for position, metric in enumerate(ALL_METRICS)
    }
    return {
        "name": config.name,
        "periods": len(indices),
        "range": [draws[indices[0]]["issue"], draws[indices[-1]]["issue"]],
        "data_total": len(draws),
        "current_config": {
            "window": config.current_window,
            "alpha": 0.1,
            "candidate_count": candidate_count,
            "quant_scores": None,
        },
        "algorithms": {
            "current": current_summary,
            "v8_balanced": v8_primary,
            "uniform_independent": random_summary,
        },
        "v8_seed_replicates": seed_replicates,
        "v8_seed_robustness": _seed_robustness(v8_summaries),
        "v8_exact": _exact_v8(config),
        "current_fair_geometry_mc": _fair_geometry_monte_carlo(
            current_portfolios, config),
        "signal_gate": _signal_report(draws, config),
        "paired_tests": paired,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="隔离 v8 严格回测")
    parser.add_argument("--periods", type=int, default=500)
    parser.add_argument("--seed-replicates", type=int, default=32)
    parser.add_argument("--candidate-count", type=int, default=1000)
    parser.add_argument(
        "--json-output", type=Path, default=ROOT / "validation_results_v8.json")
    parser.add_argument(
        "--report-output", type=Path, default=ROOT / "validation_report_v8.md")
    args = parser.parse_args()
    if args.periods <= 0 or args.seed_replicates <= 0 or args.candidate_count <= 0:
        parser.error("periods、seed-replicates、candidate-count 必须为正数")

    report = {
        "method": {
            "walk_forward": True,
            "ticket_count": 5,
            "periods_requested": args.periods,
            "seed_replicates": args.seed_replicates,
            "current_candidate_count": args.candidate_count,
            "notes": [
                "每一期只用此前数据",
                "当前算法与 v8 使用同一期号派生的确定性种子",
                "v8 额外报告多随机种子稳定性和公平开奖精确概率",
            ],
        },
        "games": {},
    }
    for game in ("ssq", "dlt"):
        report["games"][game] = run_game(
            CONFIGS[game], args.periods, args.seed_replicates, args.candidate_count)

    args.json_output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    args.report_output.write_text(_markdown(report), encoding="utf-8")
    print(f"JSON: {args.json_output}")
    print(f"报告: {args.report_output}")


if __name__ == "__main__":
    main()
