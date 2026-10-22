"""双色球v11前50注/前100注全历史走期回测与排序输出。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from statistics import fmean

import ssq_db
from app_paths import DATA_ROOT
from backtest_v10 import START_INDEX, _metrics, _summary
from v11_predictor import build_v11_extreme, v11_rng


def _run(draws, replicate=0):
    rows50, rows100 = [], []
    for index in range(START_INDEX, len(draws)):
        issue = str(draws[index]["issue"])
        tickets = build_v11_extreme(v11_rng(issue, replicate), ticket_count=100)
        rows50.append(_metrics(tickets[:50], draws[index]))
        rows100.append(_metrics(tickets, draws[index]))
    return _summary(rows50, 50), _summary(rows100, 100)


def run_backtest(seed_replicates=4):
    draws = ssq_db.get_all_draws("ASC")
    primary50, primary100 = _run(draws)
    seeds = []
    for replicate in range(seed_replicates):
        result50, result100 = _run(draws, replicate + 100)
        seeds.append({"replicate": replicate, "v11_50": result50, "v11_100": result100})
    target = str(int(draws[-1]["issue"]) + 1)
    tickets, metadata = build_v11_extreme(
        v11_rng(target), draws, 100, rank_current=True, return_metadata=True)
    ranked = []
    for index, (reds, blues) in enumerate(tickets):
        priority = metadata["priority"][index] if metadata["priority"] else None
        ranked.append({
            "rank": index + 1,
            "reds": reds,
            "blue": blues[0],
            "secondary_priority_index": priority["priority_index"] if priority else None,
        })
    for count in (50, 100):
        prefix = metadata["prefixes"][str(count)]
        probability = prefix["third_plus_probability"]
        prefix["one_year_probability_104_draws"] = 1 - (1 - probability) ** 104
        prefix["expected_wait_years_104_draws"] = 1 / probability / 104
    return {
        "method": {"walk_forward": True, "periods": len(draws) - START_INDEX,
                   "issue_from": draws[START_INDEX]["issue"], "issue_to": draws[-1]["issue"],
                   "seed_replicates": seed_replicates},
        "primary": {"v11_50": primary50, "v11_100": primary100},
        "robustness": {
            "runs": seeds,
            "v11_50_mean_third_plus": fmean(x["v11_50"]["third_plus"] for x in seeds),
            "v11_100_mean_third_plus": fmean(x["v11_100"]["third_plus"] for x in seeds),
            "v11_50_mean_fixed_roi": fmean(x["v11_50"]["fixed_roi"] for x in seeds),
            "v11_100_mean_fixed_roi": fmean(x["v11_100"]["fixed_roi"] for x in seeds),
        },
        "current": {"target_issue": target, "metadata": metadata, "ranked_100": ranked},
        "conclusion": "前缀均达到对应注数三等奖以上概率上限；排序不改变单注概率，少买时只保留所购前缀的线性覆盖。",
    }


def render(report):
    p=report["primary"]; meta=report["current"]["metadata"]["prefixes"]
    lines=["# v11 50/100注极限覆盖回测","",
           f"历史走期：{report['method']['issue_from']}～{report['method']['issue_to']}，{report['method']['periods']}期。","",
           "| 方案 | 每期投入 | 三等奖以上理论概率 | 理论约 | 一年一次概率 | 平均等待 |","|---|---:|---:|---:|---:|---:|"]
    for count in (5,10,20,50,100):
        x=meta[str(count)]; year=1-(1-x['third_plus_probability'])**104
        wait=1/x['third_plus_probability']/104
        lines.append(f"| 前{count}注 | {x['cost']}元 | {x['third_plus_probability']:.6%} | 1/{x['odds_one_in']:.1f} | {year:.3%} | {wait:.1f}年 |")
    lines.extend(["","## 3176期主种子回测","",
                  "| 指标 | v11前50注 | v11前100注 |","|---|---:|---:|"])
    for key,label in (("third_plus","三等奖以上"),("fourth_plus","四等奖以上"),("any_prize","任意中奖"),("blue_covered","蓝球覆盖"),("red_ge4","≥4红"),("red_ge3","≥3红"),("fixed_roi","固定奖金回报率")):
        lines.append(f"| {label} | {p['v11_50'][key]:.3%} | {p['v11_100'][key]:.3%} |")
    lines.extend(["",f"50注投入{p['v11_50']['cost']}元、固定奖金{p['v11_50']['fixed_return']}元、净额{p['v11_50']['net']}元。",
                  f"100注投入{p['v11_100']['cost']}元、固定奖金{p['v11_100']['fixed_return']}元、净额{p['v11_100']['net']}元。","",
                  f"**{report['conclusion']}**",""])
    return "\n".join(lines)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--seed-replicates",type=int,default=4);args=parser.parse_args(argv)
    report=run_backtest(args.seed_replicates)
    (DATA_ROOT/"v11_backtest_results.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf8")
    (DATA_ROOT/"v11_backtest_report.md").write_text(render(report),encoding="utf8")
    ranked=report["current"]["ranked_100"]
    (DATA_ROOT/"v11_ranked_100.txt").write_text("\n".join(f"{x['rank']:03d}. {' '.join(f'{n:02d}' for n in x['reds'])} + {x['blue']:02d} | 次级指数 {x['secondary_priority_index']}" for x in ranked)+"\n",encoding="utf8")
    print(report["conclusion"]);return 0


if __name__=="__main__":raise SystemExit(main())
