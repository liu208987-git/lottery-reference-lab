"""双色球生产预测程序（V15 多窗口稳健覆盖自学习版）。

运行：python ssq_predict.py
流程：同步开奖 → 结算旧预测 → 滚动自学习 → 生成并锁定下一期五注。
大乐透生产程序不经过本文件，继续保持 v4。
"""

from __future__ import annotations

import argparse

import ssq_db as db
from auto_optimizer import get_optimized_config, run_optimization
from history_sources import sync_game
from ssq_adaptive_predictor import (
    ALGORITHM_LABEL,
    ALGORITHM_NAME,
    build_adaptive_portfolio,
)
from ssq_prediction_audit import next_issue, record_prediction, settle_available


TICKET_COUNT = 5


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="双色球 V15 多窗口稳健覆盖预测")
    parser.add_argument("--no-update", action="store_true", help="不联网同步且不重复训练")
    args = parser.parse_args(argv)

    db.init_db()
    if not args.no_update:
        try:
            result = sync_game("ssq", db)
            print(f"数据同步完成：新增 {result['added']} 期，共 {result['total']} 期")
        except Exception as exc:
            print(f"联网更新失败，使用本地数据：{exc}")

    rows = db.get_all_draws("ASC")
    if len(rows) < 300:
        print(f"历史数据不足（{len(rows)}期），至少需要300期")
        return

    settled = settle_available(rows)
    if settled:
        print(f"已结算 {settled} 条历史预测")

    if not args.no_update:
        print("开始双色球滚动自学习：严格使用各目标期之前的数据……")
        learned = run_optimization("ssq", periods=100)
        print(
            "自学习完成："
            f"组合模式 {learned['best_config']['portfolio_mode']}，"
            f"最大红球重叠 {learned['best_config']['max_red_overlap']}，"
            f"低频阈值 {learned['best_config']['rare_rate']:.3%}"
        )

    latest_issue = str(rows[-1]["issue"])
    target_issue = next_issue(latest_issue)
    optimizer_config = get_optimized_config("ssq") or {}
    tickets, adaptive = build_adaptive_portfolio(
        target_issue, rows, optimizer_config
    )
    diagnostics = adaptive["portfolio"]

    inserted = record_prediction(
        target_issue,
        ALGORITHM_NAME,
        latest_issue,
        [(list(reds), list(blues)) for reds, blues in tickets],
        model_info={
            "red": "zero-overlap-or-gated-overlap+empirical-rank",
            "blue": "unique-blue+frozen-ticket-rank",
            "strategy": adaptive["strategy"],
            "ticket_count": TICKET_COUNT,
            "self_learning": optimizer_config,
            **adaptive,
        },
    )

    previous_reds = {rows[-1][f"r{index}"] for index in range(1, 7)}
    print(f"历史 {len(rows)} 期，预测第 {target_issue} 期")
    print(f"策略：{ALGORITHM_LABEL}（近期选择＋200期稳定性闸门）")
    print(
        f"组合覆盖：红球 {diagnostics['red_coverage']}/33，"
        f"蓝球 {diagnostics['blue_coverage']}/16，"
        f"最大红球重叠 {diagnostics['max_red_overlap']}"
    )
    print(
        "排除检查："
        f"历史完整重复 {adaptive['historical_full_duplicates']}，"
        f"历史红球重复 {adaptive['historical_red_duplicates']}"
    )
    for index, ((reds, blues), score) in enumerate(
        zip(tickets, adaptive["ticket_scores"]), 1
    ):
        repeat = len(set(reds) & previous_reds)
        reasons = "、".join(score["soft_reasons"]) or "无低频降权"
        print(
            f"  优先{index}（指数{score['priority_index']}/100）："
            f"{' '.join(f'{number:02d}' for number in reds)} + "
            f"{' '.join(f'{number:02d}' for number in blues)}  "
            f"上期重号{repeat}；{reasons}"
        )
    print(
        "预测已锁定。" if inserted
        else "本期 V15 预测此前已锁定，未覆盖原记录。"
    )
    print("提示：优先指数是同批五注的结构排序，不是中奖概率。")


if __name__ == "__main__":
    main()
