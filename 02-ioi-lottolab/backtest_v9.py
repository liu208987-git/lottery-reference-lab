"""双色球 v8 与 v9 的全历史无泄漏配对回测。

默认从第301条历史记录开始逐期预测，共回放当前数据库中其后的全部开奖。
每一期只能使用此前数据。除生产确定性种子外，还用共同种子重复比较，避免把
单次伪随机抽样差异误判为过滤规则带来的提升。
"""

from __future__ import annotations

import argparse
import json
import math
import random
from collections import Counter
from datetime import datetime
from hashlib import sha256
from itertools import combinations
from pathlib import Path
from statistics import fmean, median

import ssq_db
from app_paths import DATA_ROOT
from ssq_prediction_audit import evaluate_tickets
from v8_predictor import build_v8_balanced, v8_rng
from v9_predictor import (
    ALGORITHM_NAME,
    DEFAULT_FILTER_CONFIG,
    FILTER_PRIORITY,
    build_v9_filtered,
    full_ticket_key,
    historical_full_ticket_keys,
    red_filter_reasons,
    v9_rng,
)


START_INDEX = 300
TICKET_COUNT = 5
RATE_METRICS = (
    "blue_covered",
    "red_ge4",
    "red_ge3",
    "full_red",
    "any_prize",
    "blue_sixth_prize",
)
MEAN_METRICS = ("max_red", "union_red", "winning_tickets", "fixed_return")
FIXED_PRIZE = {
    "三等奖": 3000,
    "四等奖": 200,
    "五等奖": 10,
    "六等奖": 5,
}


def _comparison_seed(issue: str, replicate: int) -> int:
    payload = f"v8-v9-common-seed|{issue}|{replicate}".encode("utf-8")
    return int.from_bytes(sha256(payload).digest()[:8], "big")


def _actual(row: dict) -> tuple[list[int], int]:
    return [int(row[f"r{i}"]) for i in range(1, 7)], int(row["b1"])


def _period_metrics(tickets: list[tuple[list[int], list[int]]], row: dict) -> dict:
    actual_reds, actual_blue = _actual(row)
    result = evaluate_tickets(tickets, actual_reds, actual_blue)
    prize_counts = Counter(
        detail["prize"] for detail in result["details"] if detail["prize"])
    fixed_return = sum(
        FIXED_PRIZE.get(prize, 0) * count for prize, count in prize_counts.items())
    blue_sixth = any(
        detail["prize"] == "六等奖" for detail in result["details"])
    return {
        "issue": str(row["issue"]),
        "blue_covered": int(result["blue_covered"]),
        "red_ge4": int(result["max_red_hits"] >= 4),
        "red_ge3": int(result["max_red_hits"] >= 3),
        "full_red": int(result["max_red_hits"] >= 6),
        "any_prize": int(result["winning_tickets"] > 0),
        "blue_sixth_prize": int(blue_sixth),
        "max_red": float(result["max_red_hits"]),
        "union_red": float(result["union_red_hits"]),
        "winning_tickets": float(result["winning_tickets"]),
        "fixed_return": float(fixed_return),
        "prize_counts": dict(prize_counts),
    }


def _summarize(rows: list[dict]) -> dict:
    total = len(rows)
    prize_counts: Counter = Counter()
    for row in rows:
        prize_counts.update(row["prize_counts"])
    result = {
        "periods": total,
        **{metric: fmean(float(row[metric]) for row in rows)
           for metric in RATE_METRICS + MEAN_METRICS},
        "counts": {
            metric: int(sum(float(row[metric]) for row in rows))
            for metric in RATE_METRICS
        },
        "prize_counts": dict(prize_counts),
        "ticket_cost": total * TICKET_COUNT * 2,
        "fixed_prize_return": int(sum(row["fixed_return"] for row in rows)),
    }
    result["fixed_prize_roi"] = (
        result["fixed_prize_return"] / result["ticket_cost"])
    result["fixed_prize_net"] = (
        result["fixed_prize_return"] - result["ticket_cost"])
    result["variable_prize_events"] = (
        prize_counts.get("一等奖", 0) + prize_counts.get("二等奖", 0))
    return result


