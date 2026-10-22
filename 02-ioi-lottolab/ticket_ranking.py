"""Walk-forward calibrated, non-probabilistic priority ranking for five tickets.

Every legal lottery ticket has the same theoretical draw probability.  This
module therefore exposes a *priority index*, not a claimed winning probability.
The index orders a fixed five-ticket portfolio by recent structural fit and a
small historical-frequency component, calibrated with past locked predictions.
"""

from __future__ import annotations

import math
from collections import Counter

from fused_predictor import (
    compute_blue_indicators,
    compute_indicator_distributions,
    compute_red_indicators,
)


RANKING_METHOD = "walk-forward-priority-v1"
WINDOW = 100
FREQUENCY_WEIGHT = 0.1

# These are descriptive walk-forward/holdout results, not a guarantee that the
# ordering predicts future random draws.  In particular, an ordering is not
# allowed to call itself a probability ranking unless the observed hit rates
# are monotonic and the first-position advantage is statistically supported.
RANKING_VALIDATION = {
    "ssq": {
        "method": RANKING_METHOD,
        "validation_method": "strict_walk_forward_all_periods",
        "historical_records": 3476,
        "validation_records": 3476,
        # Compatibility field retained for older clients/tests.
        "holdout_records": 3476,
        "rank_win_counts": [231, 212, 248, 240, 246],
        "rank_win_rates": [
            231 / 3476, 212 / 3476, 248 / 3476, 240 / 3476,
            246 / 3476,
        ],
        "rank_fixed_rois": [
            1320 / 6952, 1545 / 6952, 1965 / 6952, 1695 / 6952,
            1960 / 6952,
        ],
        "rank1_win_rate": 231 / 3476,
        "all_rank_average": 1177 / (3476 * 5),
        "rank1_observed_lift": (231 / 3476) / (1177 / (3476 * 5)),
        "prefix_winning_period_counts": [231, 443, 684, 921, 1157],
        "prefix_winning_period_rates": [
            231 / 3476, 443 / 3476, 684 / 3476, 921 / 3476,
            1157 / 3476,
        ],
        "prefix_fixed_rois": [
            1320 / 6952, 2865 / 13904, 4830 / 20856,
            6525 / 27808, 8485 / 34760,
        ],
        "monotonic": False,
        "prefix_order_validated": False,
        "statistically_significant": False,
    },
    "dlt": {
        "method": RANKING_METHOD,
        "historical_records": 2596,
        "training_records": 1817,
        "holdout_records": 779,
        "rank_win_rates": [56 / 779, 49 / 779, 46 / 779, 51 / 779, 37 / 779],
        "rank1_win_rate": 56 / 779,
        "all_rank_average": 239 / (779 * 5),
        "rank1_observed_lift": (56 / 779) / (239 / (779 * 5)),
        "monotonic": False,
        "prefix_order_validated": False,
        "statistically_significant": False,
    },
}


def _smoothed_log_probability(counter: Counter, value, alpha: float = 1.0) -> float:
    total = sum(counter.values())
    unique = len(counter)
    return math.log(
        (counter.get(value, 0) + alpha)
        / (total + alpha * (unique + 1))
    )


def _game_rules(game: str) -> tuple[int, int, int, int]:
    if game == "ssq":
        return 33, 6, 16, 1
    if game == "dlt":
        return 35, 5, 12, 2
    raise ValueError(f"未知彩种: {game}")


def rank_tickets(
    tickets: list[tuple[list[int], list[int]]],
    draws: list[dict],
    game: str,
    *,
    window: int = WINDOW,
    frequency_weight: float = FREQUENCY_WEIGHT,
) -> list[dict]:
    """Return the fixed ticket set ordered by a historical priority index."""
    red_pool, red_pick, blue_pool, blue_pick = _game_rules(game)
    if not tickets:
        return []
    if not draws:
        return [
            {
                "index": index,
                "rank": index + 1,
                "priority_index": 50.0,
                "raw_score": 0.0,
                "structure_score": 0.0,
                "frequency_score": 0.0,
            }
            for index in range(len(tickets))
        ]

    history = draws[-window:]
    distributions = compute_indicator_distributions(
        history, red_pick, blue_pick, red_pool, blue_pool)
    previous = history[-1]
    previous_reds = {
        previous[f"r{index}"] for index in range(1, red_pick + 1)
    }
    previous_blue = previous["b1"]

    red_counts = Counter(
        draw[f"r{index}"]
        for draw in history
        for index in range(1, red_pick + 1)
    )
    blue_counts = Counter(
        draw[f"b{index}"]
        for draw in history
        for index in range(1, blue_pick + 1)
    )
    red_denominator = len(history) * red_pick + red_pool
    blue_denominator = len(history) * blue_pick + blue_pool

    scored = []
    for index, (reds, blues) in enumerate(tickets):
        red_indicators = compute_red_indicators(reds, red_pool)
        structure_score = sum(
            _smoothed_log_probability(distributions["red"][key], value)
            for key, value in red_indicators.items()
        )
        structure_score += _smoothed_log_probability(
            distributions["repeat"], len(set(reds) & previous_reds))

        # DLT evaluates both back-zone numbers instead of only the first one.
        for blue in blues:
            blue_indicators = compute_blue_indicators(
                blue, blue_pool, previous_blue)
            structure_score += sum(
                _smoothed_log_probability(distributions["blue"][key], value)
                for key, value in blue_indicators.items()
                if key in distributions["blue"]
            )

        frequency_score = sum(
            math.log((red_counts[number] + 1) / red_denominator)
            for number in reds
        ) + sum(
            math.log((blue_counts[number] + 1) / blue_denominator)
            for number in blues
        )
        raw_score = structure_score + frequency_weight * frequency_score
        scored.append({
            "index": index,
            "raw_score": raw_score,
            "structure_score": structure_score,
            "frequency_score": frequency_score,
        })

    mean = sum(item["raw_score"] for item in scored) / len(scored)
    variance = sum(
        (item["raw_score"] - mean) ** 2 for item in scored
    ) / len(scored)
    standard_deviation = math.sqrt(variance)
    for item in scored:
        z_score = (
            (item["raw_score"] - mean) / standard_deviation
            if standard_deviation > 1e-12 else 0.0
        )
        # A bounded relative index.  It is intentionally not called probability.
        item["priority_index"] = round(
            100.0 / (1.0 + math.exp(-max(-8.0, min(8.0, z_score)))), 1)
        item["raw_score"] = round(item["raw_score"], 4)
        item["structure_score"] = round(item["structure_score"], 4)
        item["frequency_score"] = round(item["frequency_score"], 4)

    scored.sort(key=lambda item: (-item["raw_score"], item["index"]))
    for rank, item in enumerate(scored, 1):
        item["rank"] = rank
    return scored


def ranking_metadata(game: str) -> dict:
    return {
        **RANKING_VALIDATION[game],
        "window": WINDOW,
        "frequency_weight": FREQUENCY_WEIGHT,
        "index_is_probability": False,
        "usage": "资金购买K注时固定取优先1至K；当前排序仅为结构参考，未证明第一注真实中奖概率更高。",
    }
