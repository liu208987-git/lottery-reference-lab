"""V12有限样本模型与V8：从双色球第二期开始的严格逐期回测。"""

from __future__ import annotations

import json
import math
from collections import Counter

import ssq_db
from app_paths import DATA_ROOT
from ssq_prediction_audit import PRIZE_RANK, evaluate_tickets
from v8_predictor import build_v8_balanced, v8_rng
from v12_predictor import V12OnlineForecaster, build_v12_portfolio, v12_rng


FIXED_PRIZE = {"三等奖": 3000, "四等奖": 200, "五等奖": 10, "六等奖": 5}
PRIZES = ["一等奖", "二等奖", "三等奖", "四等奖", "五等奖", "六等奖"]


def _period(tickets, draw):
    actual_reds = [int(draw[f"r{index}"]) for index in range(1, 7)]
    result = evaluate_tickets(tickets, actual_reds, int(draw["b1"]))
    ticket_prizes = Counter(
        detail["prize"] for detail in result["details"] if detail["prize"]
    )
    best = min(ticket_prizes, key=lambda name: PRIZE_RANK[name]) if ticket_prizes else None
    return {
        "issue": str(draw["issue"]),
        "best_prize": best,
        "ticket_prizes": dict(ticket_prizes),
        "any_prize": int(best is not None),
        "blue_covered": int(result["blue_covered"]),
        "red_ge5": int(result["max_red_hits"] >= 5),
        "red_ge4": int(result["max_red_hits"] >= 4),
        "red_ge3": int(result["max_red_hits"] >= 3),
        "max_red": int(result["max_red_hits"]),
        "fixed_return": sum(
            FIXED_PRIZE.get(name, 0) * count
            for name, count in ticket_prizes.items()
        ),
        "details": result["details"] if result["max_red_hits"] >= 4 else [],
    }


def _summary(rows):
    total = len(rows)
    best = Counter(row["best_prize"] for row in rows if row["best_prize"])
    tickets = Counter()
    for row in rows:
        tickets.update(row["ticket_prizes"])
    cost = total * 10
    fixed_return = sum(row["fixed_return"] for row in rows)
    return {
        "periods": total,
        "best_prize_period_counts": {name: best.get(name, 0) for name in PRIZES},
        "winning_ticket_prize_counts": {name: tickets.get(name, 0) for name in PRIZES},
        "winning_periods": sum(row["any_prize"] for row in rows),
        "winning_period_rate": sum(row["any_prize"] for row in rows) / total,
        "blue_covered": sum(row["blue_covered"] for row in rows),
        "blue_coverage_rate": sum(row["blue_covered"] for row in rows) / total,
        "red_ge5": sum(row["red_ge5"] for row in rows),
        "red_ge5_rate": sum(row["red_ge5"] for row in rows) / total,
        "red_ge4": sum(row["red_ge4"] for row in rows),
        "red_ge4_rate": sum(row["red_ge4"] for row in rows) / total,
        "red_ge3": sum(row["red_ge3"] for row in rows),
        "red_ge3_rate": sum(row["red_ge3"] for row in rows) / total,
        "average_max_red": sum(row["max_red"] for row in rows) / total,
        "cost": cost,
        "fixed_return": fixed_return,
        "fixed_roi": fixed_return / cost,
        "fixed_net": fixed_return - cost,
        "red_ge4_issues": [
            {"issue": row["issue"], "best_prize": row["best_prize"], "details": row["details"]}
            for row in rows if row["red_ge4"]
        ],
    }


def _mcnemar(left_rows, right_rows):
    left_only = sum(
        left["any_prize"] and not right["any_prize"]
        for left, right in zip(left_rows, right_rows)
    )
    right_only = sum(
        right["any_prize"] and not left["any_prize"]
        for left, right in zip(left_rows, right_rows)
    )
    trials = left_only + right_only
    if trials == 0:
        p_value = 1.0
    else:
        low = min(left_only, right_only)
        logs = [
            math.lgamma(trials + 1) - math.lgamma(k + 1)
            - math.lgamma(trials - k + 1) - trials * math.log(2)
            for k in range(low + 1)
        ]
        largest = max(logs)
        p_value = min(
            1.0,
            2.0 * math.exp(largest) * sum(math.exp(value - largest) for value in logs),
        )
    return {
        "v12_only": left_only,
        "v8_only": right_only,
        "two_sided_p": p_value,
    }