def _run_pair(
    draws: list[dict],
    *,
    replicate: int = 0,
    production_seeds: bool,
    collect_v9_metadata: bool = False,
) -> tuple[list[dict], list[dict], dict]:
    seen = historical_full_ticket_keys(draws[:START_INDEX])
    v8_rows: list[dict] = []
    v9_rows: list[dict] = []
    metadata_totals = Counter()

    for index in range(START_INDEX, len(draws)):
        row = draws[index]
        issue = str(row["issue"])
        if production_seeds:
            rng8 = v8_rng("ssq", issue, replicate)
            rng9 = v9_rng(issue, replicate)
        else:
            seed = _comparison_seed(issue, replicate)
            rng8 = random.Random(seed)
            rng9 = random.Random(seed)

        tickets8 = build_v8_balanced(rng8, [], 33, 6, 16, 1, TICKET_COUNT)
        built9 = build_v9_filtered(
            rng9, [draws[index - 1]], TICKET_COUNT,
            seen_full_tickets=seen,
            return_metadata=collect_v9_metadata,
        )
        if collect_v9_metadata:
            tickets9, metadata = built9
            metadata_totals["attempts"] += metadata["attempts"]
            metadata_totals["rejected_portfolios"] += metadata["rejected_portfolios"]
            metadata_totals["rejected_red_tickets"] += metadata["rejected_red_tickets"]
            metadata_totals["rejected_historical_tickets"] += metadata[
                "rejected_historical_tickets"]
        else:
            tickets9 = built9

        v8_rows.append(_period_metrics(tickets8, row))
        v9_rows.append(_period_metrics(tickets9, row))
        actual_reds, actual_blue = _actual(row)
        seen.add(full_ticket_key(actual_reds, actual_blue))

    return v8_rows, v9_rows, dict(metadata_totals)


def _paired_block_bootstrap(
    v9: list[float],
    v8: list[float],
    *,
    samples: int = 3000,
    block_length: int = 20,
    seed: int = 20260714,
) -> dict:
    differences = [left - right for left, right in zip(v9, v8)]
    n = len(differences)
    observed = fmean(differences)
    rng = random.Random(seed)
    boot = []
    for _ in range(samples):
        total = 0.0
        used = 0
        while used < n:
            start = rng.randrange(n)
            take = min(block_length, n - used)
            total += sum(differences[(start + offset) % n] for offset in range(take))
            used += take
        boot.append(total / n)
    boot.sort()
    lower = boot[int(0.025 * samples)]
    upper = boot[min(samples - 1, int(0.975 * samples))]
    non_positive = (sum(value <= 0 for value in boot) + 1) / (samples + 1)
    non_negative = (sum(value >= 0 for value in boot) + 1) / (samples + 1)
    return {
        "difference_v9_minus_v8": observed,
        "ci95": [lower, upper],
        "two_sided_p": min(1.0, 2 * min(non_positive, non_negative)),
        "bootstrap_samples": samples,
        "block_length": block_length,
    }


def _mcnemar_exact(v9: list[int], v8: list[int]) -> dict:
    v9_only = sum(left == 1 and right == 0 for left, right in zip(v9, v8))
    v8_only = sum(left == 0 and right == 1 for left, right in zip(v9, v8))
    discordant = v9_only + v8_only
    if discordant == 0:
        p_value = 1.0
    else:
        lower = min(v9_only, v8_only)
        logs = [
            math.lgamma(discordant + 1) - math.lgamma(k + 1)
            - math.lgamma(discordant - k + 1) - discordant * math.log(2)
            for k in range(lower + 1)
        ]
        largest = max(logs)
        tail = math.exp(largest) * math.fsum(
            math.exp(value - largest) for value in logs)
        p_value = min(1.0, 2 * tail)
    return {
        "v9_only": v9_only,
        "v8_only": v8_only,
        "discordant": discordant,
        "two_sided_p": p_value,
    }


def _seed_distribution(values: list[float]) -> dict:
    ordered = sorted(values)
    return {
        "min": ordered[0],
        "p10": ordered[int(0.10 * (len(ordered) - 1))],
        "median": median(ordered),
        "p90": ordered[int(0.90 * (len(ordered) - 1))],
        "max": ordered[-1],
        "mean": fmean(ordered),
    }


