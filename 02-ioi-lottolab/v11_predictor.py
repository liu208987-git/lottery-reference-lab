"""双色球 v11：可按优先前缀购买的100注极限高奖覆盖序列。"""

from __future__ import annotations

import random
from hashlib import sha256

from ticket_ranking import rank_tickets
from v10_predictor import FAVORABLE_OUTCOMES_PER_TICKET, TOTAL_OUTCOMES


ALGORITHM_NAME = "ssq-v11-extreme-cover"
SEED_NAMESPACE = "v11-extreme-prefix-cover"


def v11_rng(issue: str, replicate: int = 0) -> random.Random:
    payload = f"{SEED_NAMESPACE}|{issue}|{replicate}".encode()
    seed = int.from_bytes(sha256(payload).digest()[:8], "big")
    return random.Random(seed)


def _mask(values) -> int:
    result = 0
    for value in values:
        result |= 1 << (value - 1)
    return result


def build_v11_extreme(
    rng: random.Random,
    draws: list[dict] | None = None,
    ticket_count: int = 100,
    *,
    rank_current: bool = False,
    return_metadata: bool = False,
):
    if not 1 <= ticket_count <= 200:
        raise ValueError("ticket_count必须在1到200之间")
    reds = []
    masks = []
    attempts = 0
    for _ in range(ticket_count):
        selected = None
        for _attempt in range(20000):
            attempts += 1
            candidate = sorted(rng.sample(range(1, 34), 6))
            candidate_mask = _mask(candidate)
            if all((candidate_mask & previous).bit_count() <= 3 for previous in masks):
                selected = candidate
                masks.append(candidate_mask)
                reds.append(candidate)
                break
        if selected is None:
            raise RuntimeError("无法继续构造红球交集<=3的v11序列")

    priority = None
    if rank_current and draws:
        provisional = [(red, [index % 16 + 1]) for index, red in enumerate(reds)]
        priority = rank_tickets(provisional, draws, "ssq")
        reds = [reds[item["index"]] for item in priority]

    # 每连续16注覆盖全部蓝球；因此购买任意前缀时蓝球覆盖也尽量增长。
    blues = []
    while len(blues) < ticket_count:
        block = list(range(1, 17))
        rng.shuffle(block)
        blues.extend(block)
    tickets = [(reds[i], [blues[i]]) for i in range(ticket_count)]

    prefixes = {}
    for count in sorted({1, 5, 10, 20, 50, 100, ticket_count}):
        if count > ticket_count:
            continue
        favorable = count * FAVORABLE_OUTCOMES_PER_TICKET
        probability = favorable / TOTAL_OUTCOMES
        prefixes[str(count)] = {
            "cost": count * 2,
            "favorable_outcomes": favorable,
            "third_plus_probability": probability,
            "odds_one_in": 1 / probability,
            "blue_coverage": len({tickets[i][1][0] for i in range(count)}),
        }
    metadata = {
        "strategy": "nested_prefix_third_prize_upper_bound_v11",
        "ticket_count": ticket_count,
        "attempts": attempts,
        "max_red_overlap": max(
            (masks[i] & masks[j]).bit_count()
            for i in range(ticket_count) for j in range(i + 1, ticket_count)
        ) if ticket_count > 1 else 0,
        "upper_bound_achieved_for_every_prefix": True,
        "prefixes": prefixes,
        "ranking_method": "historical weak secondary priority" if priority else "generation order",
        "ranking_is_probability": False,
        "priority": priority,
    }
    return (tickets, metadata) if return_metadata else tickets


__all__ = ["ALGORITHM_NAME", "build_v11_extreme", "v11_rng"]
