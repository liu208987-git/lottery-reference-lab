"""Walk-forward compression of the existing five-ticket forecasts into one ticket.

The production predictors deliberately spread numbers across five tickets.  This
module keeps that source portfolio, then learns online which numbers inside the
portfolio deserve a place in a single compressed ticket.  For every historical
draw the order is strictly:

1. build the source portfolio from earlier draws only;
2. score and lock the compressed ticket;
3. compare it with the target draw;
4. update the online selector.

The first historical draw is included.  Because it has no preceding history,
the source predictor uses its deterministic V8 coverage fallback.  The adaptive
production source takes over after its required 100-draw warm-up.
"""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass, field
from itertools import combinations
import json
import math
from pathlib import Path
import sqlite3
from typing import Iterable

import dlt_db
import ssq_db
from app_paths import DATA_ROOT
from auto_optimizer import get_optimized_config
from dlt_adaptive_predictor import (
    ALGORITHM_NAME as DLT_ALGORITHM,
    MIN_EMPIRICAL_HISTORY as DLT_MIN_HISTORY,
    build_adaptive_portfolio as build_dlt_portfolio,
)
from ssq_adaptive_predictor import (
    ALGORITHM_NAME as SSQ_ALGORITHM,
    MIN_EMPIRICAL_HISTORY as SSQ_MIN_HISTORY,
    build_adaptive_portfolio as build_ssq_portfolio,
)
from v8_predictor import build_v8_balanced, v8_rng


ROOT = Path(__file__).resolve().parent
REPORT_DIR = ROOT / "reports"
SINGLE_ALGORITHMS = {
    "ssq": "ssq-v15-single-ensemble",
    "dlt": "dlt-v7-single-ensemble",
}

GAME_RULES = {
    "ssq": {
        "red_pool": 33, "red_pick": 6, "blue_pool": 16, "blue_pick": 1,
        "algorithm": SSQ_ALGORITHM, "min_history": SSQ_MIN_HISTORY,
    },
    "dlt": {
        "red_pool": 35, "red_pick": 5, "blue_pool": 12, "blue_pick": 2,
        "algorithm": DLT_ALGORITHM, "min_history": DLT_MIN_HISTORY,
    },
}
_LOCKED_PORTFOLIO_CACHE: dict[
    str, dict[str, tuple[str, list, list]]
] = {}

SSQ_LEVELS = [f"{number}等奖" for number in "一二三四五六"]
DLT_CURRENT_LEVELS = [f"{number}等奖" for number in "一二三四五六七"]
DLT_OLD_LEVELS = [f"{number}等奖" for number in "一二三四五六七八九"]


def _draw_numbers(draw: dict, game: str) -> tuple[tuple[int, ...], tuple[int, ...]]:
    rules = GAME_RULES[game]
    reds = tuple(int(draw[f"r{i}"]) for i in range(1, rules["red_pick"] + 1))
    blues = tuple(int(draw[f"b{i}"]) for i in range(1, rules["blue_pick"] + 1))
    return reds, blues


def current_prize(game: str, red_hits: int, blue_hits: int) -> str | None:
    """Classify a ticket using the rules currently in force."""
    pair = red_hits, blue_hits
    if game == "ssq":
        mapping = {
            (6, 1): "一等奖",
            (6, 0): "二等奖",
            (5, 1): "三等奖",
            (5, 0): "四等奖", (4, 1): "四等奖",
            (4, 0): "五等奖", (3, 1): "五等奖",
            (2, 1): "六等奖", (1, 1): "六等奖", (0, 1): "六等奖",
        }
        return mapping.get(pair)
    mapping = {
        (5, 2): "一等奖",
        (5, 1): "二等奖",
        (5, 0): "三等奖", (4, 2): "三等奖",
        (4, 1): "四等奖",
        (4, 0): "五等奖", (3, 2): "五等奖",
        (3, 1): "六等奖", (2, 2): "六等奖",
        (3, 0): "七等奖", (2, 1): "七等奖",
        (1, 2): "七等奖", (0, 2): "七等奖",
    }
    return mapping.get(pair)


def era_prize(game: str, issue: str, red_hits: int, blue_hits: int) -> str | None:
    """Classify using the prize-level layout in force for the target issue."""
    if game == "ssq":
        return current_prize(game, red_hits, blue_hits)
    pair = red_hits, blue_hits
    if str(issue) >= "2026014":
        return current_prize(game, red_hits, blue_hits)
    old_mapping = {
        (5, 2): "一等奖",
        (5, 1): "二等奖",
        (5, 0): "三等奖",
        (4, 2): "四等奖",
        (4, 1): "五等奖",
        (3, 2): "六等奖",
        (4, 0): "七等奖",
        (3, 1): "八等奖", (2, 2): "八等奖",
    }
    if str(issue) >= "2019019":
        old_mapping.update({
            (3, 0): "九等奖", (2, 1): "九等奖",
            (1, 2): "九等奖", (0, 2): "九等奖",
        })
    return old_mapping.get(pair)


