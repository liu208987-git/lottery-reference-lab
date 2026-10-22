"""生成并锁定双色球 v10 十注高奖覆盖实验预测。"""

from __future__ import annotations

import ssq_db
from ssq_prediction_audit import next_issue, record_prediction
from v10_predictor import ALGORITHM_NAME, build_v10_high_prize, v10_rng


def main() -> None:
    rows = ssq_db.get_all_draws("ASC")
    trained_through = str(rows[-1]["issue"])
    target_issue = next_issue(trained_through)
    tickets, metadata = build_v10_high_prize(
        v10_rng(target_issue), return_metadata=True)
    inserted = record_prediction(
        target_issue, ALGORITHM_NAME, trained_through, tickets,
        model_info={
            **metadata,
            "status": "experimental_not_production",
            "objective": "maximize_exact_third_prize_or_above_union",
            "backtest_report": "v10_backtest_report.md",
        },
        provenance="prospective_locked_experimental",
    )
    print(f"v10实验预测：{target_issue}，10注投入20元")
    print(
        f"三等奖以上精确概率：{metadata['third_or_above_probability']:.6%}，"
        f"约1/{metadata['third_or_above_odds_one_in']:.1f}")
    for index, (reds, blues) in enumerate(tickets, 1):
        print(f"{index:02d}. {' '.join(f'{n:02d}' for n in reds)} + {blues[0]:02d}")
    print("预测已锁定。" if inserted else "本期v10实验预测已存在，未覆盖。")


if __name__ == "__main__":
    main()