def _structural_rule_statistics(draws: list[dict]) -> dict:
    total_combinations = math.comb(33, 6)
    exact_reason_counts = Counter()
    exact_excluded = 0
    for reds in combinations(range(1, 34), 6):
        reasons = red_filter_reasons(reds)
        if reasons:
            exact_excluded += 1
            exact_reason_counts.update(reasons)

    historical_reason_counts = Counter()
    historical_excluded = 0
    seen = set()
    historical_full_duplicates = 0
    blue_repeats = 0
    for index, row in enumerate(draws):
        reds, blue = _actual(row)
        reasons = red_filter_reasons(reds)
        if reasons:
            historical_excluded += 1
            historical_reason_counts.update(reasons)
        key = full_ticket_key(reds, blue)
        historical_full_duplicates += int(key in seen)
        seen.add(key)
        if index:
            blue_repeats += int(blue == int(draws[index - 1]["b1"]))

    total_full_combinations = total_combinations * 16
    return {
        "exact_red_combination_space": total_combinations,
        "exact_red_excluded": exact_excluded,
        "exact_red_excluded_rate": exact_excluded / total_combinations,
        "exact_reason_counts": dict(exact_reason_counts),
        "historical_draws": len(draws),
        "historical_red_excluded": historical_excluded,
        "historical_red_excluded_rate": historical_excluded / len(draws),
        "historical_reason_counts": dict(historical_reason_counts),
        "full_combination_space": total_full_combinations,
        "historical_full_duplicates": historical_full_duplicates,
        "next_draw_matches_any_historical_full_ticket_probability":
            len(seen) / total_full_combinations,
        "blue_repeat_count": blue_repeats,
        "blue_repeat_rate": blue_repeats / (len(draws) - 1),
        "blue_repeat_theoretical_rate": 1 / 16,
        "v9_expected_blue_coverage_using_historical_repeat_rate":
            (1 - blue_repeats / (len(draws) - 1)) * 5 / 15,
        "v8_theoretical_blue_coverage": 5 / 16,
    }


def _time_blocks(v8_rows: list[dict], v9_rows: list[dict], blocks: int = 8) -> list[dict]:
    n = len(v8_rows)
    result = []
    for block in range(blocks):
        begin = block * n // blocks
        end = (block + 1) * n // blocks
        summary8 = _summarize(v8_rows[begin:end])
        summary9 = _summarize(v9_rows[begin:end])
        result.append({
            "issue_from": v8_rows[begin]["issue"],
            "issue_to": v8_rows[end - 1]["issue"],
            "periods": end - begin,
            "v8": {metric: summary8[metric] for metric in RATE_METRICS},
            "v9": {metric: summary9[metric] for metric in RATE_METRICS},
        })
    return result


def run_backtest(seed_replicates: int = 32) -> dict:
    draws = ssq_db.get_all_draws("ASC")
    if len(draws) <= START_INDEX:
        raise ValueError("历史数据不足")

    print(f"生产种子全历史走期回测：{len(draws) - START_INDEX}期")
    v8_rows, v9_rows, generation = _run_pair(
        draws, production_seeds=True, collect_v9_metadata=True)
    v8_summary = _summarize(v8_rows)
    v9_summary = _summarize(v9_rows)

    paired_tests = {}
    for position, metric in enumerate(RATE_METRICS + MEAN_METRICS):
        paired_tests[metric] = _paired_block_bootstrap(
            [float(row[metric]) for row in v9_rows],
            [float(row[metric]) for row in v8_rows],
            seed=2026071400 + position,
        )
        if metric in RATE_METRICS:
            paired_tests[metric]["mcnemar"] = _mcnemar_exact(
                [int(row[metric]) for row in v9_rows],
                [int(row[metric]) for row in v8_rows],
            )

    print(f"共同种子稳健性回测：{seed_replicates}轮")
    seed_summaries = []
    for replicate in range(seed_replicates):
        rows8, rows9, _ = _run_pair(
            draws, replicate=replicate, production_seeds=False)
        summary8 = _summarize(rows8)
        summary9 = _summarize(rows9)
        seed_summaries.append({
            "replicate": replicate,
            "v8": summary8,
            "v9": summary9,
            "difference": {
                metric: summary9[metric] - summary8[metric]
                for metric in RATE_METRICS + MEAN_METRICS
            },
        })
        if (replicate + 1) % 8 == 0:
            print(f"  已完成 {replicate + 1}/{seed_replicates}")

    robustness = {
        metric: _seed_distribution([
            item["difference"][metric] for item in seed_summaries])
        for metric in RATE_METRICS + MEAN_METRICS
    }
    structural = _structural_rule_statistics(draws)
    exact = {
        "single_ticket_jackpot_probability": 1 / (math.comb(33, 6) * 16),
        "five_distinct_ticket_jackpot_probability": 5 / (math.comb(33, 6) * 16),
        "five_distinct_ticket_jackpot_odds_one_in": math.comb(33, 6) * 16 / 5,
        "v8_and_v9_equal_under_fair_draw": True,
        "reason": (
            "任一固定合法票组均为5张不同彩票；两者都保持红球零重叠和5个不同蓝球，"
            "公平独立开奖下可通过号码标签置换互相映射，因此精确理论命中指标相同。"
        ),
    }
    current_tickets, current_metadata = build_v9_filtered(
        v9_rng(str(int(draws[-1]["issue"]) + 1)), draws,
        return_metadata=True)

    primary_improvements = {
        metric: v9_summary[metric] - v8_summary[metric]
        for metric in RATE_METRICS + MEAN_METRICS
    }
    stable_metrics = {
        metric: (
            robustness[metric]["p10"] > 0
            and paired_tests[metric]["ci95"][0] > 0
        )
        for metric in ("any_prize", "blue_covered", "red_ge3", "fixed_return")
    }
    promoted = any(stable_metrics.values()) and not (
        stable_metrics["any_prize"] is False
        and stable_metrics["fixed_return"] is False)

    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "algorithm": ALGORITHM_NAME,
        "method": {
            "walk_forward": True,
            "no_future_data": True,
            "start_index": START_INDEX,
            "periods": len(v8_rows),
            "issue_from": v8_rows[0]["issue"],
            "issue_to": v8_rows[-1]["issue"],
            "ticket_count": TICKET_COUNT,
            "seed_replicates": seed_replicates,
            "production_seed_comparison": True,
            "common_seed_robustness_comparison": True,
        },
        "filter_priority": list(FILTER_PRIORITY),
        "filter_config": DEFAULT_FILTER_CONFIG.__dict__,
        "structural_statistics": structural,
        "production_seed_results": {
            "v8": v8_summary,
            "v9": v9_summary,
            "difference_v9_minus_v8": primary_improvements,
            "paired_tests": paired_tests,
            "time_blocks": _time_blocks(v8_rows, v9_rows),
            "v9_generation": generation,
        },
        "seed_robustness": robustness,
        "seed_replicate_results": seed_summaries,
        "fair_draw_exact": exact,
        "current_v9_candidate": {
            "target_issue": str(int(draws[-1]["issue"]) + 1),
            "tickets": current_tickets,
            "metadata": current_metadata,
        },
        "decision": {
            "stable_improvement_metrics": stable_metrics,
            "promote_v9_to_production": promoted,
            "production_algorithm_after_test": "ssq-v9" if promoted else "ssq-v8",
            "reason": (
                "v9在独立走期与多种子比较中出现稳定提升，可以进入生产前瞻验证。"
                if promoted else
                "v9没有在独立走期和多种子稳健性上证明稳定提升；过滤事件本身不改变"
                "固定五注的理论赔率，因此继续保留v8为生产算法，v9作为实验候选。"
            ),
        },
    }


