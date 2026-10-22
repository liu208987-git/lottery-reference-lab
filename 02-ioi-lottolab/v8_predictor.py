"""生产版 v8 均衡组合生成器。

v8 不使用未经验证的热号、冷号或遗漏信号。固定 5 注时，它让双色球
覆盖 30 个不同红球和 5 个不同蓝球，让大乐透覆盖 25 个不同前区号码和
10 个不同后区号码。每一注本身仍保持等概率组合。
"""

from __future__ import annotations

import math
import random
from hashlib import sha256


ALGORITHM_NAME = "ssq-v8"
SEED_NAMESPACE = "v8-validation"


def v8_seed(game: str, issue: str, replicate: int = 0) -> int:
    """返回稳定、可复现且不依赖开奖结果的期号种子。"""
    payload = f"{SEED_NAMESPACE}|{game}|{issue}|{replicate}".encode("utf-8")
    return int.from_bytes(sha256(payload).digest()[:8], "big")


def v8_rng(game: str, issue: str, replicate: int = 0) -> random.Random:
    return random.Random(v8_seed(game, issue, replicate))


def _weighted_permutation(
    rng: random.Random,
    pool_size: int,
    scores: dict[int, float] | None = None,
) -> list[int]:
    if scores is None:
        values = list(range(1, pool_size + 1))
        rng.shuffle(values)
        return values
    return sorted(
        range(1, pool_size + 1),
        key=lambda number: (
            -math.log(max(rng.random(), 1e-15))
            / max(float(scores.get(number, 0.0)), 1e-12)
        ),
    )


def build_v8_balanced(
    rng: random.Random,
    draws: list[dict],
    red_pool: int,
    red_pick: int,
    blue_pool: int,
    blue_pick: int,
    ticket_count: int = 5,
    red_scores: dict[int, float] | None = None,
    blue_scores: dict[int, float] | None = None,
) -> list[tuple[list[int], list[int]]]:
    """生成红蓝均零重叠的 v8 票组。``draws`` 为接口兼容参数。"""
    del draws
    if ticket_count <= 0:
        raise ValueError("ticket_count 必须为正数")
    if red_pick <= 0 or blue_pick <= 0:
        raise ValueError("red_pick 和 blue_pick 必须为正数")
    if ticket_count * red_pick > red_pool:
        raise ValueError("号码池不足以实现前区零重叠")
    if ticket_count * blue_pick > blue_pool:
        raise ValueError("号码池不足以实现后区零重叠")

    red_order = _weighted_permutation(rng, red_pool, red_scores)
    blue_order = _weighted_permutation(rng, blue_pool, blue_scores)
    reds = [
        sorted(red_order[index * red_pick:(index + 1) * red_pick])
        for index in range(ticket_count)
    ]
    blues = [
        sorted(blue_order[index * blue_pick:(index + 1) * blue_pick])
        for index in range(ticket_count)
    ]
    return list(zip(reds, blues))


def portfolio_diagnostics(
    tickets: list[tuple[list[int], list[int]]],
) -> dict[str, int]:
    red_sets = [set(reds) for reds, _ in tickets]
    blue_sets = [set(blues) for _, blues in tickets]
    max_red_overlap = max(
        (len(red_sets[i] & red_sets[j])
         for i in range(len(tickets))
         for j in range(i + 1, len(tickets))),
        default=0,
    )
    max_blue_overlap = max(
        (len(blue_sets[i] & blue_sets[j])
         for i in range(len(tickets))
         for j in range(i + 1, len(tickets))),
        default=0,
    )
    return {
        "red_coverage": len(set().union(*red_sets)) if red_sets else 0,
        "blue_coverage": len(set().union(*blue_sets)) if blue_sets else 0,
        "max_red_overlap": max_red_overlap,
        "max_blue_overlap": max_blue_overlap,
    }
