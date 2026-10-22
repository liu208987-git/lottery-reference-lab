"""查看双色球两套算法的预测后结算和公平排行榜。"""

from __future__ import annotations

import argparse

import ssq_db
from ssq_prediction_audit import issue_report, scoreboard, settle_available


def main() -> None:
    parser = argparse.ArgumentParser(description="双色球预测后评估台账")
    parser.add_argument("--issue", help="查看指定期号，例如 2026079")
    args = parser.parse_args()
    settled = settle_available(ssq_db.get_all_draws("ASC"))
    if settled:
        print(f"本次新增结算 {settled} 条预测。")

    if args.issue:
        print(f"\n第 {args.issue} 期逐算法结果")
        for row in issue_report(args.issue):
            metrics = row["metrics"]
            if not metrics:
                print(f"{row['algorithm']}：等待开奖")
                continue
            print(
                f"{row['algorithm']}：平均红球 {metrics['average_red_hits']:.3f}，"
                f"单注最高 {metrics['max_red_hits']}，蓝球覆盖 "
                f"{'是' if metrics['blue_covered'] else '否'}，"
                f"中奖票 {metrics['winning_tickets']}，"
                f"最好奖级 {metrics['best_prize_name'] or '未中奖'}"
            )
            for detail in metrics["details"]:
                print(
                    f"  第{detail['ticket']}注：红{detail['red_hits']}+"
                    f"蓝{detail['blue_hits']}  {detail['prize'] or '未中奖'}"
                )

    print("\n共同样本排行榜")
    board = scoreboard()
    if not board:
        print("尚无两个算法都已结算的共同预测期。")
    for row in board:
        print(
            f"{row['algorithm']}：共同{row['common_periods']}期，"
            f"每注平均红球{row['average_red_hits']:.4f}，"
            f"蓝球覆盖率{row['blue_coverage_rate']:.2%}，"
            f"中奖期率{row['prize_period_rate']:.2%}"
        )


if __name__ == "__main__":
    main()

