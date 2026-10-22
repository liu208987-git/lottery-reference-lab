"""双色球10注高奖覆盖v10的全历史走期回测。"""

from __future__ import annotations

import argparse
import json
import math
import random
from collections import Counter
from datetime import datetime
from hashlib import sha256
from pathlib import Path
from statistics import fmean

import ssq_db
from app_paths import DATA_ROOT
from ssq_prediction_audit import evaluate_tickets, prize_level
from v8_predictor import build_v8_balanced, v8_rng
from v10_predictor import (
    FAVORABLE_OUTCOMES_PER_TICKET,
    TOTAL_OUTCOMES,
    build_v10_high_prize,
    high_prize_favorable_outcomes,
    v10_rng,
)


START_INDEX = 300
FIXED_PRIZE = {"三等奖": 3000, "四等奖": 200, "五等奖": 10, "六等奖": 5}


def _seed(issue: str, replicate: int, name: str) -> int:
    payload = f"v10-backtest|{name}|{issue}|{replicate}".encode()
    return int.from_bytes(sha256(payload).digest()[:8], "big")


def _uniform10(rng: random.Random):
    tickets = []
    seen = set()
    while len(tickets) < 10:
        reds = sorted(rng.sample(range(1, 34), 6))
        blue = rng.randint(1, 16)
        key = tuple(reds), blue
        if key not in seen:
            seen.add(key)
            tickets.append((reds, [blue]))
    return tickets


def _metrics(tickets, row):
    reds = [row[f"r{i}"] for i in range(1, 7)]
    result = evaluate_tickets(tickets, reds, row["b1"])
    prizes = Counter(d["prize"] for d in result["details"] if d["prize"])
    fixed_return = sum(FIXED_PRIZE.get(name, 0) * count for name, count in prizes.items())
    best = result["best_prize"]
    return {
        "third_plus": int(best is not None and best <= 3),
        "fourth_plus": int(best is not None and best <= 4),
        "any_prize": int(result["winning_tickets"] > 0),
        "blue_covered": int(result["blue_covered"]),
        "red_ge4": int(result["max_red_hits"] >= 4),
        "red_ge3": int(result["max_red_hits"] >= 3),
        "max_red": result["max_red_hits"],
        "winning_tickets": result["winning_tickets"],
        "fixed_return": fixed_return,
        "prizes": dict(prizes),
    }


def _summary(rows, ticket_count):
    n = len(rows)
    rates = ("third_plus", "fourth_plus", "any_prize", "blue_covered", "red_ge4", "red_ge3")
    prizes = Counter()
    for row in rows:
        prizes.update(row["prizes"])
    cost = n * ticket_count * 2
    returns = sum(row["fixed_return"] for row in rows)
    return {
        "periods": n,
        **{key: fmean(row[key] for row in rows) for key in rates},
        "counts": {key: sum(row[key] for row in rows) for key in rates},
        "average_max_red": fmean(row["max_red"] for row in rows),
        "average_winning_tickets": fmean(row["winning_tickets"] for row in rows),
        "prize_counts": dict(prizes),
        "cost": cost,
        "fixed_return": returns,
        "fixed_roi": returns / cost,
        "net": returns - cost,
    }


def _run(draws, replicate=0, production=False):
    rows = {"v8_5": [], "uniform_10": [], "v10_10": []}
    for i in range(START_INDEX, len(draws)):
        issue = str(draws[i]["issue"])
        rng8 = v8_rng("ssq", issue, replicate) if production else random.Random(_seed(issue, replicate, "v8"))
        rngu = random.Random(_seed(issue, replicate, "uniform"))
        rng10 = v10_rng(issue, replicate) if production else random.Random(_seed(issue, replicate, "v10"))
        tickets8 = build_v8_balanced(rng8, [], 33, 6, 16, 1, 5)
        ticketsu = _uniform10(rngu)
        tickets10 = build_v10_high_prize(rng10, candidate_portfolios=32)
        rows["v8_5"].append(_metrics(tickets8, draws[i]))
        rows["uniform_10"].append(_metrics(ticketsu, draws[i]))
        rows["v10_10"].append(_metrics(tickets10, draws[i]))
    return rows


def _expected_fixed_roi():
    total_red = math.comb(33, 6)
    expected = 0.0
    for red_hits in range(7):
        red_ways = math.comb(6, red_hits) * math.comb(27, 6 - red_hits)
        for blue_hits, blue_ways in ((0, 15), (1, 1)):
            prize = prize_level(red_hits, blue_hits)
            expected += red_ways * blue_ways * FIXED_PRIZE.get(prize, 0)
    expected /= total_red * 16
    return {"per_ticket_return": expected, "roi": expected / 2}


