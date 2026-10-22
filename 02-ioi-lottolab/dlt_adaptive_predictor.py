"""大乐透 V7：复用双色球零重叠覆盖，并用多窗口走期决定是否晋升。"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field
from itertools import combinations, permutations
from typing import Iterable

from dlt_prediction_audit import prize_level
from fused_predictor import (
    blue_pair_weights,
    build_enhanced_portfolio,
    historical_frequency,
    red_blue_cooccurrence,
    select_low_overlap_pairs,
    soft_blend,
)
from production_seeds import dlt_v4_rng
from ticket_ranking import RANKING_METHOD, rank_tickets
from v8_predictor import build_v8_balanced, v8_rng


ALGORITHM_NAME = "dlt-v7-transfer-coverage"
ALGORITHM_LABEL = "v7 · 双色球策略迁移自学习"
MIN_EMPIRICAL_HISTORY = 100
PRIMES = {2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31}

DEFAULT_CONFIG = {
    "strategy": "ssq_transfer_coverage",
    "portfolio_mode": "coverage",
    "blue_mode": "coverage",
    "ticket_count": 5,
    "train_window": 100,
    "alpha": 0.1,
    "candidate_count": 500,
    "candidate_replicates": 12,
    # 固定命名空间属于算法版本的一部分；改变它会替换整批走期候选。
    "seed_namespace": "dlt-transfer",
    "soft_penalty_weight": 0.0,
    "rare_rate": 0.005,
    "tail_rate": 0.005,
    # 大乐透历史前区组合有真实重复，回测也显示强行排除会损伤前区命中；
    # 因此只排完整组合和历史零出现极端结构，前区历史组合保留。
    "exclude_seen_red": False,
    "exclude_seen_full": True,
    "ranking_window": 100,
    "frequency_weight": 0.1,
}


def draw_reds(draw: dict) -> tuple[int, ...]:
    return tuple(int(draw[f"r{index}"]) for index in range(1, 6))


def draw_blues(draw: dict) -> tuple[int, ...]:
    return tuple(sorted((int(draw["b1"]), int(draw["b2"]))))


def ticket_key(reds: Iterable[int], blues: Iterable[int]) -> tuple[int, ...]:
    return tuple(sorted(int(number) for number in reds)) + tuple(
        sorted(int(number) for number in blues)
    )


def max_consecutive_run(values: Iterable[int]) -> int:
    ordered = sorted(int(number) for number in values)
    best = current = 1
    for left, right in zip(ordered, ordered[1:]):
        current = current + 1 if right == left + 1 else 1
        best = max(best, current)
    return best


def ac_value(reds: Iterable[int]) -> int:
    ordered = sorted(int(number) for number in reds)
    return len({right - left for left, right in combinations(ordered, 2)}) - 4


def red_shape(reds: Iterable[int]) -> dict[str, int]:
    reds = tuple(sorted(int(number) for number in reds))
    zones = (
        sum(number <= 12 for number in reds),
        sum(13 <= number <= 24 for number in reds),
        sum(number >= 25 for number in reds),
    )
    mods = tuple(sum(number % 3 == value for number in reds) for value in range(3))
    tails = Counter(number % 10 for number in reds)
    return {
        "sum": sum(reds),
        "span": max(reds) - min(reds),
        "ac": ac_value(reds),
        "odd": sum(number % 2 for number in reds),
        "big": sum(number >= 18 for number in reds),
        "prime": sum(number in PRIMES for number in reds),
        "zone_max": max(zones),
        "mod_max": max(mods),
        "run": max_consecutive_run(reds),
        "tail_max": max(tails.values()),
    }


def blue_shape(blues: Iterable[int]) -> dict[str, int]:
    blues = tuple(sorted(int(number) for number in blues))
    return {
        "sum": sum(blues),
        "span": blues[-1] - blues[0],
        "odd": sum(number % 2 for number in blues),
        "consecutive": int(blues[-1] == blues[0] + 1),
    }


def quantile(values: list[int], rate: float) -> int:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int((len(ordered) - 1) * rate)))
    return ordered[index]


@dataclass
class EmpiricalProfile:
    draws: int = 0
    transitions: int = 0
    red_counters: dict[str, Counter] = field(default_factory=lambda: {
        name: Counter() for name in (
            "ac", "odd", "big", "prime", "zone_max", "mod_max", "run", "tail_max"
        )
    })
    blue_counters: dict[str, Counter] = field(default_factory=lambda: {
        name: Counter() for name in ("sum", "span", "odd", "consecutive")
    })
    repeat_red: Counter = field(default_factory=Counter)
    repeat_blue: Counter = field(default_factory=Counter)
    sums: list[int] = field(default_factory=list)
    spans: list[int] = field(default_factory=list)
    previous_reds: tuple[int, ...] | None = None
    previous_blues: tuple[int, ...] | None = None

    @classmethod
    def from_draws(cls, draws: list[dict]) -> "EmpiricalProfile":
        profile = cls()
        for draw in draws:
            profile.update(draw)
        return profile

    def update(self, draw: dict) -> None:
        reds, blues = draw_reds(draw), draw_blues(draw)
        red, blue = red_shape(reds), blue_shape(blues)
        self.draws += 1
        self.sums.append(red["sum"])
        self.spans.append(red["span"])
        for name, counter in self.red_counters.items():
            counter[red[name]] += 1
        for name, counter in self.blue_counters.items():
            counter[blue[name]] += 1
        if self.previous_reds is not None and self.previous_blues is not None:
            self.repeat_red[len(set(reds) & set(self.previous_reds))] += 1
            self.repeat_blue[len(set(blues) & set(self.previous_blues))] += 1
            self.transitions += 1
        self.previous_reds, self.previous_blues = reds, blues

    def tail_bounds(self, tail_rate: float) -> tuple[int, int, int, int]:
        return (
            quantile(self.sums, tail_rate),
            quantile(self.sums, 1 - tail_rate),
            quantile(self.spans, tail_rate),
            quantile(self.spans, 1 - tail_rate),
        )

    def soft_reasons(
        self,
        reds: Iterable[int],
        blues: Iterable[int],
        *,
        rare_rate: float,
        tail_bounds: tuple[int, int, int, int],
    ) -> list[str]:
        if self.draws < MIN_EMPIRICAL_HISTORY:
            return []
        red, blue = red_shape(reds), blue_shape(blues)
        reasons: list[str] = []
        for name, label in (
            ("ac", "极端AC"), ("odd", "极端奇偶"),
            ("big", "极端大小"), ("prime", "极端质合"),
        ):
            if self.red_counters[name][red[name]] / self.draws < rare_rate:
                reasons.append(label)
        for name, label in (
            ("zone_max", "单区集中"), ("mod_max", "单路集中"),
            ("tail_max", "同尾集中"), ("run", "低频连号"),
        ):
            value = red[name]
            if value >= 4:
                rate = sum(
                    count for level, count in self.red_counters[name].items()
                    if level >= value
                ) / self.draws
                if rate < rare_rate:
                    reasons.append(label)
        if self.previous_reds is not None and self.transitions:
            repeat = len(set(reds) & set(self.previous_reds))
            if repeat >= 3:
                rate = sum(
                    count for value, count in self.repeat_red.items() if value >= repeat
                ) / self.transitions
                if rate < rare_rate:
                    reasons.append("上期前区重号过多")
        if self.previous_blues is not None and self.transitions:
            repeat = len(set(blues) & set(self.previous_blues))
            if repeat >= 2:
                rate = sum(
                    count for value, count in self.repeat_blue.items() if value >= repeat
                ) / self.transitions
                if rate < rare_rate:
                    reasons.append("上期后区全重")
        sum_low, sum_high, span_low, span_high = tail_bounds
        if red["sum"] < sum_low or red["sum"] > sum_high:
            reasons.append("和值尾部")
        if red["span"] < span_low or red["span"] > span_high:
            reasons.append("跨度尾部")
        # 后区所有和值和跨度均在历史出现，只对极少的精确类别降权。
        for name, label in (("sum", "后区和值低频"), ("span", "后区跨度低频")):
            if self.blue_counters[name][blue[name]] / self.draws < rare_rate:
                reasons.append(label)
        return reasons

    def summary(self, *, rare_rate: float, tail_rate: float) -> dict:
        bounds = self.tail_bounds(tail_rate)
        return {
            "history_draws": self.draws,
            "rare_rate": rare_rate,
            "tail_rate": tail_rate,
            "learned_sum_range": list(bounds[:2]),
            "learned_span_range": list(bounds[2:]),
            "previous_reds": list(self.previous_reds or ()),
            "previous_blues": list(self.previous_blues or ()),
        }


def hard_reasons(
    reds: Iterable[int],
    blues: Iterable[int],
    *,
    seen_reds: set[tuple[int, ...]],
    seen_full: set[tuple[int, ...]],
    exclude_seen_red: bool,
    exclude_seen_full: bool,
) -> list[str]:
    reds = tuple(sorted(int(number) for number in reds))
    blues = tuple(sorted(int(number) for number in blues))
    shape = red_shape(reds)
    reasons: list[str] = []
    if exclude_seen_full and ticket_key(reds, blues) in seen_full:
        reasons.append("历史完整组合")
    if exclude_seen_red and reds in seen_reds:
        reasons.append("历史前区组合")
    if shape["sum"] <= 26 or shape["sum"] >= 164:
        reasons.append("和值历史零区间")
    if shape["span"] <= 4:
        reasons.append("跨度历史零区间")
    if shape["ac"] <= 0 or shape["ac"] >= 7:
        reasons.append("AC历史零区间")
    if shape["run"] >= 5:
        reasons.append("五连号")
    if shape["tail_max"] >= 5:
        reasons.append("五个同尾")
    return reasons


def normalize_config(config: dict | None = None) -> dict:
    result = dict(DEFAULT_CONFIG)
    if config:
        for key in result:
            if key in config:
                result[key] = config[key]
    result["train_window"] = max(50, min(500, int(result["train_window"])))
    result["candidate_count"] = max(200, min(3000, int(result["candidate_count"])))
    result["candidate_replicates"] = max(
        1, min(64, int(result["candidate_replicates"]))
    )
    result["alpha"] = max(0.0, min(0.5, float(result["alpha"])))
    result["soft_penalty_weight"] = max(0.0, float(result["soft_penalty_weight"]))
    result["rare_rate"] = max(0.001, min(0.10, float(result["rare_rate"])))
    result["tail_rate"] = max(0.001, min(0.10, float(result["tail_rate"])))
    if result["blue_mode"] not in {"joint", "coverage"}:
        result["blue_mode"] = "joint"
    if result["portfolio_mode"] not in {"coverage", "adaptive", "baseline"}:
        result["portfolio_mode"] = "coverage"
    result["exclude_seen_red"] = bool(result["exclude_seen_red"])
    result["exclude_seen_full"] = bool(result["exclude_seen_full"])
    return result


def _priority_indices(values: list[float]) -> list[float]:
    mean = sum(values) / len(values)
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    deviation = math.sqrt(variance)
    return [
        round(100 / (1 + math.exp(-max(-8.0, min(8.0, (value - mean) / deviation)))), 1)
        if deviation > 1e-12 else 50.0
        for value in values
    ]


def _repair_blue_assignment(
    tickets: list[tuple[list[int], list[int]]],
    history: list[dict],
    seen_full: set[tuple[int, ...]],
    exclude_seen_full: bool,
) -> list[tuple[list[int], list[int]]]:
    reds = [list(ticket[0]) for ticket in tickets]
    blue_pairs = [list(ticket[1]) for ticket in tickets]
    cooccurrence = red_blue_cooccurrence(history, 5, 2)
    best = None
    for order in set(permutations(range(len(blue_pairs)))):
        paired = [(reds[index], blue_pairs[order[index]]) for index in range(len(reds))]
        if exclude_seen_full and any(
            ticket_key(red, blue) in seen_full for red, blue in paired
        ):
            continue
        score = sum(
            cooccurrence.get((red, blue), 0)
            for red_numbers, blue_numbers in paired
            for red in red_numbers
            for blue in blue_numbers
        )
        candidate = (score, tuple(-value for value in order), paired)
        if best is None or candidate[:2] > best[:2]:
            best = candidate
    if best is None:
        raise RuntimeError("无法为大乐透候选分配未重复的后区组合")
    return best[2]


def portfolio_diagnostics(tickets: list[tuple[list[int], list[int]]]) -> dict:
    red_sets = [set(reds) for reds, _ in tickets]
    blue_sets = [set(blues) for _, blues in tickets]
    return {
        "red_coverage": len(set().union(*red_sets)),
        "blue_coverage": len(set().union(*blue_sets)),
        "max_red_overlap": max(
            len(red_sets[left] & red_sets[right])
            for left in range(len(tickets)) for right in range(left + 1, len(tickets))
        ),
        "max_blue_overlap": max(
            len(blue_sets[left] & blue_sets[right])
            for left in range(len(tickets)) for right in range(left + 1, len(tickets))
        ),
    }


def _build_transfer_coverage_portfolio(
    issue: str,
    history: list[dict],
    config: dict,
    profile: EmpiricalProfile,
    bounds: tuple[int, int, int, int],
    seen_reds: set[tuple[int, ...]],
    seen_full: set[tuple[int, ...]],
    rejection_counts: Counter,
) -> tuple[list[tuple[list[int], list[int]]], dict]:
    """选择五注前后区都零重叠的大乐透组合。

    这复用双色球覆盖版的核心几何：五注覆盖25个不同前区号码和10个
    不同后区号码。每个候选组合只使用目标期之前的历史打分，目标期
    开奖不会参与候选生成或选择。
    """
    requested = int(config["candidate_replicates"])
    portfolios: list[list[tuple[list[int], list[int]]]] = []
    for replicate in range(max(16, requested) * 8):
        portfolio = build_v8_balanced(
            v8_rng(str(config["seed_namespace"]), str(issue), replicate),
            [],
            35,
            5,
            12,
            2,
            5,
        )
        blocked = [
            reason
            for reds, blues in portfolio
            for reason in hard_reasons(
                reds,
                blues,
                seen_reds=seen_reds,
                seen_full=seen_full,
                exclude_seen_red=bool(config["exclude_seen_red"]),
                exclude_seen_full=bool(config["exclude_seen_full"]),
            )
        ]
        if blocked:
            rejection_counts.update(blocked)
            continue
        portfolios.append(portfolio)
        if len(portfolios) >= requested:
            break
    if not portfolios:
        raise RuntimeError("没有生成满足硬过滤条件的大乐透零重叠组合")

    flattened = [ticket for portfolio in portfolios for ticket in portfolio]
    ranking = rank_tickets(
        flattened,
        history,
        "dlt",
        window=int(config["ranking_window"]),
        frequency_weight=float(config["frequency_weight"]),
    )
    raw_scores = {
        int(item["index"]): float(item["raw_score"]) for item in ranking
    }
    evaluated = []
    offset = 0
    for portfolio_index, portfolio in enumerate(portfolios):
        adjusted_scores = []
        for local_index, (reds, blues) in enumerate(portfolio):
            reasons = profile.soft_reasons(
                reds,
                blues,
                rare_rate=float(config["rare_rate"]),
                tail_bounds=bounds,
            )
            adjusted_scores.append(
                raw_scores[offset + local_index]
                - float(config["soft_penalty_weight"]) * len(reasons)
            )
        offset += len(portfolio)
        # 同时照顾平均质量和最弱一注，避免只靠一张高分票抬高组合。
        portfolio_score = (
            sum(adjusted_scores) / len(adjusted_scores)
            + 0.10 * min(adjusted_scores)
        )
        evaluated.append(
            (portfolio_score, -portfolio_index, portfolio_index, portfolio)
        )

    portfolio_score, _, selected_index, tickets = max(evaluated)
    return tickets, {
        "candidate_portfolios_requested": requested,
        "candidate_portfolios_evaluated": len(portfolios),
        "candidate_tickets_evaluated": len(flattened),
        "selected_candidate": selected_index,
        "portfolio_score": round(portfolio_score, 6),
    }


def build_adaptive_portfolio(
    issue: str,
    history: list[dict],
    config: dict | None = None,
    *,
    red_scores: dict[int, float] | None = None,
    blue_scores: dict[int, float] | None = None,
) -> tuple[list[tuple[list[int], list[int]]], dict]:
    if len(history) < MIN_EMPIRICAL_HISTORY:
        raise ValueError(f"历史数据不足：{len(history)}期")
    config = normalize_config(config)
    profile = EmpiricalProfile.from_draws(history)
    bounds = profile.tail_bounds(float(config["tail_rate"]))
    seen_reds = {draw_reds(draw) for draw in history}
    seen_full = {ticket_key(draw_reds(draw), draw_blues(draw)) for draw in history}
    rejection_counts: Counter = Counter()

    def adjust(reds: list[int], blues: list[int]) -> float | None:
        blocked = hard_reasons(
            reds, blues, seen_reds=seen_reds, seen_full=seen_full,
            exclude_seen_red=config["exclude_seen_red"],
            exclude_seen_full=config["exclude_seen_full"],
        )
        if blocked:
            rejection_counts.update(blocked)
            return None
        reasons = profile.soft_reasons(
            reds, blues, rare_rate=float(config["rare_rate"]), tail_bounds=bounds
        )
        return -float(config["soft_penalty_weight"]) * len(reasons)

    mode = str(config["portfolio_mode"])
    training = history[-int(config["train_window"]):]
    coverage_metadata: dict = {}
    if mode == "coverage":
        tickets, coverage_metadata = _build_transfer_coverage_portfolio(
            issue,
            history,
            config,
            profile,
            bounds,
            seen_reds,
            seen_full,
            rejection_counts,
        )
    else:
        tickets = build_enhanced_portfolio(
            dlt_v4_rng(str(history[-1]["issue"]), len(history)),
            training, 35, 5, 12, 2, 5,
            red_scores, blue_scores,
            alpha=float(config["alpha"]),
            candidate_count=int(config["candidate_count"]),
            candidate_adjuster=(adjust if mode == "adaptive" else None),
        )
    if mode == "adaptive" and config["blue_mode"] == "coverage":
        # 旧V5对照：最大化后区号码覆盖。
        blue_history = historical_frequency(training, "b", 2, 12)
        blue_probabilities = soft_blend(
            blue_scores, blue_history, 12, float(config["alpha"])
        )
        pair_weights = blue_pair_weights(
            training, blue_probabilities, 12, float(config["alpha"])
        )
        blue_pairs = select_low_overlap_pairs(
            dlt_v4_rng(str(history[-1]["issue"]), len(history)),
            pair_weights,
            5,
        )
        tickets = [
            (list(reds), list(blue_pairs[index]))
            for index, (reds, _) in enumerate(tickets)
        ]
    # joint 模式保留候选阶段选出的红蓝联合关系，再只做排列修复。
    if mode == "adaptive":
        tickets = _repair_blue_assignment(
            tickets, history, seen_full, bool(config["exclude_seen_full"])
        )
    final_blocked = [
        reason for reds, blues in tickets
        for reason in hard_reasons(
            reds, blues, seen_reds=seen_reds, seen_full=seen_full,
            exclude_seen_red=config["exclude_seen_red"],
            exclude_seen_full=config["exclude_seen_full"],
        )
    ]
    if final_blocked and mode in {"coverage", "adaptive"}:
        raise RuntimeError(f"大乐透最终组合未通过硬过滤：{final_blocked}")

    ranking = rank_tickets(
        tickets, history, "dlt",
        window=int(config["ranking_window"]),
        frequency_weight=float(config["frequency_weight"]),
    )
    ticket_rows = []
    for item in ranking:
        reds, blues = tickets[item["index"]]
        reasons = profile.soft_reasons(
            reds, blues, rare_rate=float(config["rare_rate"]), tail_bounds=bounds
        )
        adjusted = float(item["raw_score"]) - float(config["soft_penalty_weight"]) * len(reasons)
        ticket_rows.append({
            "index": item["index"], "raw_score": float(item["raw_score"]),
            "adjusted_score": adjusted, "soft_reasons": reasons,
        })
    ticket_rows.sort(key=lambda row: (-row["adjusted_score"], row["index"]))
    tickets = [tickets[row["index"]] for row in ticket_rows]
    priority = _priority_indices([row["adjusted_score"] for row in ticket_rows])
    for rank, (row, value) in enumerate(zip(ticket_rows, priority), 1):
        row["rank"], row["priority_index"] = rank, value

    metadata = {
        "algorithm": ALGORITHM_NAME,
        "strategy": config["strategy"],
        "portfolio_mode": mode,
        "blue_mode": config["blue_mode"],
        "config": config,
        **coverage_metadata,
        "portfolio": portfolio_diagnostics(tickets),
        "hard_filter_rejections": dict(rejection_counts),
        "historical_full_duplicates": sum(
            ticket_key(reds, blues) in seen_full for reds, blues in tickets
        ),
        "historical_red_duplicates": sum(tuple(reds) in seen_reds for reds, _ in tickets),
        "learning_profile": profile.summary(
            rare_rate=float(config["rare_rate"]), tail_rate=float(config["tail_rate"])
        ),
        "ticket_scores": ticket_rows,
        "ranking": {
            "method": (
                f"{RANKING_METHOD}+ssq-transfer-coverage-dlt-v7"
                if mode == "coverage"
                else f"{RANKING_METHOD}+joint-jackpot-dlt-v7"
            ),
            "priority_indices": priority,
            "index_is_probability": False,
            "order_frozen": True,
            "trained_through": str(history[-1]["issue"]),
        },
    }
    return tickets, metadata


def evaluate_config(
    draws: list[dict], config: dict, periods: int, *, adaptive: bool
) -> dict:
    config = normalize_config(config)
    start = max(MIN_EMPIRICAL_HISTORY, len(draws) - max(1, int(periods)))
    results = []
    prizes: Counter = Counter()
    for index in range(start, len(draws)):
        history, actual = draws[:index], draws[index]
        if adaptive:
            tickets, _ = build_adaptive_portfolio(str(actual["issue"]), history, config)
        else:
            training = history[-int(config["train_window"]):]
            tickets = build_enhanced_portfolio(
                dlt_v4_rng(str(history[-1]["issue"]), len(history)),
                training, 35, 5, 12, 2, 5,
                alpha=float(config["alpha"]),
                candidate_count=int(config["candidate_count"]),
            )
        actual_reds, actual_blues = set(draw_reds(actual)), set(draw_blues(actual))
        details = []
        for reds, blues in tickets:
            red_hits = len(set(reds) & actual_reds)
            blue_hits = len(set(blues) & actual_blues)
            award = prize_level(red_hits, blue_hits)
            if award:
                prizes[award] += 1
            details.append((red_hits, blue_hits, award))
        max_red = max(row[0] for row in details)
        best_red_blue = max(
            row[1] for row in details if row[0] == max_red
        )
        results.append({
            "max_red": max_red,
            "blue_covered": any(row[1] > 0 for row in details),
            "blue_aligned": best_red_blue > 0,
            "four_red": any(row[0] >= 4 for row in details),
            "three_red_two_blue": any(row[0] >= 3 and row[1] == 2 for row in details),
            "big_prize": any(row[0] == 5 or (row[0] == 4 and row[1] == 2) for row in details),
            "winning": any(row[2] for row in details),
            "joint_power": max(
                (row[0] ** 4) * ((1 + row[1]) ** 2) for row in details
            ),
        })
    total = len(results)
    return {
        "total": total,
        "p_ge4": sum(row["max_red"] >= 4 for row in results) / total,
        "p_ge3": sum(row["max_red"] >= 3 for row in results) / total,
        "p_5red": sum(row["max_red"] >= 5 for row in results) / total,
        "p_3r_2b": sum(row["three_red_two_blue"] for row in results) / total,
        "p_4red": sum(row["four_red"] for row in results) / total,
        "p_big_prize": sum(row["big_prize"] for row in results) / total,
        "blue_rate": sum(row["blue_covered"] for row in results) / total,
        "blue_aligned_rate": sum(row["blue_aligned"] for row in results) / total,
        "avg_joint_power": sum(row["joint_power"] for row in results) / total,
        "winning_rate": sum(row["winning"] for row in results) / total,
        "avg_max_red": sum(row["max_red"] for row in results) / total,
        "ge4_count": sum(row["max_red"] >= 4 for row in results),
        "ge3_count": sum(row["max_red"] >= 3 for row in results),
        "p5_count": sum(row["max_red"] >= 5 for row in results),
        "big_prize_count": sum(row["big_prize"] for row in results),
        "prize_counts": dict(prizes),
    }
