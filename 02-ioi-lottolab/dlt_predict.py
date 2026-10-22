"""大乐透生产预测程序（V7：双色球策略迁移覆盖自学习）。

流程：同步开奖 → 结算旧预测 → 滚动自学习 → 生成并锁定下一期五注。
"""

from __future__ import annotations

import argparse

import dlt_db as db
from auto_optimizer import get_optimized_config, run_optimization
from dlt_adaptive_predictor import (
    ALGORITHM_LABEL,
    ALGORITHM_NAME,
    build_adaptive_portfolio,
)
from dlt_analyzer import Analyzer
from dlt_prediction_audit import next_issue, record_prediction, settle_available
from history_sources import sync_game
from quant_models import model_probabilities, research_gate


RED_POOL = 35
RED_PICK = 5
BLUE_POOL = 12
BLUE_PICK = 2


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="大乐透 V7 双区覆盖自学习预测")
    parser.add_argument("--no-update", action="store_true", help="不联网同步且不重复训练")
    args = parser.parse_args(argv)

    db.init_db()
    if not args.no_update:
        try:
            result = sync_game("dlt", db)
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
        print("开始大乐透严格滚动自学习……")
        learned = run_optimization("dlt", periods=100)
        print(
            "自学习完成："
            f"训练窗口 {learned['best_config']['train_window']}期，"
            f"后区模式 {learned['best_config']['blue_mode']}"
        )

    analyzer = Analyzer(rows)
    quant_red = research_gate(analyzer.reds_seq, RED_POOL, RED_PICK)
    quant_blue = research_gate(analyzer.blues_seq, BLUE_POOL, BLUE_PICK)
    if quant_red["gate_passed"]:
        window = quant_red.get("training_window", len(analyzer.reds_seq))
        red_scores = model_probabilities(
            analyzer.reds_seq[-window:], RED_POOL, RED_PICK,
            quant_red["selected_model"],
        )
        red_model = quant_red["selected_model"]
    else:
        red_scores, red_model = None, "uniform+soft"
    if quant_blue["gate_passed"]:
        window = quant_blue.get("training_window", len(analyzer.blues_seq))
        blue_scores = model_probabilities(
            analyzer.blues_seq[-window:], BLUE_POOL, BLUE_PICK,
            quant_blue["selected_model"],
        )
        blue_model = quant_blue["selected_model"]
    else:
        blue_scores, blue_model = None, "uniform+soft"

    latest_issue = str(rows[-1]["issue"])
    target_issue = next_issue(latest_issue)
    config = get_optimized_config("dlt") or {}
    tickets, adaptive = build_adaptive_portfolio(
        target_issue, rows, config,
        red_scores=red_scores, blue_scores=blue_scores,
    )
    inserted = record_prediction(
        target_issue,
        ALGORITHM_NAME,
        latest_issue,
        [(list(reds), list(blues)) for reds, blues in tickets],
        model_info={
            "red": red_model,
            "blue": blue_model,
            "self_learning": config,
            **adaptive,
        },
    )

    diagnostics = adaptive["portfolio"]
    previous_reds = {rows[-1][f"r{index}"] for index in range(1, 6)}
    print(f"历史 {len(rows)} 期，预测第 {target_issue} 期")
    print(f"策略：{ALGORITHM_LABEL}")
    print(
        f"组合覆盖：前区 {diagnostics['red_coverage']}/35，"
        f"后区 {diagnostics['blue_coverage']}/12，"
        f"最大前区重叠 {diagnostics['max_red_overlap']}，"
        f"最大后区重叠 {diagnostics['max_blue_overlap']}"
    )
    print(
        "排除检查："
        f"历史完整重复 {adaptive['historical_full_duplicates']}，"
        f"历史前区重复 {adaptive['historical_red_duplicates']}"
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
        else "本期 V7 预测此前已锁定，未覆盖原记录。"
    )
    print("提示：优先指数是同批五注的结构排序，不是中奖概率。")


if __name__ == "__main__":
    main()