def _pct(value: float) -> str:
    return f"{value * 100:.3f}%"


def render_markdown(report: dict) -> str:
    method = report["method"]
    stats = report["structural_statistics"]
    result = report["production_seed_results"]
    v8 = result["v8"]
    v9 = result["v9"]
    diff = result["difference_v9_minus_v8"]
    lines = [
        "# 双色球 v9 小概率过滤算法全历史回测",
        "",
        f"生成时间：{report['generated_at']}",
        f"走期区间：{method['issue_from']} ～ {method['issue_to']}，"
        f"共 {method['periods']} 期；每期固定5注、仅使用此前数据。",
        f"另执行 {method['seed_replicates']} 轮共同随机种子比较。",
        "",
        "## v9 固定过滤优先级",
        "",
        "1. 排除历史中已开奖的完整6红+1蓝组合。",
        "2. 排除与上一期相同的蓝球。",
        "3. 排除四连红及以上。",
        "4. 排除全奇/全偶、六球同一区。",
        "5. 排除和值53～151之外及跨度小于12的组合数学尾部。",
        "",
        "v9仍保持30个不同红球、5个不同蓝球、任意两注红蓝均不重叠。",
        "",
        "## 规则真实占比",
        "",
        f"- 组合数学精确排除红球：{stats['exact_red_excluded']}/"
        f"{stats['exact_red_combination_space']} = {_pct(stats['exact_red_excluded_rate'])}。",
        f"- 历史实际落入排除区：{stats['historical_red_excluded']}/"
        f"{stats['historical_draws']} = {_pct(stats['historical_red_excluded_rate'])}。",
        f"- 历史完整7球重复：{stats['historical_full_duplicates']}次；下一期重复历史任一完整组合"
        f"理论概率 {_pct(stats['next_draw_matches_any_historical_full_ticket_probability'])}。",
        f"- 历史蓝球与上期相同：{stats['blue_repeat_count']}/"
        f"{stats['historical_draws'] - 1} = {_pct(stats['blue_repeat_rate'])}，"
        "理论值6.250%。",
        f"- 按历史重复率推算，排除上期蓝球后的5蓝覆盖期望 "
        f"{_pct(stats['v9_expected_blue_coverage_using_historical_repeat_rate'])}，"
        f"v8理论覆盖 {_pct(stats['v8_theoretical_blue_coverage'])}。",
        "",
        "## 生产确定性种子全历史结果",
        "",
        "| 指标 | v8 | v9 | v9-v8 |",
        "|---|---:|---:|---:|",
    ]
    labels = {
        "blue_covered": "5注蓝球覆盖",
        "red_ge4": "任一注≥4红",
        "red_ge3": "任一注≥3红",
        "full_red": "任一注6红全中",
        "any_prize": "任一注中奖",
        "blue_sixth_prize": "出现蓝球型六等奖",
    }
    for metric in RATE_METRICS:
        lines.append(
            f"| {labels[metric]} | {_pct(v8[metric])} | {_pct(v9[metric])} | "
            f"{diff[metric] * 100:+.3f}个百分点 |")
    lines.extend([
        f"| 平均最高红球 | {v8['max_red']:.4f} | {v9['max_red']:.4f} | "
        f"{diff['max_red']:+.4f} |",
        f"| 固定奖金回报率* | {_pct(v8['fixed_prize_roi'])} | "
        f"{_pct(v9['fixed_prize_roi'])} | "
        f"{(v9['fixed_prize_roi'] - v8['fixed_prize_roi']) * 100:+.3f}个百分点 |",
        "",
        "*固定奖金按三等奖3000、四等奖200、五等奖10、六等奖5计算；"
        "一、二等奖浮动奖金单独计数。",
        "",
        f"v8投入 {v8['ticket_cost']} 元，固定奖金 {v8['fixed_prize_return']} 元，"
        f"净额 {v8['fixed_prize_net']} 元。",
        f"v9投入 {v9['ticket_cost']} 元，固定奖金 {v9['fixed_prize_return']} 元，"
        f"净额 {v9['fixed_prize_net']} 元。",
        "",
        "## 多随机种子稳健性（v9-v8）",
        "",
        "| 指标 | 最小 | P10 | 中位数 | P90 | 最大 | 均值 |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ])
    for metric in ("blue_covered", "red_ge4", "red_ge3", "any_prize", "fixed_return"):
        robust = report["seed_robustness"][metric]
        scale = 100 if metric in RATE_METRICS else 1
        lines.append(
            f"| {labels.get(metric, metric)} | {robust['min'] * scale:+.3f} | "
            f"{robust['p10'] * scale:+.3f} | {robust['median'] * scale:+.3f} | "
            f"{robust['p90'] * scale:+.3f} | {robust['max'] * scale:+.3f} | "
            f"{robust['mean'] * scale:+.3f} |")

    lines.extend([
        "",
        "## 时间块稳定性",
        "",
        "| 期号范围 | v8中奖率 | v9中奖率 | v8蓝球覆盖 | v9蓝球覆盖 |",
        "|---|---:|---:|---:|---:|",
    ])
    for block in result["time_blocks"]:
        lines.append(
            f"| {block['issue_from']}～{block['issue_to']} | "
            f"{_pct(block['v8']['any_prize'])} | {_pct(block['v9']['any_prize'])} | "
            f"{_pct(block['v8']['blue_covered'])} | {_pct(block['v9']['blue_covered'])} |")

    lines.extend([
        "",
        "## 理论与升级决定",
        "",
        report["fair_draw_exact"]["reason"],
        f"两者5注一等奖概率均为 {_pct(report['fair_draw_exact']['five_distinct_ticket_jackpot_probability'])}，"
        f"约1/{report['fair_draw_exact']['five_distinct_ticket_jackpot_odds_one_in']:.1f}。",
        "",
        f"**决定：{report['decision']['reason']}**",
        "",
    ])
    return "\n".join(lines)


def write_reports(report: dict, output_dir: Path = DATA_ROOT) -> tuple[Path, Path]:
    json_path = output_dir / "v9_backtest_results.json"
    markdown_path = output_dir / "v9_backtest_report.md"
    json_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    return json_path, markdown_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed-replicates", type=int, default=32)
    parser.add_argument("--output-dir", type=Path, default=DATA_ROOT)
    args = parser.parse_args(argv)
    if args.seed_replicates <= 0:
        parser.error("seed-replicates必须大于0")
    report = run_backtest(args.seed_replicates)
    json_path, markdown_path = write_reports(report, args.output_dir)
    print(f"JSON: {json_path}")
    print(f"报告: {markdown_path}")
    print(report["decision"]["reason"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
