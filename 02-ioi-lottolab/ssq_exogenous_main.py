"""使用 PDF 开奖机制与外生特征的双色球独立预测/比较程序。

运行：python ssq_exogenous_main.py
"""

from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path

import ssq_db as db
from history_sources import sync_game
from quant_models import research_gate
from ssq_analyzer import Analyzer
from ssq_exogenous_model import GROUP_LABELS, run_research
from ssq_prediction_audit import (
    record_prediction,
    scoreboard,
    settle_available,
)


ROOT = Path(__file__).resolve().parent
STATE_PATH = ROOT / "ssq_exogenous_model_state.json"


def _format_number(value: float) -> str:
    return f"{value:+.4%}"


def _print_zone(title: str, result: dict) -> None:
    print(f"\n{title}")
    print("模型                         测试Brier   相对均匀改进    校正p值  稳定块  平均命中")
    for row in result["rows"]:
        print(
            f"{row['label']:<26s} {row['test_brier']:.6f}  "
            f"{_format_number(row['relative_improvement']):>11s}  "
            f"{row['corrected_p']:.4f}   {row['stable_blocks']}/4    "
            f"{row['top_hits']:.4f}"
        )
    print(
        f"部署模型：{result['selected_model']} | "
        f"验证集候选：{GROUP_LABELS.get(result['best_validation_candidate'], result['best_validation_candidate'])}"
    )
    print(f"结论：{result['reason']}")


def _serializable(result: dict) -> dict:
    # run_research 已只返回 Python 标量和容器；此函数保留为稳定输出边界。
    return json.loads(json.dumps(result, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="双色球 PDF 外生特征消融、留出回测与预测")
    parser.add_argument(
        "--no-update", action="store_true",
        help="不联网更新，直接使用本地 ssq.db")
    parser.add_argument(
        "--tickets", type=int, default=5, choices=range(1, 6),
        metavar="1-5", help="生成互相低重叠的完整投注数（默认5）")
    args = parser.parse_args()

    db.init_db()
    if not args.no_update:
        print("正在增量更新双色球历史数据……")
        try:
            update = sync_game("ssq", db)
            print(
                f"更新完成：新增 {update['added']} 期，共 {update['total']} 期，"
                f"范围 {update['range'][0]}-{update['range'][1]}"
            )
        except Exception as error:
            print(f"联网更新失败，继续使用本地数据库：{error}")

    rows = db.get_all_draws("ASC")
    newly_settled = settle_available(rows)
    if newly_settled:
        print(f"预测评估台账新增结算 {newly_settled} 条。")
    print(f"开始时间顺序训练与独立留出回测（历史 {len(rows)} 期）……")
    result = run_research(rows, ticket_count=args.tickets)
    current = Analyzer(rows)
    current_prediction = current.predict()
    old_red = research_gate(current.reds_seq, 33, 6)
    old_blue = research_gate(current.blues_seq, 16, 1)
    result["current_algorithm"] = {
        "name": "quant-gated-coverage-v3",
        "red_model": old_red["selected_model"],
        "red_gate_passed": old_red["gate_passed"],
        "blue_model": old_blue["selected_model"],
        "blue_gate_passed": old_blue["gate_passed"],
        "tickets": current_prediction["tickets"],
    }
    result["trained_at"] = datetime.now().isoformat(timespec="seconds")
    STATE_PATH.write_text(
        json.dumps(_serializable(result), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    split = result["red"]["split"]
    print(
        f"测试区间：{split['test_from']}-{split['test_to']}，"
        f"训练/验证/测试={split['train']}/{split['validation']}/{split['test']}"
    )
    _print_zone("红球模型比较", result["red"])
    _print_zone("蓝球模型比较", result["blue"])

    old = result["current_algorithm"]
    print(
        "\n与原双色球程序比较："
        f"原算法红球={old['red_model']}、蓝球={old['blue_model']}；"
        f"新算法红球={result['red']['selected_model']}、"
        f"蓝球={result['blue']['selected_model']}。"
    )
    if not any((
        old["red_gate_passed"], old["blue_gate_passed"],
        result["red"]["gate_passed"], result["blue"]["gate_passed"],
    )):
        print("当前样本中两套程序都没有发现可复现的概率偏差，实盘均采用均匀概率。")

    external_locked = record_prediction(
        result["next_issue"], result["model"], result["trained_through"],
        result["tickets"],
        model_info={
            "red": result["red"]["selected_model"],
            "blue": result["blue"]["selected_model"],
        },
    )
    current_locked = record_prediction(
        result["next_issue"], old["name"], result["trained_through"],
        current_prediction["tickets"],
        model_info={
            "red": old["red_model"], "blue": old["blue_model"],
        },
    )
    if external_locked or current_locked:
        print(f"第 {result['next_issue']} 期两套预测已写入防覆盖评估台账。")
    else:
        print(f"第 {result['next_issue']} 期预测此前已锁定，本次没有覆盖原记录。")

    print(f"\n第 {result['next_issue']} 期完整低重叠组合")
    for index, (reds, blues) in enumerate(result["tickets"], 1):
        red_text = " ".join(f"{number:02d}" for number in reds)
        blue_text = " ".join(f"{number:02d}" for number in blues)
        print(f"  第{index}注：{red_text} + {blue_text}")
    print(f"\n详细结果已保存：{STATE_PATH}")
    board = scoreboard()
    if board:
        print("长期比较请运行：python ssq_audit.py")
    print("提示：彩票开奖具有独立随机性；代理特征通过门槛前不会用于选号。")


if __name__ == "__main__":
    main()
