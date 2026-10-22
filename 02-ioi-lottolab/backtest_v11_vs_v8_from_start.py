"""从第二期开奖开始，对v8五注与v11排序前五注做全历史逐期验证。"""

from __future__ import annotations

import json
import math
from collections import Counter
from pathlib import Path

import ssq_db
from app_paths import DATA_ROOT
from ssq_prediction_audit import PRIZE_RANK, evaluate_tickets
from v8_predictor import build_v8_balanced, v8_rng
from v11_predictor import build_v11_extreme, v11_rng


FIXED_PRIZE = {"三等奖": 3000, "四等奖": 200, "五等奖": 10, "六等奖": 5}


def _period(tickets, draw):
    reds = [draw[f"r{i}"] for i in range(1, 7)]
    result = evaluate_tickets(tickets, reds, draw["b1"])
    ticket_prizes = Counter(
        detail["prize"] for detail in result["details"] if detail["prize"])
    best = None
    if ticket_prizes:
        best = min(ticket_prizes, key=lambda name: PRIZE_RANK[name])
    return {
        "issue": str(draw["issue"]),
        "best_prize": best,
        "ticket_prizes": dict(ticket_prizes),
        "any_prize": int(best is not None),
        "blue_covered": int(result["blue_covered"]),
        "red_ge4": int(result["max_red_hits"] >= 4),
        "red_ge3": int(result["max_red_hits"] >= 3),
        "max_red": result["max_red_hits"],
        "fixed_return": sum(
            FIXED_PRIZE.get(name, 0) * count
            for name, count in ticket_prizes.items()),
    }


def _summary(rows):
    n = len(rows)
    best = Counter(row["best_prize"] for row in rows if row["best_prize"])
    tickets = Counter()
    for row in rows:
        tickets.update(row["ticket_prizes"])
    cost = n * 10
    fixed_return = sum(row["fixed_return"] for row in rows)
    return {
        "periods": n,
        "best_prize_period_counts": dict(best),
        "winning_ticket_prize_counts": dict(tickets),
        "winning_periods": sum(row["any_prize"] for row in rows),
        "winning_period_rate": sum(row["any_prize"] for row in rows) / n,
        "blue_covered": sum(row["blue_covered"] for row in rows),
        "blue_coverage_rate": sum(row["blue_covered"] for row in rows) / n,
        "red_ge4": sum(row["red_ge4"] for row in rows),
        "red_ge4_rate": sum(row["red_ge4"] for row in rows) / n,
        "red_ge3": sum(row["red_ge3"] for row in rows),
        "red_ge3_rate": sum(row["red_ge3"] for row in rows) / n,
        "average_max_red": sum(row["max_red"] for row in rows) / n,
        "cost": cost,
        "fixed_return": fixed_return,
        "fixed_roi": fixed_return / cost,
        "fixed_net": fixed_return - cost,
    }


def _mcnemar(v11_rows, v8_rows):
    v11_only = sum(a["any_prize"] and not b["any_prize"] for a, b in zip(v11_rows, v8_rows))
    v8_only = sum(b["any_prize"] and not a["any_prize"] for a, b in zip(v11_rows, v8_rows))
    n = v11_only + v8_only
    if n == 0:
        p = 1.0
    else:
        low = min(v11_only, v8_only)
        logs = [math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1) - n * math.log(2)
                for k in range(low + 1)]
        largest = max(logs)
        p = min(1.0, 2 * math.exp(largest) * sum(math.exp(x - largest) for x in logs))
    return {"v11_only": v11_only, "v8_only": v8_only, "two_sided_p": p}


def run():
    draws = ssq_db.get_all_draws("ASC")
    v8_rows, v11_rows = [], []
    for index in range(1, len(draws)):
        target = draws[index]
        issue = str(target["issue"])
        history = draws[max(0, index - 100):index]
        tickets8 = build_v8_balanced(v8_rng("ssq", issue), [], 33, 6, 16, 1, 5)
        tickets11 = build_v11_extreme(
            v11_rng(issue), history, 100, rank_current=True)[:5]
        v8_rows.append(_period(tickets8, target))
        v11_rows.append(_period(tickets11, target))
        if index % 500 == 0:
            print(f"已回测 {index}/{len(draws)-1}")

    blocks = []
    n = len(v8_rows)
    for block in range(10):
        begin, end = block * n // 10, (block + 1) * n // 10
        blocks.append({
            "issue_from": v8_rows[begin]["issue"], "issue_to": v8_rows[end - 1]["issue"],
            "v8_winning_rate": sum(x["any_prize"] for x in v8_rows[begin:end]) / (end - begin),
            "v11_winning_rate": sum(x["any_prize"] for x in v11_rows[begin:end]) / (end - begin),
        })
    return {
        "method": {
            "walk_forward": True, "no_future_data": True,
            "first_history_issue": draws[0]["issue"],
            "first_predicted_issue": draws[1]["issue"],
            "last_predicted_issue": draws[-1]["issue"],
            "periods": len(draws) - 1, "tickets_per_period": 5,
            "v11_rule": "generate100, historical secondary rank, buy top5",
        },
        "v8": _summary(v8_rows),
        "v11_top5": _summary(v11_rows),
        "paired_winning_test": _mcnemar(v11_rows, v8_rows),
        "time_blocks": blocks,
        "theory": {
            "both_third_or_above_probability": 5 * 178 / (math.comb(33, 6) * 16),
            "both_third_or_above_odds_one_in": math.comb(33, 6) * 16 / (5 * 178),
        },
    }