def _binomial_two_sided(trials: int, observed: int, probability: float) -> float:
    def log_pmf(value):
        return (
            math.lgamma(trials + 1) - math.lgamma(value + 1)
            - math.lgamma(trials - value + 1)
            + value * math.log(probability)
            + (trials - value) * math.log1p(-probability)
        )

    observed_log = log_pmf(observed)
    selected = [log_pmf(value) for value in range(trials + 1)
                if log_pmf(value) <= observed_log + 1e-12]
    largest = max(selected)
    return min(1.0, math.exp(largest) * sum(math.exp(value - largest) for value in selected))


def _red_bce(probabilities, actual_reds):
    total = 0.0
    for number, probability in enumerate(probabilities, 1):
        probability = min(1 - 1e-12, max(1e-12, probability))
        observed = 1.0 if number in actual_reds else 0.0
        total -= observed * math.log(probability) + (1 - observed) * math.log1p(-probability)
    return total / 33


def run():
    draws = ssq_db.get_all_draws("ASC")
    if len(draws) < 2:
        raise ValueError("双色球历史不足2期")
    model = V12OnlineForecaster()
    model.observe(draws[0])
    v8_rows, v12_rows = [], []
    signal_rows = []
    portfolio_rows = []
    final_model_metadata = None

    uniform_red = [6 / 33] * 33
    uniform_blue_logloss = math.log(16)
    for index in range(1, len(draws)):
        target = draws[index]
        issue = str(target["issue"])
        red_probabilities, blue_probabilities, model_metadata = model.probabilities()
        tickets12, portfolio_metadata = build_v12_portfolio(
            v12_rng(issue), red_probabilities, blue_probabilities,
            return_metadata=True,
        )
        tickets8 = build_v8_balanced(
            v8_rng("ssq", issue), [], 33, 6, 16, 1, 5
        )
        v12_rows.append(_period(tickets12, target))
        v8_rows.append(_period(tickets8, target))

        actual_reds = {int(target[f"r{position}"]) for position in range(1, 7)}
        actual_blue = int(target["b1"])
        top5_blue = sorted(
            range(1, 17), key=lambda number: (-blue_probabilities[number - 1], number)
        )[:5]
        signal_rows.append({
            "red_bce": _red_bce(red_probabilities, actual_reds),
            "uniform_red_bce": _red_bce(uniform_red, actual_reds),
            "blue_logloss": -math.log(max(blue_probabilities[actual_blue - 1], 1e-12)),
            "uniform_blue_logloss": uniform_blue_logloss,
            "top5_blue_hit": int(actual_blue in top5_blue),
            "top5_blue_mass": sum(blue_probabilities[number - 1] for number in top5_blue),
        })
        portfolio_rows.append(portfolio_metadata)
        final_model_metadata = model_metadata
        model.observe(target)
        if index % 500 == 0:
            print(f"已回测 {index}/{len(draws)-1}")

    total = len(signal_rows)
    signal = {
        "periods": total,
        "red_bce": sum(row["red_bce"] for row in signal_rows) / total,
        "uniform_red_bce": sum(row["uniform_red_bce"] for row in signal_rows) / total,
        "blue_logloss": sum(row["blue_logloss"] for row in signal_rows) / total,
        "uniform_blue_logloss": uniform_blue_logloss,
        "top5_blue_hits": sum(row["top5_blue_hit"] for row in signal_rows),
        "top5_blue_hit_rate": sum(row["top5_blue_hit"] for row in signal_rows) / total,
        "uniform_top5_blue_rate": 5 / 16,
        "top5_blue_two_sided_p": _binomial_two_sided(
            total, sum(row["top5_blue_hit"] for row in signal_rows), 5 / 16
        ),
        "average_top5_blue_model_mass": sum(
            row["top5_blue_mass"] for row in signal_rows
        ) / total,
        "final_model_metadata_before_last_draw": final_model_metadata,
    }
    blocks = []
    for block in range(10):
        begin, end = block * total // 10, (block + 1) * total // 10
        blocks.append({
            "issue_from": v8_rows[begin]["issue"],
            "issue_to": v8_rows[end - 1]["issue"],
            "v8_winning_rate": sum(row["any_prize"] for row in v8_rows[begin:end]) / (end - begin),
            "v12_winning_rate": sum(row["any_prize"] for row in v12_rows[begin:end]) / (end - begin),
            "v8_red_ge4": sum(row["red_ge4"] for row in v8_rows[begin:end]),
            "v12_red_ge4": sum(row["red_ge4"] for row in v12_rows[begin:end]),
        })
    # 生产仪表盘从历史第301期开始（前300期只作训练），其3176期口径
    # 与本脚本“从第二期开始”的3475期主口径不同，单独输出以便直接对齐。
    production_offset = 300 - 1
    production_v8 = _summary(v8_rows[production_offset:])
    production_v12 = _summary(v12_rows[production_offset:])
    production_v8.pop("red_ge4_issues", None)
    production_v12.pop("red_ge4_issues", None)

    total_outcomes = math.comb(33, 6) * 16
    high_probability = 5 * 178 / total_outcomes
    return {
        "method": {
            "walk_forward": True,
            "no_future_data": True,
            "first_history_issue": str(draws[0]["issue"]),
            "first_predicted_issue": str(draws[1]["issue"]),
            "last_predicted_issue": str(draws[-1]["issue"]),
            "periods": len(draws) - 1,
            "tickets_per_period": 5,
            "v12_model": "low-dimensional marginal Bayesian shrinkage + online Hedge windows",
            "v12_portfolio": "model score + diversity; pairwise red overlap <= 3; five distinct blues",
        },
        "v8": _summary(v8_rows),
        "v12": _summary(v12_rows),
        "production_window_comparison": {
            "reason": "matches dashboard backfill minimum training history of 300 draws",
            "first_predicted_issue": str(draws[300]["issue"]),
            "last_predicted_issue": str(draws[-1]["issue"]),
            "periods": len(draws) - 300,
            "v8": production_v8,
            "v12": production_v12,
        },
        "paired_winning_test": _mcnemar(v12_rows, v8_rows),
        "signal_validation": signal,
        "portfolio": {
            "average_red_coverage": sum(row["red_coverage"] for row in portfolio_rows) / total,
            "min_red_coverage": min(row["red_coverage"] for row in portfolio_rows),
            "max_red_overlap": max(row["max_red_overlap"] for row in portfolio_rows),
            "all_periods_preserved_third_plus_bound": all(
                row["third_plus_upper_bound_preserved"] for row in portfolio_rows
            ),
        },
        "time_blocks": blocks,
        "theory": {
            "five_ticket_third_or_above_probability": high_probability,
            "five_ticket_third_or_above_odds_one_in": 1 / high_probability,
        },
    }


