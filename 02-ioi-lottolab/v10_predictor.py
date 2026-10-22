"""双色球 v10：10注三等奖以上覆盖最大化实验算法。"""

from __future__ import annotations

import random
from hashlib import sha256
from itertools import combinations
from math import comb


ALGORITHM_NAME = "ssq-v10-high-prize"
SEED_NAMESPACE = "v10-high-prize-cover"
FAVORABLE_OUTCOMES_PER_TICKET = 178  # 6红全中16种蓝球 + 5红162种且蓝球命中
TOTAL_OUTCOMES = comb(33, 6) * 16


def v10_seed(issue: str, replicate: int = 0) -> int:
    payload = f"{SEED_NAMESPACE}|{issue}|{replicate}".encode("utf-8")
    return int.from_bytes(sha256(payload).digest()[:8], "big")


def v10_rng(issue: str, replicate: int = 0) -> random.Random:
    return random.Random(v10_seed(issue, replicate))


def high_prize_favorable_outcomes(tickets) -> int:
    """精确计算固定票组三等奖及以上覆盖的基本开奖结局数。"""
    outcomes = set()
    all_numbers = set(range(1, 34))
    for reds, blues in tickets:
        red_set = frozenset(reds)
        for blue in range(1, 17):
            outcomes.add((red_set, blue))
        ticket_blue = int(blues[0])
        for removed in red_set:
            base = set(red_set) - {removed}
            for added in all_numbers - set(red_set):
                outcomes.add((frozenset(base | {added}), ticket_blue))
    return len(outcomes)


def build_v10_high_prize(
    rng: random.Random,
    ticket_count: int = 10,
    *,
    candidate_portfolios: int = 256,
    return_metadata: bool = False,
):
    """生成红球任意两注交集<=3且蓝球互异的10注组合。

    红球交集<=3可保证不同彩票的“6红全中或5红+蓝”覆盖域互不重叠，
    从而达到固定注数下三等奖以上概率的并集上限。
    """
    if not 1 <= ticket_count <= 16:
        raise ValueError("ticket_count必须在1到16之间")
    best = None
    best_score = None
    accepted = 0
    for _ in range(candidate_portfolios):
        red_sets = []
        valid = True
        for _ticket in range(ticket_count):
            chosen = None
            for _attempt in range(300):
                candidate = frozenset(rng.sample(range(1, 34), 6))
                if candidate not in red_sets and all(
                        len(candidate & previous) <= 3 for previous in red_sets):
                    chosen = candidate
                    break
            if chosen is None:
                valid = False
                break
            red_sets.append(chosen)
        if not valid:
            continue
        accepted += 1
        union_size = len(set().union(*red_sets))
        overlaps = [
            len(left & right)
            for left, right in combinations(red_sets, 2)
        ]
        appearances = [sum(number in red for red in red_sets) for number in range(1, 34)]
        score = (
            union_size * 100000
            - max(overlaps, default=0) * 1000
            - sum(value * value for value in overlaps) * 10
            - sum(value * value for value in appearances)
        )
        if best_score is None or score > best_score:
            best_score = score
            best = red_sets
    if best is None:
        raise RuntimeError("无法生成满足高奖覆盖约束的票组")

    blue_order = list(range(1, 17))
    rng.shuffle(blue_order)
    tickets = [
        (sorted(best[index]), [blue_order[index]])
        for index in range(ticket_count)
    ]
    favorable = high_prize_favorable_outcomes(tickets)
    metadata = {
        "strategy": "third_prize_union_max_v10",
        "ticket_count": ticket_count,
        "candidate_portfolios": candidate_portfolios,
        "accepted_portfolios": accepted,
        "red_coverage": len({number for reds, _ in tickets for number in reds}),
        "blue_coverage": len({number for _, blues in tickets for number in blues}),
        "max_red_overlap": max(
            len(set(tickets[i][0]) & set(tickets[j][0]))
            for i in range(ticket_count) for j in range(i + 1, ticket_count)
        ),
        "favorable_outcomes": favorable,
        "theoretical_upper_bound": ticket_count * FAVORABLE_OUTCOMES_PER_TICKET,
        "upper_bound_achieved": favorable == ticket_count * FAVORABLE_OUTCOMES_PER_TICKET,
        "third_or_above_probability": favorable / TOTAL_OUTCOMES,
        "third_or_above_odds_one_in": TOTAL_OUTCOMES / favorable,
    }
    return (tickets, metadata) if return_metadata else tickets


__all__ = [
    "ALGORITHM_NAME", "FAVORABLE_OUTCOMES_PER_TICKET", "TOTAL_OUTCOMES",
    "build_v10_high_prize", "high_prize_favorable_outcomes", "v10_rng", "v10_seed",
]