def render(report):
    a, b = report["v8"], report["v11_top5"]
    paired = report["paired_winning_test"]
    prizes = ["一等奖", "二等奖", "三等奖", "四等奖", "五等奖", "六等奖"]
    expected_high = (
        report["method"]["periods"]
        * report["theory"]["both_third_or_above_probability"]
    )
    zero_high_probability = (
        1 - report["theory"]["both_third_or_above_probability"]
    ) ** report["method"]["periods"]
    lines = [
        "# V11前5注与V8五注：从历史第二期开始逐期回测",
        "",
        "## 回测口径",
        "",
        f"- 第一期 {report['method']['first_history_issue']} 只作为已知历史，预测第二期；开奖后再把该期加入历史，继续预测下一期。",
        f"- 预测区间：{report['method']['first_predicted_issue']}～{report['method']['last_predicted_issue']}，共 {report['method']['periods']} 期。",
        "- 两个算法每期均固定购买5注；V11每期先生成100注，按当时可见的最近100期历史排序，只取前5注。",
        "- 期号只用于生成可复现的随机种子，整个循环不读取目标期或任何未来期开奖数据。",
        "",
        "## 每期最高奖级次数（主口径）",
        "",
        "同一期即使多注中奖，也只按其中最高奖级计为1期。",
        "",
        "| 每期最高奖级 | V8期数 | V11前5注期数 | V11-V8 |",
        "|---|---:|---:|---:|",
    ]
    for name in prizes:
        av = a["best_prize_period_counts"].get(name, 0)
        bv = b["best_prize_period_counts"].get(name, 0)
        lines.append(f"| {name} | {av} | {bv} | {bv-av:+d} |")
    lines.extend([
        "",
        "## 所有中奖彩票张数（辅助口径）",
        "",
        "同一期若有两注同时中奖，这里分别计数，因此六等奖等数字可能高于中奖期数。",
        "",
        "| 奖级 | V8中奖彩票 | V11前5注中奖彩票 | V11-V8 |",
        "|---|---:|---:|---:|",
    ])
    for name in prizes:
        av = a["winning_ticket_prize_counts"].get(name, 0)
        bv = b["winning_ticket_prize_counts"].get(name, 0)
        lines.append(f"| {name} | {av} | {bv} | {bv-av:+d} |")
    lines.extend([
        "",
        "## 汇总指标",
        "",
        "| 指标 | V8 | V11前5注 |",
        "|---|---:|---:|",
        f"| 中奖期数 | {a['winning_periods']} ({a['winning_period_rate']:.3%}) | {b['winning_periods']} ({b['winning_period_rate']:.3%}) |",
        f"| 蓝球覆盖 | {a['blue_covered']} ({a['blue_coverage_rate']:.3%}) | {b['blue_covered']} ({b['blue_coverage_rate']:.3%}) |",
        f"| 至少4个红球 | {a['red_ge4']} ({a['red_ge4_rate']:.3%}) | {b['red_ge4']} ({b['red_ge4_rate']:.3%}) |",
        f"| 至少3个红球 | {a['red_ge3']} ({a['red_ge3_rate']:.3%}) | {b['red_ge3']} ({b['red_ge3_rate']:.3%}) |",
        f"| 总投入 | {a['cost']}元 | {b['cost']}元 |",
        f"| 固定奖金合计 | {a['fixed_return']}元 | {b['fixed_return']}元 |",
        f"| 固定奖金回报率 | {a['fixed_roi']:.3%} | {b['fixed_roi']:.3%} |",
        f"| 固定奖金净收益 | {a['fixed_net']}元 | {b['fixed_net']}元 |",
        "",
        "## 配对比较与高奖概率",
        "",
        f"- V11中奖而V8未中奖：{paired['v11_only']}期；V8中奖而V11未中奖：{paired['v8_only']}期。",
        f"- 配对McNemar双侧检验 p={paired['two_sided_p']:.4f}，没有发现两者任意奖中奖率存在统计显著差异。",
        f"- 两者单期5注三等奖及以上的精确理论概率相同：{report['theory']['both_third_or_above_probability']:.6%}，约1/{report['theory']['both_third_or_above_odds_one_in']:.1f}。",
        f"- 在{report['method']['periods']}期中，单个算法三等奖及以上的理论期望次数仅{expected_high:.3f}；一次也不中的理论概率约{zero_high_probability:.2%}，所以本次两者均为0次并不异常。",
        "",
        "## 十等分时间稳定性",
        "",
        "| 开奖区间 | V8任意奖中奖率 | V11前5注任意奖中奖率 |",
        "|---|---:|---:|",
    ])
    for block in report["time_blocks"]:
        lines.append(
            f"| {block['issue_from']}～{block['issue_to']} | "
            f"{block['v8_winning_rate']:.3%} | {block['v11_winning_rate']:.3%} |"
        )
    lines.extend([
        "",
        "## 结论",
        "",
        "这次严格逐期回测没有证明V11前5注优于V8五注。V11的历史优先排序没有把5注的三等奖以上概率提高到V8之上；在本样本中，V8的四等奖次数、总中奖期数和固定奖金回报率反而更高，但任意奖中奖率差异也不显著。",
        "",
    ])
    return "\n".join(lines)


if __name__ == "__main__":
    result=run()
    (DATA_ROOT/"v11_vs_v8_from_start_results.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf8")
    (DATA_ROOT/"v11_vs_v8_from_start_report.md").write_text(render(result),encoding="utf8")
    print("回测完成")