def render(report):
    v8, v12 = report["v8"], report["v12"]
    paired, signal = report["paired_winning_test"], report["signal_validation"]
    lines = [
        "# 双色球V12有限样本算法：全历史逐期回测",
        "",
        "## 严格口径",
        "",
        f"第一期{report['method']['first_history_issue']}只作为已知历史，预测{report['method']['first_predicted_issue']}；随后每期开奖后更新模型，再预测下一期，直到{report['method']['last_predicted_issue']}，共{report['method']['periods']}期。每期固定5注，任何目标期和未来数据均未进入训练。",
        "",
        "V12只使用33个红球边际频率和16个蓝球分类频率，并用贝叶斯收缩与在线多窗口加权控制有限样本噪声；不拟合完整号码组合或高维共现张量。组合层强制任意两注红球交集不超过3、蓝球5个互不相同。",
        "",
        "## 每期最高奖级次数（主口径）",
        "",
        "| 奖级 | V8五注 | V12五注 | V12-V8 |",
        "|---|---:|---:|---:|",
    ]
    for prize in PRIZES:
        left = v8["best_prize_period_counts"][prize]
        right = v12["best_prize_period_counts"][prize]
        lines.append(f"| {prize} | {left} | {right} | {right-left:+d} |")
    lines.extend([
        "",
        "## 所有中奖彩票张数（辅助口径）",
        "",
        "| 奖级 | V8 | V12 | V12-V8 |",
        "|---|---:|---:|---:|",
    ])
    for prize in PRIZES:
        left = v8["winning_ticket_prize_counts"][prize]
        right = v12["winning_ticket_prize_counts"][prize]
        lines.append(f"| {prize} | {left} | {right} | {right-left:+d} |")
    lines.extend([
        "",
        "## 汇总",
        "",
        "| 指标 | V8 | V12 |",
        "|---|---:|---:|",
        f"| 中奖期数 | {v8['winning_periods']} ({v8['winning_period_rate']:.3%}) | {v12['winning_periods']} ({v12['winning_period_rate']:.3%}) |",
        f"| 至少5红 | {v8['red_ge5']} ({v8['red_ge5_rate']:.3%}) | {v12['red_ge5']} ({v12['red_ge5_rate']:.3%}) |",
        f"| 至少4红 | {v8['red_ge4']} ({v8['red_ge4_rate']:.3%}) | {v12['red_ge4']} ({v12['red_ge4_rate']:.3%}) |",
        f"| 至少3红 | {v8['red_ge3']} ({v8['red_ge3_rate']:.3%}) | {v12['red_ge3']} ({v12['red_ge3_rate']:.3%}) |",
        f"| 蓝球覆盖 | {v8['blue_covered']} ({v8['blue_coverage_rate']:.3%}) | {v12['blue_covered']} ({v12['blue_coverage_rate']:.3%}) |",
        f"| 固定奖金 | {v8['fixed_return']}元 | {v12['fixed_return']}元 |",
        f"| 固定奖金回报率 | {v8['fixed_roi']:.3%} | {v12['fixed_roi']:.3%} |",
        "",
        "## 与生产仪表盘完全相同的3176期口径",
        "",
        f"仪表盘从{report['production_window_comparison']['first_predicted_issue']}开始，前300期只作为训练数据。以下数据可与界面逐项直接比较。",
        "",
        "| 指标 | V8 | V12 |",
        "|---|---:|---:|",
        f"| 回测期数 | {report['production_window_comparison']['v8']['periods']} | {report['production_window_comparison']['v12']['periods']} |",
        f"| 至少4红 | {report['production_window_comparison']['v8']['red_ge4']} ({report['production_window_comparison']['v8']['red_ge4_rate']:.3%}) | {report['production_window_comparison']['v12']['red_ge4']} ({report['production_window_comparison']['v12']['red_ge4_rate']:.3%}) |",
        f"| 至少3红 | {report['production_window_comparison']['v8']['red_ge3']} ({report['production_window_comparison']['v8']['red_ge3_rate']:.3%}) | {report['production_window_comparison']['v12']['red_ge3']} ({report['production_window_comparison']['v12']['red_ge3_rate']:.3%}) |",
        f"| 蓝球覆盖 | {report['production_window_comparison']['v8']['blue_covered']} ({report['production_window_comparison']['v8']['blue_coverage_rate']:.3%}) | {report['production_window_comparison']['v12']['blue_covered']} ({report['production_window_comparison']['v12']['blue_coverage_rate']:.3%}) |",
        f"| 中奖期数 | {report['production_window_comparison']['v8']['winning_periods']} ({report['production_window_comparison']['v8']['winning_period_rate']:.3%}) | {report['production_window_comparison']['v12']['winning_periods']} ({report['production_window_comparison']['v12']['winning_period_rate']:.3%}) |",
        f"| 四等奖 | {report['production_window_comparison']['v8']['best_prize_period_counts']['四等奖']} | {report['production_window_comparison']['v12']['best_prize_period_counts']['四等奖']} |",
        f"| 五等奖 | {report['production_window_comparison']['v8']['best_prize_period_counts']['五等奖']} | {report['production_window_comparison']['v12']['best_prize_period_counts']['五等奖']} |",
        f"| 六等奖 | {report['production_window_comparison']['v8']['best_prize_period_counts']['六等奖']} | {report['production_window_comparison']['v12']['best_prize_period_counts']['六等奖']} |",
        "",
        "## 有限样本信号是否存在",
        "",
        f"- 红球边际概率平均对数损失：V12={signal['red_bce']:.6f}，无信息基准={signal['uniform_red_bce']:.6f}（越低越好）。",
        f"- 蓝球平均对数损失：V12={signal['blue_logloss']:.6f}，无信息基准={signal['uniform_blue_logloss']:.6f}（越低越好）。",
        f"- V12蓝球Top5命中：{signal['top5_blue_hits']}/{signal['periods']}={signal['top5_blue_hit_rate']:.3%}；均匀基准31.250%，双侧p={signal['top5_blue_two_sided_p']:.4f}。",
        "",
        "## 配对结论",
        "",
        f"V12独中而V8未中{paired['v12_only']}期，V8独中而V12未中{paired['v8_only']}期；任意奖配对McNemar双侧p={paired['two_sided_p']:.4f}。",
        f"两者均保持5注三等奖及以上理论最大覆盖：单期{report['theory']['five_ticket_third_or_above_probability']:.6%}，约1/{report['theory']['five_ticket_third_or_above_odds_one_in']:.1f}。",
        "",
        "## 十等分稳定性",
        "",
        "| 区间 | V8中奖率 | V12中奖率 | V8≥4红 | V12≥4红 |",
        "|---|---:|---:|---:|---:|",
    ])
    for block in report["time_blocks"]:
        lines.append(
            f"| {block['issue_from']}～{block['issue_to']} | "
            f"{block['v8_winning_rate']:.3%} | {block['v12_winning_rate']:.3%} | "
            f"{block['v8_red_ge4']} | {block['v12_red_ge4']} |"
        )
    lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    result = run()
    (DATA_ROOT / "v12_backtest_results.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (DATA_ROOT / "v12_backtest_report.md").write_text(
        render(result), encoding="utf-8"
    )
    print("V12回测完成")
