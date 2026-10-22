"""双色球 V15：在 V8 零重叠覆盖之上的实证过滤与多窗口稳定性闸门。

所有候选和参数评估只读取目标期之前的开奖。硬过滤只处理历史完整重复、
历史红球组合重复和历史从未出现的极端结构；低频结构仅降权，不伪装成
开奖号码的客观概率。
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field
from itertools import combinations
from typing import Iterable

from ticket_ranking import RANKING_METHOD, rank_tickets
from v8_predictor import build_v8_balanced, portfolio_diagnostics, v8_rng


ALGORITHM_NAME = "ssq-v15-stability-gated"
ALGORITHM_LABEL = "v15 · 多窗口实证自学习"
MIN_EMPIRICAL_HISTORY = 100
PRIMES = {2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31}

DEFAULT_CONFIG = {
    "strategy": "stable_coverage_adaptive",
    "portfolio_mode": "coverage",
    "ticket_count": 5,
    "candidate_replicates": 12,
    "soft_penalty_weight": 0.50,
    "rare_rate": 0.005,
    "tail_rate": 0.005,
    "ranking_window": 100,
    "frequency_weight": 0.10,
    "exclude_seen_red": True,
    "exclude_seen_full": True,
    "coverage_bonus": 0.0,
    "red_coverage": 30,
    "blue_coverage": 5,
    "max_red_overlap": 0,
    "max_blue_overlap": 0,
    "seed_namespace": "v8-validation",
}


def draw_reds(draw: dict) -> tuple[int, ...]:
    return tuple(int(draw[f"r{index}"]) for index in range(1, 7))


def ticket_key(reds: Iterable[int], blue: int) -> tuple[int, ...]:
    return tuple(sorted(int(number) for number in reds)) + (int(blue),)


def max_consecutive_run(reds: Iterable[int]) -> int:
    ordered = sorted(int(number) for number in reds)
    best = current = 1
    for left, right in zip(ordered, ordered[1:]):
        current = current + 1 if right == left + 1 else 1
        best = max(best, current)
    return best


def ac_value(reds: Iterable[int]) -> int:
    ordered = sorted(int(number) for number in reds)
    return len({right - left for left, right in combinations(ordered, 2)}) - 5


def has_two_disjoint_triples(reds: Iterable[int]) -> bool:
    values = set(int(number) for number in reds)
    starts = [
        start for start in range(1, 32)
        if {start, start + 1, start + 2} <= values
    ]
    return any(
        {left, left + 1, left + 2}.isdisjoint(
            {right, right + 1, right + 2}
        )
        for left, right in combinations(starts, 2)
    )


def shape_values(reds: Iterable[int]) -> dict[str, int | bool]:
    reds = tuple(sorted(int(number) for number in reds))
    zones = (
        sum(number <= 11 for number in reds),
        sum(12 <= number <= 22 for number in reds),
        sum(number >= 23 for number in reds),
    )
    mods = tuple(sum(number % 3 == value for number in reds) for value in range(3))
    tails = Counter(number % 10 for number in reds)
    return {
        "sum": sum(reds),
        "span": max(reds) - min(reds),
        "ac": ac_value(reds),
        "odd": sum(number % 2 for number in reds),
        "big": sum(number >= 17 for number in reds),
        "prime": sum(number in PRIMES for number in reds),
        "zone_max": max(zones),
        "mod_max": max(mods),
        "run": max_consecutive_run(reds),
        "tail_max": max(tails.values()),
        "two_triples": has_two_disjoint_triples(reds),
    }


def quantile(values: list[int], rate: float) -> int:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("quantile values cannot be empty")
    index = max(0, min(len(ordered) - 1, int((len(ordered) - 1) * rate)))
    return ordered[index]


@dataclass
class EmpiricalProfile:
    """目标期之前的形态频率摘要。"""

    draws: int = 0
    transitions: int = 0
    max_runs: Counter = field(default_factory=Counter)
    odd_counts: Counter = field(default_factory=Counter)
    big_counts: Counter = field(default_factory=Counter)
    prime_counts: Counter = field(default_factory=Counter)
    zone_max_counts: Counter = field(default_factory=Counter)
    mod_max_counts: Counter = field(default_factory=Counter)
    tail_max_counts: Counter = field(default_factory=Counter)
    ac_counts: Counter = field(default_factory=Counter)
    repeat_counts: Counter = field(default_factory=Counter)
    sums: list[int] = field(default_factory=list)
    spans: list[int] = field(default_factory=list)
    previous_reds: tuple[int, ...] | None = None

    @classmethod
    def from_draws(cls, draws: list[dict]) -> "EmpiricalProfile":
        profile = cls()
        for draw in draws:
            profile.update(draw)
        return profile

    def update(self, draw: dict) -> None:
        reds = draw_reds(draw)
        shape = shape_values(reds)
        self.draws += 1
        self.max_runs[int(shape["run"])] += 1
        self.odd_counts[int(shape["odd"])] += 1
        self.big_counts[int(shape["big"])] += 1
        self.prime_counts[int(shape["prime"])] += 1
        self.zone_max_counts[int(shape["zone_max"])] += 1
        self.mod_max_counts[int(shape["mod_max"])] += 1
        self.tail_max_counts[int(shape["tail_max"])] += 1
        self.ac_counts[int(shape["ac"])] += 1
        self.sums.append(int(shape["sum"]))
        self.spans.append(int(shape["span"]))
        if self.previous_reds is not None:
            repeats = len(set(reds) & set(self.previous_reds))
            self.repeat_counts[repeats] += 1
            self.transitions += 1
        self.previous_reds = reds

    def soft_reasons(
        self,
        reds: Iterable[int],
        *,
        rare_rate: float,
        tail_rate: float,
        tail_bounds: tuple[int, int, int, int] | None = None,
    ) -> list[str]:
        if self.draws < MIN_EMPIRICAL_HISTORY:
            return []
        shape = shape_values(reds)
        reasons: list[str] = []

        run = int(shape["run"])
        if run >= 4:
            rate = sum(count for value, count in self.max_runs.items() if value >= run) / self.draws
            if rate < rare_rate:
                reasons.append("低频连号")

        for name, counter, value in (
            ("极端奇偶", self.odd_counts, int(shape["odd"])),
            ("极端大小", self.big_counts, int(shape["big"])),
            ("极端质合", self.prime_counts, int(shape["prime"])),
            ("极端AC", self.ac_counts, int(shape["ac"])),
        ):
            if counter[value] / self.draws < rare_rate:
                reasons.append(name)

        for name, counter, value in (
            ("单区集中", self.zone_max_counts, int(shape["zone_max"])),
            ("单路集中", self.mod_max_counts, int(shape["mod_max"])),
            ("同尾集中", self.tail_max_counts, int(shape["tail_max"])),
        ):
            if value >= 4:
                rate = sum(count for level, count in counter.items() if level >= value) / self.draws
                if rate < rare_rate:
                    reasons.append(name)

        if self.previous_reds is not None and self.transitions:
            repeats = len(set(reds) & set(self.previous_reds))
            if repeats >= 4:
                rate = sum(count for value, count in self.repeat_counts.items() if value >= repeats) / self.transitions
                if rate < rare_rate:
                    reasons.append("上期重号过多")

        if tail_bounds is None:
            tail_bounds = (
                quantile(self.sums, tail_rate),
                quantile(self.sums, 1 - tail_rate),
                quantile(self.spans, tail_rate),
                quantile(self.spans, 1 - tail_rate),
            )
        sum_low, sum_high, span_low, span_high = tail_bounds
        red_sum = int(shape["sum"])
        if red_sum < sum_low or red_sum > sum_high:
            reasons.append("和值尾部")
        span = int(shape["span"])
        if span < span_low or span > span_high:
            reasons.append("跨度尾部")
        return reasons

    def summary(self, *, rare_rate: float, tail_rate: float) -> dict:
        return {
            "history_draws": self.draws,
            "rare_rate": rare_rate,
            "tail_rate": tail_rate,
            "learned_sum_range": [
                quantile(self.sums, tail_rate), quantile(self.sums, 1 - tail_rate)
            ],
            "learned_span_range": [
                quantile(self.spans, tail_rate), quantile(self.spans, 1 - tail_rate)
            ],
            "previous_reds": list(self.previous_reds or ()),
        }


def hard_shape_reasons(
    reds: Iterable[int],
    blue: int,
    *,
    seen_reds: set[tuple[int, ...]],
    seen_full: set[tuple[int, ...]],
    exclude_seen_red: bool,
    exclude_seen_full: bool,
) -> list[str]:
    reds = tuple(sorted(int(number) for number in reds))
    shape = shape_values(reds)
    reasons: list[str] = []
    if exclude_seen_full and ticket_key(reds, blue) in seen_full:
        reasons.append("历史完整组合")
    if exclude_seen_red and reds in seen_reds:
        reasons.append("历史红球组合")
    if int(shape["sum"]) <= 28 or int(shape["sum"]) >= 173:
        reasons.append("和值历史零区间")
    if int(shape["span"]) <= 6:
        reasons.append("跨度历史零区间")
    if int(shape["ac"]) <= 1 or int(shape["ac"]) >= 11:
        reasons.append("AC历史零区间")
    if bool(shape["two_triples"]):
        reasons.append("两组独立三连号")
    if int(shape["run"]) >= 6:
        reasons.append("六连号")
    if int(shape["tail_max"]) >= 5:
        reasons.append("五个以上同尾")
    if int(shape["mod_max"]) >= 6:
        reasons.append("全同012路")
    return reasons


def normalize_config(config: dict | None = None) -> dict:
    result = dict(DEFAULT_CONFIG)
    if config:
        for key in result:
            if key in config:
                result[key] = config[key]
    result["candidate_replicates"] = max(1, min(256, int(result["candidate_replicates"])))
    result["soft_penalty_weight"] = max(0.0, float(result["soft_penalty_weight"]))
    result["rare_rate"] = max(0.001, min(0.10, float(result["rare_rate"])))
    result["tail_rate"] = max(0.001, min(0.10, float(result["tail_rate"])))
    result["ranking_window"] = max(30, min(500, int(result["ranking_window"])))
    result["frequency_weight"] = max(0.0, min(1.0, float(result["frequency_weight"])))
    result["coverage_bonus"] = max(0.0, min(1.0, float(result["coverage_bonus"])))
    result["max_red_overlap"] = max(0, min(3, int(result["max_red_overlap"])))
    if result["portfolio_mode"] not in {"coverage", "jackpot_overlap"}:
        result["portfolio_mode"] = "jackpot_overlap"
    result["exclude_seen_red"] = bool(result["exclude_seen_red"])
    result["exclude_seen_full"] = bool(result["exclude_seen_full"])
    return result


def _priority_indices(values: list[float]) -> list[float]:
    mean = sum(values) / len(values)
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    deviation = math.sqrt(variance)
    result = []
    for value in values:
        z_score = (value - mean) / deviation if deviation > 1e-12 else 0.0
        result.append(round(100 / (1 + math.exp(-max(-8.0, min(8.0, z_score)))), 1))
    return result


def build_adaptive_portfolio(
    issue: str,
    history: list[dict],
    config: dict | None = None,
) -> tuple[list[tuple[list[int], list[int]]], dict]:
    """生成五注高奖组合，并返回预测时点冻结的学习元数据。

    ``coverage`` 保留旧版30红球零重叠基线；``jackpot_overlap`` 从大量
    随机合法候选中自学习排序，允许任意两注最多重叠3个红球。该上限既
    能把模型偏好的核心号集中进多注，又不会让两注的5红高奖覆盖域重合。
    """
    if len(history) < MIN_EMPIRICAL_HISTORY:
        raise ValueError(f"历史数据不足：{len(history)}期")
    config = normalize_config(config)
    profile = EmpiricalProfile.from_draws(history)
    tail_bounds = (
        quantile(profile.sums, float(config["tail_rate"])),
        quantile(profile.sums, 1 - float(config["tail_rate"])),
        quantile(profile.spans, float(config["tail_rate"])),
        quantile(profile.spans, 1 - float(config["tail_rate"])),
    )
    seen_reds = {draw_reds(draw) for draw in history}
    seen_full = {ticket_key(draw_reds(draw), int(draw["b1"])) for draw in history}
    rejection_counts: Counter = Counter()
    requested = int(config["candidate_replicates"])
    mode = str(config["portfolio_mode"])
    candidate_count = 0

    if mode == "coverage":
        portfolios: list[list[tuple[list[int], list[int]]]] = []
        for replicate in range(max(requested, 16) * 4):
            portfolio = build_v8_balanced(
                v8_rng("ssq", str(issue), replicate), [], 33, 6, 16, 1, 5
            )
            blocked = [
                reason for reds, blues in portfolio
                for reason in hard_shape_reasons(
                    reds, blues[0], seen_reds=seen_reds, seen_full=seen_full,
                    exclude_seen_red=config["exclude_seen_red"],
                    exclude_seen_full=config["exclude_seen_full"],
                )
            ]
            if blocked:
                rejection_counts.update(blocked)
            else:
                portfolios.append(portfolio)
            if len(portfolios) >= requested:
                break
        if not portfolios:
            raise RuntimeError("没有生成满足硬过滤条件的双色球五注组合")
        flattened = [ticket for portfolio in portfolios for ticket in portfolio]
        ranked = rank_tickets(
            flattened, history, "ssq",
            window=int(config["ranking_window"]),
            frequency_weight=float(config["frequency_weight"]),
        )
        raw_scores = {item["index"]: float(item["raw_score"]) for item in ranked}
        evaluated = []
        offset = 0
        for portfolio_index, portfolio in enumerate(portfolios):
            rows = []
            for local_index, (reds, _blues) in enumerate(portfolio):
                reasons = profile.soft_reasons(
                    reds, rare_rate=float(config["rare_rate"]),
                    tail_rate=float(config["tail_rate"]), tail_bounds=tail_bounds,
                )
                raw = raw_scores[offset + local_index]
                rows.append({
                    "local_index": local_index, "raw_score": raw,
                    "adjusted_score": raw - float(config["soft_penalty_weight"]) * len(reasons),
                    "soft_reasons": reasons,
                })
            offset += len(portfolio)
            values = [row["adjusted_score"] for row in rows]
            evaluated.append((
                sum(values) / len(values) + 0.10 * min(values),
                -portfolio_index, portfolio_index, rows,
            ))
        portfolio_score, _, chosen_index, ticket_rows = max(evaluated)
        chosen = portfolios[chosen_index]
        ticket_rows.sort(key=lambda row: (-row["adjusted_score"], row["local_index"]))
        tickets = [chosen[row["local_index"]] for row in ticket_rows]
        candidate_count = len(flattened)
    else:
        # 一次性生成大量随机合法单注，再按开奖前数据排名并贪心组装。
        # 随机负责探索，自学习只负责从探索池中选择，不读取目标期开奖。
        rng = v8_rng("ssq-jackpot", str(issue))
        target_candidates = max(240, requested * 16)
        candidates: list[tuple[list[int], list[int]]] = []
        candidate_keys: set[tuple[int, ...]] = set()
        for _ in range(target_candidates * 12):
            reds = sorted(rng.sample(range(1, 34), 6))
            blue = rng.randint(1, 16)
            key = ticket_key(reds, blue)
            if key in candidate_keys:
                continue
            blocked = hard_shape_reasons(
                reds, blue, seen_reds=seen_reds, seen_full=seen_full,
                exclude_seen_red=config["exclude_seen_red"],
                exclude_seen_full=config["exclude_seen_full"],
            )
            if blocked:
                rejection_counts.update(blocked)
                continue
            candidates.append((reds, [blue]))
            candidate_keys.add(key)
            if len(candidates) >= target_candidates:
                break
        if len(candidates) < 5:
            raise RuntimeError("没有生成足够的双色球高奖候选")
        candidate_count = len(candidates)
        ranked = rank_tickets(
            candidates, history, "ssq",
            window=int(config["ranking_window"]),
            frequency_weight=float(config["frequency_weight"]),
        )
        ranked_by_index = {item["index"]: item for item in ranked}
        candidate_rows = []
        for index, (reds, blues) in enumerate(candidates):
            reasons = profile.soft_reasons(
                reds, rare_rate=float(config["rare_rate"]),
                tail_rate=float(config["tail_rate"]), tail_bounds=tail_bounds,
            )
            raw = float(ranked_by_index[index]["raw_score"])
            candidate_rows.append({
                "candidate_index": index,
                "raw_score": raw,
                "adjusted_score": raw - float(config["soft_penalty_weight"]) * len(reasons),
                "soft_reasons": reasons,
            })
        values = [row["adjusted_score"] for row in candidate_rows]
        mean = sum(values) / len(values)
        variance = sum((value - mean) ** 2 for value in values) / len(values)
        scale = max(math.sqrt(variance), 1e-9)
        selected_rows = []
        covered: set[int] = set()
        used_blues: set[int] = set()
        max_overlap = int(config["max_red_overlap"])
        while len(selected_rows) < 5:
            eligible = []
            for row in candidate_rows:
                if row in selected_rows:
                    continue
                reds, blues = candidates[row["candidate_index"]]
                red_set = set(reds)
                if blues[0] in used_blues:
                    continue
                if any(
                    len(red_set & set(candidates[chosen["candidate_index"]][0])) > max_overlap
                    for chosen in selected_rows
                ):
                    continue
                z_score = (row["adjusted_score"] - mean) / scale
                objective = (
                    z_score
                    + float(config["coverage_bonus"]) * len(red_set - covered)
                )
                eligible.append((objective, row["adjusted_score"], -row["candidate_index"], row))
            if not eligible:
                raise RuntimeError("双色球高奖候选无法满足五注重叠约束")
            _, _, _, chosen_row = max(eligible)
            selected_rows.append(chosen_row)
            reds, blues = candidates[chosen_row["candidate_index"]]
            covered.update(reds)
            used_blues.update(blues)
        selected_rows.sort(
            key=lambda row: (-row["adjusted_score"], row["candidate_index"])
        )
        tickets = [candidates[row["candidate_index"]] for row in selected_rows]
        ticket_rows = [
            {
                "local_index": index,
                "raw_score": row["raw_score"],
                "adjusted_score": row["adjusted_score"],
                "soft_reasons": row["soft_reasons"],
            }
            for index, row in enumerate(selected_rows)
        ]
        portfolio_score = sum(
            row["adjusted_score"] for row in selected_rows
        ) / len(selected_rows)
        chosen_index = None

    indices = _priority_indices([row["adjusted_score"] for row in ticket_rows])
    for rank, (row, index) in enumerate(zip(ticket_rows, indices), 1):
        row["rank"] = rank
        row["priority_index"] = index

    diagnostics = portfolio_diagnostics(tickets)
    metadata = {
        "algorithm": ALGORITHM_NAME,
        "strategy": config["strategy"],
        "portfolio_mode": mode,
        "config": config,
        "candidate_portfolios_requested": requested,
        "candidate_tickets_evaluated": candidate_count,
        "selected_candidate": chosen_index,
        "portfolio_score": round(portfolio_score, 6),
        "portfolio": diagnostics,
        "hard_filter_rejections": dict(rejection_counts),
        "historical_full_duplicates": sum(
            ticket_key(reds, blues[0]) in seen_full for reds, blues in tickets
        ),
        "historical_red_duplicates": sum(tuple(reds) in seen_reds for reds, _ in tickets),
        "learning_profile": profile.summary(
            rare_rate=float(config["rare_rate"]),
            tail_rate=float(config["tail_rate"]),
        ),
        "ticket_scores": ticket_rows,
        "ranking": {
            "method": f"{RANKING_METHOD}+stability-gated-v15",
            "priority_indices": indices,
            "index_is_probability": False,
            "order_frozen": True,
            "trained_through": str(history[-1]["issue"]),
        },
    }
    return tickets, metadata


def evaluate_config(draws: list[dict], config: dict, periods: int) -> dict:
    """严格逐期验证一个配置，目标期数据不会进入当期学习。"""
    start = max(MIN_EMPIRICAL_HISTORY, len(draws) - max(1, int(periods)))
    rows = []
    for index in range(start, len(draws)):
        actual = draws[index]
        tickets, _ = build_adaptive_portfolio(str(actual["issue"]), draws[:index], config)
        actual_reds = set(draw_reds(actual))
        actual_blue = int(actual["b1"])
        red_hits = [len(set(reds) & actual_reds) for reds, _ in tickets]
        blue_hits = [int(actual_blue in blues) for _, blues in tickets]
        best_index = max(
            range(len(tickets)),
            key=lambda position: (red_hits[position], blue_hits[position]),
        )
        rows.append({
            "max_red": max(red_hits),
            "blue_covered": any(blue_hits),
            "blue_aligned": bool(blue_hits[best_index]),
            "four_red_blue": any(
                red >= 4 and blue == 1
                for red, blue in zip(red_hits, blue_hits)
            ),
            "joint_power": max(
                (red ** 4) * (1 + blue)
                for red, blue in zip(red_hits, blue_hits)
            ),
            "big_prize": any(
                red == 6 or (red == 5 and blue == 1)
                for red, blue in zip(red_hits, blue_hits)
            ),
        })
    total = len(rows)
    ge4 = sum(row["max_red"] >= 4 for row in rows)
    ge3 = sum(row["max_red"] >= 3 for row in rows)
    p5 = sum(row["max_red"] >= 5 for row in rows)
    big = sum(row["big_prize"] for row in rows)
    blue = sum(row["blue_covered"] for row in rows)
    return {
        "total": total,
        "p_ge4": ge4 / total if total else 0.0,
        "p_ge3": ge3 / total if total else 0.0,
        "p_5red": p5 / total if total else 0.0,
        "p_4r_full_blue": 0.0,
        "p_big_prize": big / total if total else 0.0,
        "blue_rate": blue / total if total else 0.0,
        "blue_aligned_rate": (
            sum(row["blue_aligned"] for row in rows) / total if total else 0.0
        ),
        "p_4red_blue": (
            sum(row["four_red_blue"] for row in rows) / total if total else 0.0
        ),
        "avg_joint_power": (
            sum(row["joint_power"] for row in rows) / total if total else 0.0
        ),
        "avg_max_red": sum(row["max_red"] for row in rows) / total if total else 0.0,
        "ge4_count": ge4,
        "ge3_count": ge3,
        "p5_count": p5,
        "big_prize_count": big,
    }
