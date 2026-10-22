"""双色球 v9 小概率事件过滤式零重叠组合生成器。

v9 保留 v8 的 30 个不同红球与 5 个不同蓝球覆盖，并按固定优先级排除：

1. 与历史开奖完全相同的 6 红 + 1 蓝组合；
2. 蓝球与上一期相同；
3. 红球四连号及以上；
4. 全奇或全偶、六球落在同一区；
5. 组合数学分布最外侧的和值与小跨度尾部。

所有阈值在回测前固定，不使用目标期开奖结果。过滤并不改变某一张固定彩票的
理论中奖概率；这个模块的目的，是让这些规则可以接受严格的独立历史检验。
"""

from __future__ import annotations

import random
from dataclasses import asdict, dataclass
from hashlib import sha256
from typing import Iterable


ALGORITHM_NAME = "ssq-v9"
SEED_NAMESPACE = "v9-low-prob-filter"


@dataclass(frozen=True)
class V9FilterConfig:
    max_consecutive_run: int = 3
    min_odd_count: int = 1
    max_odd_count: int = 5
    max_single_zone_count: int = 5
    min_red_sum: int = 53
    max_red_sum: int = 151
    min_red_span: int = 12
    avoid_previous_blue: bool = True
    avoid_historical_full_ticket: bool = True
    max_portfolio_attempts: int = 10000


DEFAULT_FILTER_CONFIG = V9FilterConfig()


FILTER_PRIORITY = (
    "historical_full_ticket",
    "previous_blue",
    "four_or_more_consecutive_reds",
    "all_odd_or_all_even",
    "all_six_in_one_zone",
    "outer_one_percent_sum_tail",
    "small_span_one_percent_tail",
)


def v9_seed(issue: str, replicate: int = 0) -> int:
    payload = f"{SEED_NAMESPACE}|ssq|{issue}|{replicate}".encode("utf-8")
    return int.from_bytes(sha256(payload).digest()[:8], "big")


def v9_rng(issue: str, replicate: int = 0) -> random.Random:
    return random.Random(v9_seed(issue, replicate))


def longest_consecutive_run(reds: Iterable[int]) -> int:
    values = sorted(int(value) for value in reds)
    longest = current = 1
    for previous, value in zip(values, values[1:]):
        current = current + 1 if value == previous + 1 else 1
        longest = max(longest, current)
    return longest


def red_filter_reasons(
    reds: Iterable[int],
    config: V9FilterConfig = DEFAULT_FILTER_CONFIG,
) -> list[str]:
    values = sorted(int(value) for value in reds)
    if len(values) != 6 or len(set(values)) != 6:
        raise ValueError("双色球红球必须是6个不同号码")
    reasons = []
    if longest_consecutive_run(values) > config.max_consecutive_run:
        reasons.append("four_or_more_consecutive_reds")
    odd_count = sum(value % 2 for value in values)
    if not config.min_odd_count <= odd_count <= config.max_odd_count:
        reasons.append("all_odd_or_all_even")
    zones = (
        sum(value <= 11 for value in values),
        sum(12 <= value <= 22 for value in values),
        sum(value >= 23 for value in values),
    )
    if max(zones) > config.max_single_zone_count:
        reasons.append("all_six_in_one_zone")
    red_sum = sum(values)
    if not config.min_red_sum <= red_sum <= config.max_red_sum:
        reasons.append("outer_one_percent_sum_tail")
    if values[-1] - values[0] < config.min_red_span:
        reasons.append("small_span_one_percent_tail")
    return reasons


def full_ticket_key(reds: Iterable[int], blue: int) -> tuple[int, ...]:
    return (*sorted(int(value) for value in reds), int(blue))


def historical_full_ticket_keys(draws: Iterable[dict]) -> set[tuple[int, ...]]:
    return {
        full_ticket_key(
            [row[f"r{index}"] for index in range(1, 7)], row["b1"])
        for row in draws
    }


def build_v9_filtered(
    rng: random.Random,
    draws: list[dict],
    ticket_count: int = 5,
    *,
    config: V9FilterConfig = DEFAULT_FILTER_CONFIG,
    seen_full_tickets: set[tuple[int, ...]] | None = None,
    return_metadata: bool = False,
) -> list[tuple[list[int], list[int]]] | tuple[
    list[tuple[list[int], list[int]]], dict
]:
    """Generate a five-ticket zero-overlap SSQ portfolio under fixed v9 gates."""
    if ticket_count <= 0 or ticket_count * 6 > 33:
        raise ValueError("ticket_count 无法满足红球零重叠约束")
    if ticket_count > 15 and config.avoid_previous_blue and draws:
        raise ValueError("排除上期蓝球后号码池不足")
    if ticket_count > 16:
        raise ValueError("ticket_count 无法满足蓝球零重叠约束")

    previous_blue = int(draws[-1]["b1"]) if draws else None
    if seen_full_tickets is None:
        seen_full_tickets = historical_full_ticket_keys(draws)

    blue_pool = list(range(1, 17))
    if config.avoid_previous_blue and previous_blue is not None:
        blue_pool.remove(previous_blue)

    rejected_portfolios = 0
    rejected_red_tickets = 0
    rejected_historical_tickets = 0
    last_reasons: list[str] = []
    for attempt in range(1, config.max_portfolio_attempts + 1):
        red_order = list(range(1, 34))
        rng.shuffle(red_order)
        reds = [
            sorted(red_order[index * 6:(index + 1) * 6])
            for index in range(ticket_count)
        ]
        reason_lists = [red_filter_reasons(ticket, config) for ticket in reds]
        if any(reason_lists):
            rejected_portfolios += 1
            rejected_red_tickets += sum(bool(reasons) for reasons in reason_lists)
            last_reasons = [reason for reasons in reason_lists for reason in reasons]
            continue

        blue_order = list(blue_pool)
        rng.shuffle(blue_order)
        blues = blue_order[:ticket_count]
        tickets = [(reds[index], [blues[index]]) for index in range(ticket_count)]
        if (config.avoid_historical_full_ticket
                and any(full_ticket_key(red, blue[0]) in seen_full_tickets
                        for red, blue in tickets)):
            rejected_portfolios += 1
            rejected_historical_tickets += 1
            last_reasons = ["historical_full_ticket"]
            continue

        metadata = {
            "strategy": "low_probability_filter_v9",
            "filter_priority": list(FILTER_PRIORITY),
            "filter_config": asdict(config),
            "previous_blue_excluded": previous_blue,
            "attempts": attempt,
            "rejected_portfolios": rejected_portfolios,
            "rejected_red_tickets": rejected_red_tickets,
            "rejected_historical_tickets": rejected_historical_tickets,
            "red_coverage": len({value for red, _ in tickets for value in red}),
            "blue_coverage": len({value for _, blue in tickets for value in blue}),
            "max_red_overlap": max(
                len(set(tickets[left][0]) & set(tickets[right][0]))
                for left in range(ticket_count)
                for right in range(left + 1, ticket_count)
            ) if ticket_count > 1 else 0,
            "max_blue_overlap": 0,
        }
        return (tickets, metadata) if return_metadata else tickets

    raise RuntimeError(
        "v9在最大尝试次数内未生成合格票组；最后拒绝原因："
        + ",".join(last_reasons))


__all__ = [
    "ALGORITHM_NAME",
    "DEFAULT_FILTER_CONFIG",
    "FILTER_PRIORITY",
    "V9FilterConfig",
    "build_v9_filtered",
    "full_ticket_key",
    "historical_full_ticket_keys",
    "longest_consecutive_run",
    "red_filter_reasons",
    "v9_rng",
    "v9_seed",
]