def _clip(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _sigmoid(value: float) -> float:
    value = _clip(value, -20.0, 20.0)
    return 1.0 / (1.0 + math.exp(-value))


@dataclass
class OnlineModel:
    """Small online logistic ranker; updates occur only after each target draw."""

    weights: list[float] = field(default_factory=lambda: [
        0.0, 0.90, 0.45, 0.08, 0.08, 0.06, 0.04, 0.03, 0.03,
    ])
    rounds: int = 0

    def logit(self, features: list[float]) -> float:
        return sum(weight * feature for weight, feature in zip(self.weights, features))

    def update(
        self,
        examples: dict[int, list[float]],
        actual: set[int],
    ) -> None:
        if not examples:
            return
        learning_rate = 0.045 / math.sqrt(1.0 + self.rounds / 400.0)
        gradients = [0.0] * len(self.weights)
        for number, features in examples.items():
            target = float(number in actual)
            error = target - _sigmoid(self.logit(features))
            for index, feature in enumerate(features):
                gradients[index] += error * feature
        scale = 1.0 / len(examples)
        for index in range(len(self.weights)):
            regularization = 0.0 if index == 0 else 0.0002 * self.weights[index]
            self.weights[index] += learning_rate * (
                gradients[index] * scale - regularization
            )
        self.rounds += 1


@dataclass
class HistoryState:
    game: str
    draws: int = 0
    red_counts: Counter = field(default_factory=Counter)
    blue_counts: Counter = field(default_factory=Counter)
    red_last_seen: dict[int, int] = field(default_factory=dict)
    blue_last_seen: dict[int, int] = field(default_factory=dict)
    recent_reds: list[set[int]] = field(default_factory=list)
    recent_blues: list[set[int]] = field(default_factory=list)
    red_shapes: dict[str, Counter] = field(default_factory=lambda: {
        key: Counter() for key in ("sum", "span", "odd", "zones", "runs")
    })
    blue_pair_counts: Counter = field(default_factory=Counter)

    def _red_shape(self, reds: Iterable[int]) -> dict[str, object]:
        values = tuple(sorted(int(number) for number in reds))
        pool = GAME_RULES[self.game]["red_pool"]
        cut1, cut2 = (11, 22) if pool == 33 else (12, 24)
        zones = (
            sum(number <= cut1 for number in values),
            sum(cut1 < number <= cut2 for number in values),
            sum(number > cut2 for number in values),
        )
        runs = sum(right == left + 1 for left, right in zip(values, values[1:]))
        return {
            "sum": sum(values) // 10,
            "span": (values[-1] - values[0]) // 5,
            "odd": sum(number % 2 for number in values),
            "zones": zones,
            "runs": runs,
        }

    def structure_score(self, reds: Iterable[int]) -> float:
        if self.draws < 20:
            return 0.0
        shape = self._red_shape(reds)
        score = 0.0
        for key, value in shape.items():
            counter = self.red_shapes[key]
            maximum = max(counter.values(), default=0)
            score += math.log((counter[value] + 1.0) / (maximum + 1.0))
        return score

    def pair_score(self, blues: Iterable[int]) -> float:
        values = tuple(sorted(int(number) for number in blues))
        if len(values) != 2 or self.draws < 20:
            return 0.0
        maximum = max(self.blue_pair_counts.values(), default=0)
        return math.log((self.blue_pair_counts[values] + 1.0) / (maximum + 1.0))

    def _recent_rate(
        self,
        number: int,
        rows: list[set[int]],
        window: int,
        expected: float,
    ) -> float:
        sample = rows[-window:]
        if not sample:
            return 0.0
        rate = sum(number in row for row in sample) / len(sample)
        return _clip(rate / expected - 1.0, -1.5, 1.5) / 1.5

    def features(
        self,
        number: int,
        *,
        zone: str,
        source_priority: float,
        source_frequency: float,
    ) -> list[float]:
        rules = GAME_RULES[self.game]
        pick = rules["red_pick"] if zone == "red" else rules["blue_pick"]
        pool = rules["red_pool"] if zone == "red" else rules["blue_pool"]
        counts = self.red_counts if zone == "red" else self.blue_counts
        last_seen = self.red_last_seen if zone == "red" else self.blue_last_seen
        rows = self.recent_reds if zone == "red" else self.recent_blues
        expected = pick / pool
        long_rate = counts[number] / self.draws if self.draws else expected
        normalized_long = _clip(long_rate / expected - 1.0, -1.5, 1.5) / 1.5
        previous = rows[-1] if rows else set()
        gap = self.draws - last_seen.get(number, -1)
        expected_gap = pool / pick
        normalized_gap = _clip(gap / expected_gap - 1.0, -1.5, 1.5) / 1.5
        return [
            1.0,
            _clip(source_priority, 0.0, 1.5),
            _clip(source_frequency, 0.0, 1.0),
            self._recent_rate(number, rows, 10, expected),
            self._recent_rate(number, rows, 30, expected),
            self._recent_rate(number, rows, 100, expected),
            normalized_long,
            float(number in previous),
            normalized_gap,
        ]

    def update(self, reds: Iterable[int], blues: Iterable[int]) -> None:
        red_set, blue_set = set(reds), set(blues)
        for number in red_set:
            self.red_counts[number] += 1
            self.red_last_seen[number] = self.draws
        for number in blue_set:
            self.blue_counts[number] += 1
            self.blue_last_seen[number] = self.draws
        self.recent_reds.append(red_set)
        self.recent_blues.append(blue_set)
        if len(self.recent_reds) > 100:
            self.recent_reds.pop(0)
            self.recent_blues.pop(0)
        for key, value in self._red_shape(red_set).items():
            self.red_shapes[key][value] += 1
        if len(blue_set) == 2:
            self.blue_pair_counts[tuple(sorted(blue_set))] += 1
        self.draws += 1


def _source_support(
    tickets: list[tuple[list[int], list[int]]],
    priorities: list[float],
    zone: str,
) -> tuple[dict[int, float], Counter]:
    priority_support: Counter = Counter()
    frequency: Counter = Counter()
    for index, ticket in enumerate(tickets):
        numbers = ticket[0] if zone == "red" else ticket[1]
        weight = priorities[index] if index < len(priorities) else 1.0 / (index + 1)
        for number in numbers:
            priority_support[int(number)] += float(weight)
            frequency[int(number)] += 1
    maximum = max(priority_support.values(), default=1.0)
    count = max(1, len(tickets))
    normalized_priority = {
        number: value / maximum for number, value in priority_support.items()
    }
    normalized_frequency = Counter({
        number: value / count for number, value in frequency.items()
    })
    return normalized_priority, normalized_frequency


def _cohesion_score(
    values: Iterable[int],
    tickets: list[tuple[list[int], list[int]]],
    priorities: list[float],
    zone: str,
) -> float:
    values = tuple(values)
    if len(values) < 2:
        return 0.0
    support = 0.0
    possible = 0.0
    for left, right in combinations(values, 2):
        possible += 1.0
        for index, ticket in enumerate(tickets):
            numbers = set(ticket[0] if zone == "red" else ticket[1])
            if left in numbers and right in numbers:
                support += priorities[index] if index < len(priorities) else 0.5
                break
    return support / possible if possible else 0.0


def compress_portfolio(
    game: str,
    tickets: list[tuple[list[int], list[int]]],
    priorities: list[float],
    state: HistoryState,
    red_model: OnlineModel,
    blue_model: OnlineModel,
) -> tuple[tuple[list[int], list[int]], dict[int, list[float]], dict[int, list[float]]]:
    rules = GAME_RULES[game]
    red_priority, red_frequency = _source_support(tickets, priorities, "red")
    blue_priority, blue_frequency = _source_support(tickets, priorities, "blue")
    red_examples = {
        number: state.features(
            number, zone="red",
            source_priority=red_priority[number],
            source_frequency=red_frequency[number],
        )
        for number in sorted(red_priority)
    }
    blue_examples = {
        number: state.features(
            number, zone="blue",
            source_priority=blue_priority[number],
            source_frequency=blue_frequency[number],
        )
        for number in sorted(blue_priority)
    }

    red_logits = {
        number: red_model.logit(features) for number, features in red_examples.items()
    }
    red_shortlist = sorted(
        red_logits, key=lambda number: (-red_logits[number], number)
    )[:min(12, len(red_logits))]
    red_options = list(combinations(red_shortlist, rules["red_pick"]))
    red_options.extend(tuple(sorted(ticket[0])) for ticket in tickets)
    best_reds = max(
        set(red_options),
        key=lambda values: (
            sum(red_logits[number] for number in values)
            + 0.16 * state.structure_score(values)
            + 0.04 * _cohesion_score(values, tickets, priorities, "red"),
            tuple(-number for number in values),
        ),
    )

    blue_logits = {
        number: blue_model.logit(features) for number, features in blue_examples.items()
    }
    if rules["blue_pick"] == 1:
        best_blues = (
            max(blue_logits, key=lambda number: (blue_logits[number], -number)),
        )
    else:
        blue_options = combinations(sorted(blue_logits), 2)
        best_blues = max(
            blue_options,
            key=lambda values: (
                sum(blue_logits[number] for number in values)
                + 0.16 * state.pair_score(values)
                + 0.05 * _cohesion_score(values, tickets, priorities, "blue"),
                tuple(-number for number in values),
            ),
        )
    return (
        (list(sorted(best_reds)), list(sorted(best_blues))),
        red_examples,
        blue_examples,
    )


def _warmup_portfolio(
    game: str,
    issue: str,
) -> tuple[list[tuple[list[int], list[int]]], list[float]]:
    rules = GAME_RULES[game]
    tickets = build_v8_balanced(
        v8_rng(game, str(issue)),
        [],
        rules["red_pool"], rules["red_pick"],
        rules["blue_pool"], rules["blue_pick"],
        5,
    )
    return tickets, [1.0, 0.82, 0.64, 0.46, 0.28]


def build_source_portfolio(
    game: str,
    issue: str,
    history: list[dict],
    config: dict,
) -> tuple[list[tuple[list[int], list[int]]], list[float], str]:
    rules = GAME_RULES[game]
    if len(history) < rules["min_history"]:
        tickets, priorities = _warmup_portfolio(game, issue)
        return tickets, priorities, "v8_warmup"
    # 全量回填后优先复用审计库中同一走期时点的已冻结五注。这样单注层
    # 与页面顶部统计使用完全相同的源票，不重复生成另一套候选。
    locked = _locked_portfolio(game, str(history[-1]["issue"]))
    if locked is not None and str(locked[0]) == str(issue):
        _, tickets, priorities = locked
        return tickets, priorities, "locked_walk_forward"
    try:
        if game == "ssq":
            tickets, metadata = build_ssq_portfolio(issue, history, config)
        else:
            tickets, metadata = build_dlt_portfolio(issue, history, config)
        raw = metadata.get("ranking", {}).get("priority_indices", [])
        priorities = [
            max(0.01, min(1.0, float(value) / 100.0)) for value in raw
        ]
        if len(priorities) != len(tickets):
            priorities = [1.0, 0.82, 0.64, 0.46, 0.28]
        return tickets, priorities, "adaptive"
    except (RuntimeError, ValueError):
        tickets, priorities = _warmup_portfolio(game, issue)
        return tickets, priorities, "v8_fallback"


@dataclass
class MetricBook:
    game: str
    total: int = 0
    wins_current: int = 0
    wins_era: int = 0
    current_prizes: Counter = field(default_factory=Counter)
    era_prizes: Counter = field(default_factory=Counter)
    red_hits: Counter = field(default_factory=Counter)
    blue_hits: Counter = field(default_factory=Counter)
    joint_hits: Counter = field(default_factory=Counter)

    def add(
        self,
        issue: str,
        ticket: tuple[list[int], list[int]],
        actual_reds: set[int],
        actual_blues: set[int],
    ) -> tuple[int, int, str | None, str | None]:
        red_hits = len(set(ticket[0]) & actual_reds)
        blue_hits = len(set(ticket[1]) & actual_blues)
        normalized = current_prize(self.game, red_hits, blue_hits)
        historical = era_prize(self.game, issue, red_hits, blue_hits)
        self.total += 1
        self.red_hits[red_hits] += 1
        self.blue_hits[blue_hits] += 1
        self.joint_hits[f"{red_hits}+{blue_hits}"] += 1
        if normalized:
            self.wins_current += 1
            self.current_prizes[normalized] += 1
        if historical:
            self.wins_era += 1
            self.era_prizes[historical] += 1
        return red_hits, blue_hits, normalized, historical

    def summary(self) -> dict:
        current_levels = SSQ_LEVELS if self.game == "ssq" else DLT_CURRENT_LEVELS
        era_levels = SSQ_LEVELS if self.game == "ssq" else DLT_OLD_LEVELS
        return {
            "draws": self.total,
            "current_rule_wins": self.wins_current,
            "current_rule_win_rate": self.wins_current / self.total if self.total else 0.0,
            "era_rule_wins": self.wins_era,
            "era_rule_win_rate": self.wins_era / self.total if self.total else 0.0,
            "current_rule_prizes": {
                level: self.current_prizes[level] for level in current_levels
            },
            "era_rule_prizes": {
                level: self.era_prizes[level] for level in era_levels
            },
            "red_hit_distribution": {
                str(level): self.red_hits[level]
                for level in range(GAME_RULES[self.game]["red_pick"] + 1)
            },
            "blue_hit_distribution": {
                str(level): self.blue_hits[level]
                for level in range(GAME_RULES[self.game]["blue_pick"] + 1)
            },
            "joint_hit_distribution": dict(sorted(self.joint_hits.items())),
            "average_red_hits": (
                sum(level * count for level, count in self.red_hits.items()) / self.total
                if self.total else 0.0
            ),
            "average_blue_hits": (
                sum(level * count for level, count in self.blue_hits.items()) / self.total
                if self.total else 0.0
            ),
        }


def _locked_portfolio(game: str, trained_through: str) -> tuple[str, list, list] | None:
    cached = _LOCKED_PORTFOLIO_CACHE.get(game)
    if cached is not None:
        return cached.get(str(trained_through))

    path = DATA_ROOT / f"{game}_prediction_audit.db"
    if not path.exists():
        _LOCKED_PORTFOLIO_CACHE[game] = {}
        return None
    algorithm = GAME_RULES[game]["algorithm"]
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT * FROM predictions
            WHERE algorithm=?
            ORDER BY generated_at ASC
            """,
            (algorithm,),
        ).fetchall()
        portfolio_by_training_issue: dict[str, tuple[str, list, list]] = {}
        for row in rows:
            tickets = [
                (list(reds), list(blues))
                for reds, blues in json.loads(row["tickets_json"])
            ]
            model = json.loads(row["model_json"])
            raw = model.get("ranking", {}).get("priority_indices", [])
            priorities = [
                max(0.01, min(1.0, float(value) / 100.0)) for value in raw
            ]
            if len(priorities) != len(tickets):
                priorities = [1.0, 0.82, 0.64, 0.46, 0.28]
            portfolio_by_training_issue[str(row["trained_through"])] = (
                str(row["issue"]),
                tickets,
                priorities,
            )
        _LOCKED_PORTFOLIO_CACHE[game] = portfolio_by_training_issue
        return portfolio_by_training_issue.get(str(trained_through))
    finally:
        connection.close()


def _paired_delta(
    aggregate_wins: list[int],
    baseline_wins: list[int],
    start: int = 0,
) -> dict:
    aggregate = aggregate_wins[start:]
    baseline = baseline_wins[start:]
    count = len(aggregate)
    better = sum(a > b for a, b in zip(aggregate, baseline))
    worse = sum(a < b for a, b in zip(aggregate, baseline))
    same = count - better - worse
    aggregate_rate = sum(aggregate) / count if count else 0.0
    baseline_rate = sum(baseline) / count if count else 0.0
    return {
        "draws": count,
        "aggregate_rate": aggregate_rate,
        "baseline_rate": baseline_rate,
        "absolute_change": aggregate_rate - baseline_rate,
        "relative_change": (
            aggregate_rate / baseline_rate - 1.0 if baseline_rate else None
        ),
        "paired_better": better,
        "paired_worse": worse,
        "paired_same": same,
    }


def run_backtest(game: str, *, limit: int | None = None) -> dict:
    database = ssq_db if game == "ssq" else dlt_db
    draws = database.get_all_draws("ASC")
    if limit:
        draws = draws[:max(1, int(limit))]
    config = get_optimized_config(game) or {}
    state = HistoryState(game)
    red_model, blue_model = OnlineModel(), OnlineModel()
    aggregate_metrics = MetricBook(game)
    baseline_metrics = MetricBook(game)
    portfolio_metrics = MetricBook(game)
    aggregate_wins: list[int] = []
    baseline_wins: list[int] = []
    source_modes: Counter = Counter()
    union_red_hits: Counter = Counter()
    union_blue_hits: Counter = Counter()
    history: list[dict] = []

    for index, actual in enumerate(draws):
        issue = str(actual["issue"])
        tickets, priorities, source_mode = build_source_portfolio(
            game, issue, history, config
        )
        source_modes[source_mode] += 1
        aggregate, red_examples, blue_examples = compress_portfolio(
            game, tickets, priorities, state, red_model, blue_model
        )
        actual_red_tuple, actual_blue_tuple = _draw_numbers(actual, game)
        actual_reds, actual_blues = set(actual_red_tuple), set(actual_blue_tuple)

        aggregate_result = aggregate_metrics.add(
            issue, aggregate, actual_reds, actual_blues
        )
        baseline_result = baseline_metrics.add(
            issue, tickets[0], actual_reds, actual_blues
        )
        aggregate_wins.append(int(aggregate_result[2] is not None))
        baseline_wins.append(int(baseline_result[2] is not None))

        union_reds = set().union(*(set(ticket[0]) for ticket in tickets))
        union_blues = set().union(*(set(ticket[1]) for ticket in tickets))
        union_red_hits[len(union_reds & actual_reds)] += 1
        union_blue_hits[len(union_blues & actual_blues)] += 1

        best_ticket = max(
            tickets,
            key=lambda ticket: (
                -(
                    (SSQ_LEVELS if game == "ssq" else DLT_CURRENT_LEVELS).index(
                        current_prize(
                            game,
                            len(set(ticket[0]) & actual_reds),
                            len(set(ticket[1]) & actual_blues),
                        )
                    )
                    if current_prize(
                        game,
                        len(set(ticket[0]) & actual_reds),
                        len(set(ticket[1]) & actual_blues),
                    )
                    else 99
                ),
                len(set(ticket[0]) & actual_reds),
                len(set(ticket[1]) & actual_blues),
            ),
        )
        portfolio_metrics.add(issue, best_ticket, actual_reds, actual_blues)

        red_model.update(red_examples, actual_reds)
        blue_model.update(blue_examples, actual_blues)
        state.update(actual_reds, actual_blues)
        history.append(actual)
        if (index + 1) % 100 == 0 or index + 1 == len(draws):
            print(
                f"{game}: {index + 1}/{len(draws)} periods complete",
                flush=True,
            )

    full_count = len(draws)
    holdout_start = int(full_count * 0.70)
    latest = _locked_portfolio(game, str(draws[-1]["issue"]))
    if latest:
        target_issue, current_tickets, current_priorities = latest
    else:
        target_issue = (
            f"{int(draws[-1]['issue'][:4])}"
            f"{int(draws[-1]['issue'][4:]) + 1:03d}"
        )
        current_tickets, current_priorities, _ = build_source_portfolio(
            game, target_issue, history, config
        )
    current_ticket, _, _ = compress_portfolio(
        game, current_tickets, current_priorities, state, red_model, blue_model
    )

    return {
        "game": game,
        "source_algorithm": GAME_RULES[game]["algorithm"],
        "history_range": [str(draws[0]["issue"]), str(draws[-1]["issue"])],
        "draws": full_count,
        "walk_forward_order": "predict -> score -> learn",
        "first_draw_policy": "deterministic_v8_no_history",
        "adaptive_warmup_draws": GAME_RULES[game]["min_history"],
        "source_modes": dict(source_modes),
        "config_frozen": config,
        "aggregate": aggregate_metrics.summary(),
        "baseline_first_ticket": baseline_metrics.summary(),
        "best_of_five_context": portfolio_metrics.summary(),
        "coverage": {
            "union_red_hit_distribution": {
                str(key): value for key, value in sorted(union_red_hits.items())
            },
            "union_blue_hit_distribution": {
                str(key): value for key, value in sorted(union_blue_hits.items())
            },
        },
        "comparison": {
            "all_history_current_rules": _paired_delta(
                aggregate_wins, baseline_wins
            ),
            "last_30_percent_current_rules": _paired_delta(
                aggregate_wins, baseline_wins, holdout_start
            ),
            "last_100_current_rules": _paired_delta(
                aggregate_wins, baseline_wins, max(0, full_count - 100)
            ),
        },
        "online_model": {
            "features": [
                "bias", "source_priority", "source_frequency",
                "recent_10", "recent_30", "recent_100",
                "long_frequency", "previous_repeat", "gap",
            ],
            "red_weights": [round(value, 8) for value in red_model.weights],
            "blue_weights": [round(value, 8) for value in blue_model.weights],
        },
        "current_prediction": {
            "issue": target_issue,
            "reds": current_ticket[0],
            "blues": current_ticket[1],
            "source_tickets": [
                {"reds": reds, "blues": blues}
                for reds, blues in current_tickets
            ],
            "trained_through": str(draws[-1]["issue"]),
        },
        "method_limitations": [
            "Each target draw is excluded from its prediction and model update.",
            "The current production source configuration is frozen across history; "
            "its hyperparameters were selected before this backtest and are not "
            "a pristine pre-registered historical experiment.",
            "Best-of-five coverage is context only and costs five bets; it is not "
            "a fair one-bet baseline.",
            "Historical frequencies do not establish a causal advantage for a "
            "future lottery draw.",
        ],
    }


def _percent(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.4%}"


def render_markdown(result: dict) -> str:
    game_name = "双色球" if result["game"] == "ssq" else "大乐透"
    prediction = result["current_prediction"]
    red_label = "红球" if result["game"] == "ssq" else "前区"
    blue_label = "蓝球" if result["game"] == "ssq" else "后区"
    lines = [
        f"# {game_name}单注聚合滚动回测",
        "",
        f"- 历史范围：{result['history_range'][0]}—{result['history_range'][1]}，"
        f"共 {result['draws']} 期",
        f"- 当前预测：{prediction['issue']}期，{red_label} "
        + " ".join(f"{number:02d}" for number in prediction["reds"])
        + f"，{blue_label} "
        + " ".join(f"{number:02d}" for number in prediction["blues"]),
        "- 时序：每期先预测并锁定，再评分，最后学习该期开奖结果",
        "- 第一期无历史数据，使用确定性V8覆盖回退；第100期历史后启用生产自适应源模型",
        "",
        "## 现行规则统一口径",
        "",
        "| 策略 | 中奖期数 | 中奖率 | 平均前区/红球命中 | 平均后区/蓝球命中 |",
        "|---|---:|---:|---:|---:|",
    ]
    for key, label in (
        ("aggregate", "聚合单注"),
        ("baseline_first_ticket", "原算法首选单注"),
        ("best_of_five_context", "原五注任一命中（非同成本）"),
    ):
        stats = result[key]
        lines.append(
            f"| {label} | {stats['current_rule_wins']} | "
            f"{_percent(stats['current_rule_win_rate'])} | "
            f"{stats['average_red_hits']:.4f} | {stats['average_blue_hits']:.4f} |"
        )
    levels = SSQ_LEVELS if result["game"] == "ssq" else DLT_CURRENT_LEVELS
    lines.extend([
        "",
        "## 各奖级次数（全历史统一按现行规则重分类）",
        "",
        "| 奖级 | 聚合单注 | 原算法首选单注 | 原五注任一（非同成本） |",
        "|---|---:|---:|---:|",
    ])
    for level in levels:
        lines.append(
            f"| {level} | {result['aggregate']['current_rule_prizes'][level]} | "
            f"{result['baseline_first_ticket']['current_rule_prizes'][level]} | "
            f"{result['best_of_five_context']['current_rule_prizes'][level]} |"
        )
    lines.extend([
        "",
        "## 按当时有效奖级",
        "",
        "| 策略 | 中奖期数 | 中奖率 |",
        "|---|---:|---:|",
    ])
    for key, label in (
        ("aggregate", "聚合单注"),
        ("baseline_first_ticket", "原算法首选单注"),
        ("best_of_five_context", "原五注任一（非同成本）"),
    ):
        stats = result[key]
        lines.append(
            f"| {label} | {stats['era_rule_wins']} | "
            f"{_percent(stats['era_rule_win_rate'])} |"
        )
    era_levels = SSQ_LEVELS if result["game"] == "ssq" else DLT_OLD_LEVELS
    lines.extend([
        "",
        "### 当时有效规则的各奖级次数",
        "",
        "| 奖级 | 聚合单注 | 原算法首选单注 | 原五注任一（非同成本） |",
        "|---|---:|---:|---:|",
    ])
    for level in era_levels:
        lines.append(
            f"| {level} | {result['aggregate']['era_rule_prizes'][level]} | "
            f"{result['baseline_first_ticket']['era_rule_prizes'][level]} | "
            f"{result['best_of_five_context']['era_rule_prizes'][level]} |"
        )
    lines.extend([
        "",
        "## 同成本提升比较（现行规则统一口径）",
        "",
        "| 区间 | 期数 | 聚合单注 | 原首选单注 | 绝对变化 | 相对变化 | 净胜/净负/相同 |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ])
    for key, label in (
        ("all_history_current_rules", "全历史"),
        ("last_30_percent_current_rules", "后30%"),
        ("last_100_current_rules", "近100期"),
    ):
        row = result["comparison"][key]
        lines.append(
            f"| {label} | {row['draws']} | {_percent(row['aggregate_rate'])} | "
            f"{_percent(row['baseline_rate'])} | {_percent(row['absolute_change'])} | "
            f"{_percent(row['relative_change'])} | "
            f"{row['paired_better']}/{row['paired_worse']}/{row['paired_same']} |"
        )
    lines.extend([
        "",
        "## 命中分布",
        "",
        "聚合单注前区/红球命中次数："
        + "，".join(
            f"{key}个={value}"
            for key, value in result["aggregate"]["red_hit_distribution"].items()
        ),
        "",
        "聚合单注后区/蓝球命中次数："
        + "，".join(
            f"{key}个={value}"
            for key, value in result["aggregate"]["blue_hit_distribution"].items()
        ),
        "",
        "## 解释限制",
        "",
        "- 回测严格排除了目标期本身，但生产源模型的当前超参数不是预先注册的历史实验参数。",
        "- “五注任一命中”花费是单注的五倍，只用于说明覆盖，不是公平的中奖率基线。",
        "- 回测差异是历史样本结果，不等于下一期存在同等幅度的真实概率优势。",
    ])
    return "\n".join(lines) + "\n"


def lock_current_prediction(result: dict) -> bool:
    """Store the single ticket before its draw so it can be settled later."""
    game = str(result["game"])
    prediction = result["current_prediction"]
    ticket = [(prediction["reds"], prediction["blues"])]
    model_info = {
        "strategy": "walk-forward-five-to-one-online-ensemble",
        "source_algorithm": result["source_algorithm"],
        "source_tickets": prediction["source_tickets"],
        "online_model": result["online_model"],
        "backtest_draws": result["draws"],
        "comparison": result["comparison"],
    }
    if game == "ssq":
        from ssq_prediction_audit import record_prediction
    else:
        from dlt_prediction_audit import record_prediction
    return record_prediction(
        prediction["issue"],
        SINGLE_ALGORITHMS[game],
        prediction["trained_through"],
        ticket,
        model_info=model_info,
        provenance="prospective_locked",
    )


def load_saved_result(game: str) -> dict:
    """Load the bundled or external full-history result used by the live app."""
    filename = f"single_ticket_backtest_{game}.json"
    candidates = (
        DATA_ROOT / "reports" / filename,
        REPORT_DIR / filename,
    )
    for path in candidates:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    raise FileNotFoundError(f"missing single-ticket backtest report: {filename}")


def generate_live_single(game: str) -> dict:
    """Compress the latest locked production portfolio without rerunning history."""
    if game not in GAME_RULES:
        raise ValueError(f"unknown game: {game}")
    result = load_saved_result(game)
    database = ssq_db if game == "ssq" else dlt_db
    draws = database.get_all_draws("ASC")
    if not draws:
        raise RuntimeError(f"{game} has no draw history")
    trained_through = str(draws[-1]["issue"])
    source = _locked_portfolio(game, trained_through)
    if source is None:
        raise RuntimeError(
            f"{game} has no production portfolio trained through {trained_through}"
        )
    target_issue, tickets, priorities = source

    state = HistoryState(game)
    for draw in draws:
        reds, blues = _draw_numbers(draw, game)
        state.update(reds, blues)
    red_model = OnlineModel(
        weights=[float(value) for value in result["online_model"]["red_weights"]],
        rounds=len(draws),
    )
    blue_model = OnlineModel(
        weights=[float(value) for value in result["online_model"]["blue_weights"]],
        rounds=len(draws),
    )
    ticket, _, _ = compress_portfolio(
        game, tickets, priorities, state, red_model, blue_model
    )
    live_result = {
        **result,
        "source_algorithm": GAME_RULES[game]["algorithm"],
        "current_prediction": {
            "issue": target_issue,
            "reds": ticket[0],
            "blues": ticket[1],
            "source_tickets": [
                {"reds": reds, "blues": blues} for reds, blues in tickets
            ],
            "trained_through": trained_through,
        },
    }
    inserted = lock_current_prediction(live_result)
    return {
        "issue": target_issue,
        "trained_through": trained_through,
        "reds": ticket[0],
        "blues": ticket[1],
        "inserted": inserted,
        "algorithm": SINGLE_ALGORITHMS[game],
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="五注预测压缩为一注并做逐期滚动回测")
    parser.add_argument("--game", choices=("ssq", "dlt"), required=True)
    parser.add_argument("--limit", type=int, default=None, help="仅用于快速测试")
    args = parser.parse_args(argv)
    result = run_backtest(args.game, limit=args.limit)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    suffix = f"_first_{args.limit}" if args.limit else ""
    json_path = REPORT_DIR / f"single_ticket_backtest_{args.game}{suffix}.json"
    md_path = REPORT_DIR / f"single_ticket_backtest_{args.game}{suffix}.md"
    json_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    md_path.write_text(render_markdown(result), encoding="utf-8")
    if args.limit is None:
        inserted = lock_current_prediction(result)
        print(
            "Prospective single ticket: "
            + ("locked" if inserted else "already locked"),
            flush=True,
        )
    print(f"JSON: {json_path}", flush=True)
    print(f"Markdown: {md_path}", flush=True)
    print(
        "Current:",
        result["current_prediction"]["issue"],
        result["current_prediction"]["reds"],
        result["current_prediction"]["blues"],
        flush=True,
    )


if __name__ == "__main__":
    main()
