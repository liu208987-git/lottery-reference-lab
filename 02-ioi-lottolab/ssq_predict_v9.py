"""生成并锁定双色球 v9 实验预测，不替换生产 v8。"""

from __future__ import annotations

import argparse

import ssq_db as db
from history_sources import sync_game
from ssq_prediction_audit import next_issue, record_prediction, settle_available
from ticket_ranking import RANKING_METHOD, rank_tickets
from v9_predictor import ALGORITHM_NAME, build_v9_filtered, v9_rng


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="双色球 v9 小概率过滤实验预测")
    parser.add_argument("--no-update", action="store_true", help="不联网更新")
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
        raise ValueError(f"历史数据不足：{len(rows)}期")
    settle_available(rows)

    trained_through = str(rows[-1]["issue"])
    target_issue = next_issue(trained_through)
    tickets, metadata = build_v9_filtered(
        v9_rng(target_issue), rows, return_metadata=True)
    ranking = rank_tickets(tickets, rows, "ssq")
    tickets = [tickets[item["index"]] for item in ranking]
    inserted = record_prediction(
        target_issue,
        ALGORITHM_NAME,
        trained_through,
        tickets,
        model_info={
            **metadata,
            "status": "experimental_not_production",
            "backtest_report": "v9_backtest_report.md",
            "ranking": {
                "method": RANKING_METHOD,
                "priority_indices": [item["priority_index"] for item in ranking],
                "index_is_probability": False,
            },
        },
        provenance="prospective_locked_experimental",
    )

    print(f"v9实验预测期号：{target_issue}；训练截止：{trained_through}")
    print("状态：实验候选，未替换生产v8")
    print(f"排除上期蓝球：{metadata['previous_blue_excluded']:02d}")
    for index, (reds, blues) in enumerate(tickets, 1):
        print(
            f"  优先{index}：{' '.join(f'{value:02d}' for value in reds)} + "
            f"{' '.join(f'{value:02d}' for value in blues)}")
    print("预测已锁定。" if inserted else "本期v9实验预测此前已锁定，未覆盖。")


if __name__ == "__main__":
    main()
