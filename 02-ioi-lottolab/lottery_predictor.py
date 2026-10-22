"""Statistically honest lottery recommendations and portfolio coverage.

Every valid full ticket has the same jackpot probability in a fair draw.  This
module therefore does not turn historical noise into a claimed probability
edge.  Historical data is used for descriptive, strongly-shrunk estimates;
recommendations are deterministic uniform samples whose *portfolio* is chosen
to reduce overlap between tickets.
"""

from __future__ import annotations

from hashlib import sha256
from math import comb, log
import random

from quant_models import deploy_probabilities


def _seed(analyzer, game):
    latest = analyzer.draws[-1].get("issue", "") if analyzer.draws else ""
    payload = f"{game}|{latest}|{analyzer.n}|coverage-v2".encode("utf-8")
    return int.from_bytes(sha256(payload).digest()[:8], "big")


def _draw_ticket(rng, red_pool, red_pick, blue_pool, blue_pick):
    return (tuple(sorted(rng.sample(range(1, red_pool + 1), red_pick))),
            tuple(sorted(rng.sample(range(1, blue_pool + 1), blue_pick))))


def _weighted_permutation(rng, pool_size, probabilities):
    """Plackett-Luce style permutation; uniform probabilities give a shuffle."""
    if probabilities is None:
        values = list(range(1, pool_size + 1))
        rng.shuffle(values)
        return values
    return sorted(
        range(1, pool_size + 1),
        key=lambda n: -log(max(rng.random(), 1e-15))
        / max(probabilities[n], 1e-12),
    )


def _coverage_portfolio(rng, red_pool, red_pick, blue_pool, blue_pick,
                        ticket_count, red_probabilities=None,
                        blue_probabilities=None):
    """Choose distinct tickets with low red and blue overlap.

    Candidates remain uniform valid tickets.  Coverage affects the relationship
    between recommended tickets, not the claimed probability of any one ticket.
    """
    # The GUI currently requests five tickets.  Both games have enough numbers
    # to partition them into completely disjoint red and blue selections, which
    # is the exact maximum-coverage solution and is much cheaper than search.
    if (red_pick * ticket_count <= red_pool
            and blue_pick * ticket_count <= blue_pool):
        reds = _weighted_permutation(rng, red_pool, red_probabilities)
        blues = _weighted_permutation(rng, blue_pool, blue_probabilities)
        return [
            (tuple(sorted(reds[i * red_pick:(i + 1) * red_pick])),
             tuple(sorted(blues[i * blue_pick:(i + 1) * blue_pick])))
            for i in range(ticket_count)
        ]

    # Generic fallback for larger portfolios where some overlap is unavoidable.
    chosen = [_draw_ticket(rng, red_pool, red_pick, blue_pool, blue_pick)]
    while len(chosen) < ticket_count:
        candidates = {
            _draw_ticket(rng, red_pool, red_pick, blue_pool, blue_pick)
            for _ in range(2500)
        }
        candidates.difference_update(chosen)

        def objective(ticket):
            reds, blues = map(set, ticket)
            red_ov = [len(reds & set(old_r)) for old_r, _ in chosen]
            blue_ov = [len(blues & set(old_b)) for _, old_b in chosen]
            return (sum(blue_ov), max(red_ov), sum(x * x for x in red_ov),
                    sum(red_ov), ticket)

        chosen.append(min(candidates, key=objective))
    return chosen


def build_prediction(analyzer, *, game, red_pool, red_pick, blue_pool,
                     blue_pick, feature_func, recent=50, ticket_count=5,
                     use_quant_gate=True):
    if analyzer.n < 10:
        return None

    recent = min(max(int(recent), 1), analyzer.n)
    if use_quant_gate:
        red_scores, red_gate = deploy_probabilities(
            analyzer.reds_seq, red_pool, red_pick)
        blue_scores, blue_gate = deploy_probabilities(
            analyzer.blues_seq, blue_pool, blue_pick)
    else:
        red_scores = {n: red_pick / red_pool for n in range(1, red_pool + 1)}
        blue_scores = {n: blue_pick / blue_pool for n in range(1, blue_pool + 1)}
        red_gate = blue_gate = {
            "selected_model": "uniform", "gate_passed": False,
            "reason": "覆盖层回测固定使用等概率；量化信号由quant_research.py单独做样本外检验",
            "candidates": [],
        }

    rng = random.Random(_seed(analyzer, game))
    tickets = _coverage_portfolio(
        rng, red_pool, red_pick, blue_pool, blue_pick, ticket_count,
        red_scores if red_gate["gate_passed"] else None,
        blue_scores if blue_gate["gate_passed"] else None)
    primary_r, primary_b = tickets[0]

    sum_dist = analyzer.sum_distribution()
    span_dist = analyzer.span_distribution()
    zone_dist = analyzer.zone_ratio_dist()
    oe_dist = analyzer.odd_even_dist()
    sum_lo = max(sum_dist, key=sum_dist.get)
    span_lo = max(span_dist, key=span_dist.get)
    zone_mode = next(iter(zone_dist))
    oe_mode = next(iter(oe_dist))

    alternatives = []
    for reds, _ in tickets[1:]:
        f = feature_func(reds)
        alternatives.append((reds, 0.0, f))

    total = comb(red_pool, red_pick) * comb(blue_pool, blue_pick)
    portfolio_prob = len(tickets) / total
    reasons = [
        "【量化门控】候选算法包括贝叶斯频率、EWMA动量/均值回归、短长周期交叉、Markov状态和遗漏回归。",
        f"【前区检验】部署模型：{red_gate['selected_model']}；{red_gate['reason']}。",
        f"【后区检验】部署模型：{blue_gate['selected_model']}；{blue_gate['reason']}。",
        "【覆盖优化】推荐票之间尽量减少前区重叠，并优先使用不同后区号码，以减少多注押在同一结果区域。",
        f"【概率】任一指定单注的一等奖概率为 1/{total:,}；{len(tickets)} 注互不重复票的一等奖概率为 "
        f"{len(tickets)}/{total:,}（约 {portfolio_prob:.10%}）。",
        "【限制】开奖若独立且公平，历史数据不能提高某一指定号码组合的开奖概率；增加互不重复注数才会线性提高一等奖覆盖率。",
        "【完整推荐票】",
    ]
    for i, (reds, blues) in enumerate(tickets, 1):
        reasons.append(
            f"  第{i}注：{' '.join(f'{n:02d}' for n in reds)} + "
            f"{' '.join(f'{n:02d}' for n in blues)}")

    return {
        "reds": list(primary_r),
        "blues": list(primary_b),
        "tickets": [(list(r), list(b)) for r, b in tickets],
        "alternatives": alternatives,
        "red_scores": red_scores,
        "blue_scores": blue_scores,
        "red_omission": analyzer.red_omission(),
        "blue_omission": analyzer.blue_omission(),
        "forecast": {
            "sum_range": f"{sum_lo}-{sum_lo + 9}",
            "span_range": f"{span_lo}-{span_lo + 4}",
            "zone_mode": zone_mode,
            "odd_even_mode": oe_mode,
            "sum_dist": sum_dist,
            "span_dist": span_dist,
            "zone_dist": zone_dist,
            "oe_dist": oe_dist,
        },
        "reasons": reasons,
        "sample_size": analyzer.n,
        "recent_window": recent,
        "jackpot_total_combinations": total,
        "portfolio_jackpot_probability": portfolio_prob,
        "model": "quant-gated-coverage-v3",
        "quant_diagnostics": {"red": red_gate, "blue": blue_gate},
    }