def run_backtest(seed_replicates=8):
    draws = ssq_db.get_all_draws("ASC")
    primary = _run(draws, production=True)
    summaries = {
        "v8_5": _summary(primary["v8_5"], 5),
        "uniform_10": _summary(primary["uniform_10"], 10),
        "v10_10": _summary(primary["v10_10"], 10),
    }
    robustness = []
    for replicate in range(seed_replicates):
        run = _run(draws, replicate=replicate)
        uniform = _summary(run["uniform_10"], 10)
        v10 = _summary(run["v10_10"], 10)
        robustness.append({
            "replicate": replicate,
            "third_plus_v10_minus_uniform": v10["third_plus"] - uniform["third_plus"],
            "any_prize_v10_minus_uniform": v10["any_prize"] - uniform["any_prize"],
            "fixed_roi_v10_minus_uniform": v10["fixed_roi"] - uniform["fixed_roi"],
        })

    target = str(int(draws[-1]["issue"]) + 1)
    current, metadata = build_v10_high_prize(v10_rng(target), return_metadata=True)
    p1 = FAVORABLE_OUTCOMES_PER_TICKET / TOTAL_OUTCOMES
    p5 = 5 * p1
    p10 = 10 * p1
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "method": {
            "walk_forward": True,
            "no_future_data": True,
            "periods": len(draws) - START_INDEX,
            "issue_from": draws[START_INDEX]["issue"],
            "issue_to": draws[-1]["issue"],
            "seed_replicates": seed_replicates,
        },
        "theory": {
            "single_ticket_third_plus_probability": p1,
            "five_ticket_upper_probability": p5,
            "five_ticket_odds_one_in": 1 / p5,
            "ten_ticket_upper_probability": p10,
            "ten_ticket_odds_one_in": 1 / p10,
            "ten_ticket_one_year_probability_104_draws": 1 - (1 - p10) ** 104,
            "ten_ticket_expected_wait_draws": 1 / p10,
            "ten_ticket_expected_wait_years_at_104_draws": 1 / p10 / 104,
            "five_to_ten_lift": 2.0,
            "fixed_prize_expectation": _expected_fixed_roi(),
        },
        "primary_results": summaries,
        "seed_robustness": {
            "replicates": robustness,
            "mean_any_prize_v10_minus_uniform": fmean(x["any_prize_v10_minus_uniform"] for x in robustness),
            "mean_fixed_roi_v10_minus_uniform": fmean(x["fixed_roi_v10_minus_uniform"] for x in robustness),
        },
        "current_v10": {"target_issue": target, "tickets": current, "metadata": metadata},
        "conclusion": (
            "v10达到10注三等奖以上组合覆盖的数学上限，但10注概率仍只有约1/9956；"
            "历史样本不足以用三等奖次数区分算法，且增加注数不会改善单注期望回报率。"
        ),
    }


def render_markdown(report):
    t = report["theory"]
    r = report["primary_results"]
    lines = [
        "# 双色球 v10 十注高奖覆盖回测", "",
        f"走期：{report['method']['issue_from']}～{report['method']['issue_to']}，"
        f"{report['method']['periods']}期，无未来数据。", "",
        "## 精确理论", "",
        f"- 单注三等奖以上：{t['single_ticket_third_plus_probability']:.6%}，"
        f"约1/{1/t['single_ticket_third_plus_probability']:.1f}。",
        f"- 5注最优上限：{t['five_ticket_upper_probability']:.6%}，约1/{t['five_ticket_odds_one_in']:.1f}。",
        f"- 10注v10上限：{t['ten_ticket_upper_probability']:.6%}，约1/{t['ten_ticket_odds_one_in']:.1f}。",
        f"- 每年104期固定买10注，至少一次三等奖以上约{t['ten_ticket_one_year_probability_104_draws']:.3%}。",
        f"- 理论平均等待约{t['ten_ticket_expected_wait_years_at_104_draws']:.1f}年。", "",
        "## 3176期主种子回测", "",
        "| 指标 | v8五注 | 普通十注 | v10十注 |", "|---|---:|---:|---:|",
    ]
    for key, label in (("third_plus","三等奖以上"),("fourth_plus","四等奖以上"),
                       ("any_prize","任意中奖"),("blue_covered","蓝球覆盖"),
                       ("red_ge4","≥4红"),("red_ge3","≥3红")):
        lines.append(f"| {label} | {r['v8_5'][key]:.3%} | {r['uniform_10'][key]:.3%} | {r['v10_10'][key]:.3%} |")
    lines.extend([
        f"| 固定奖金回报率 | {r['v8_5']['fixed_roi']:.3%} | {r['uniform_10']['fixed_roi']:.3%} | {r['v10_10']['fixed_roi']:.3%} |",
        "", "三等奖以上极少，3176期历史的实际次数不能代替组合数学精确概率。",
        "所有具体单注的期望回报相同；增加到10注只会同时放大中奖概率和投入。", "",
        f"**结论：{report['conclusion']}**", "",
    ])
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed-replicates", type=int, default=8)
    args = parser.parse_args(argv)
    report = run_backtest(args.seed_replicates)
    (DATA_ROOT / "v10_backtest_results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (DATA_ROOT / "v10_backtest_report.md").write_text(render_markdown(report), encoding="utf-8")
    print(report["conclusion"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
