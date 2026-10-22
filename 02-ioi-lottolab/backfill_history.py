"""回填50期历史回测预测到审计数据库

对双色球和大乐透各自最近50期：
1. 用该期之前的历史数据运行预测算法
2. 将预测结果写入审计数据库（标记为backtest_fill）
3. 自动结算，与实际开奖对比

这样前端命中趋势可视化就有50期数据可展示。
已存在的真实预测记录不会被覆盖（record_prediction遇重复返回False）。
"""

import random
from hashlib import sha256

import ssq_db as ssq_db_mod
import dlt_db as dlt_db_mod
from history_sources import sync_game
from fused_predictor import build_enhanced_portfolio
from ssq_prediction_audit import record_prediction as ssq_record, settle_available as ssq_settle
from dlt_prediction_audit import record_prediction as dlt_record, settle_available as dlt_settle

BACKFILL_PERIODS = 50

SSQ_CONFIG = {
    "red_pool": 33, "red_pick": 6, "blue_pool": 16, "blue_pick": 1,
    "train_window": 100, "alpha": 0.1, "candidates": 1000,
    "db": ssq_db_mod, "record": ssq_record, "settle": ssq_settle,
    "algorithm": "ssq-sina-v4",
}

DLT_CONFIG = {
    "red_pool": 35, "red_pick": 5, "blue_pool": 12, "blue_pick": 2,
    "train_window": 100, "alpha": 0.1, "candidates": 1000,
    "db": dlt_db_mod, "record": dlt_record, "settle": dlt_settle,
    "algorithm": "dlt-sina-v4",
}


def backfill_game(name: str, config: dict):
    """回填单个彩种的50期回测预测。"""
    print(f"\n{'='*60}")
    print(f"回填 {name} 最近{BACKFILL_PERIODS}期回测预测")
    print(f"{'='*60}")

    config["db"].init_db()
    draws = config["db"].get_all_draws("ASC")
    total = len(draws)
    print(f"历史数据：{total}期 ({draws[0]['issue']}~{draws[-1]['issue']})")

    red_pool = config["red_pool"]
    red_pick = config["red_pick"]
    blue_pool = config["blue_pool"]
    blue_pick = config["blue_pick"]
    alpha = config["alpha"]
    candidates = config["candidates"]
    train_window = config["train_window"]

    filled = 0
    skipped = 0

    # 从倒数第BACKFILL_PERIODS期开始，每期用之前的数据预测
    start_idx = max(train_window + 10, total - BACKFILL_PERIODS)

    for i in range(start_idx, total):
        target_issue = draws[i]["issue"]
        train = draws[:i]  # 用该期之前的所有数据训练
        latest_issue = train[-1]["issue"]

        # 用近train_window期计算指标分布
        recent = train[-train_window:] if len(train) >= train_window else train

        seed_payload = f"{config['algorithm']}|{target_issue}|{len(train)}".encode("utf-8")
        rng = random.Random(int.from_bytes(sha256(seed_payload).digest()[:8], "big"))

        tickets = build_enhanced_portfolio(
            rng, train, red_pool, red_pick, blue_pool, blue_pick, 5,
            red_scores=None, blue_scores=None,
            alpha=alpha, candidate_count=candidates,
            max_overlap=red_pick,
        )

        # 记录预测（provenance标记为回测回填）
        ok = config["record"](
            target_issue, config["algorithm"], latest_issue,
            [(list(r), list(b)) for r, b in tickets],
            provenance="backtest_fill",
        )

        if ok:
            filled += 1
            # 立即结算（该期已开奖）
            config["settle"](draws)
        else:
            skipped += 1

        if filled % 10 == 0 and filled > 0:
            print(f"  已回填 {filled} 期...")

    print(f"完成：回填 {filled} 期，跳过 {skipped} 期（已存在）")

    # 最终结算
    settled = config["settle"](draws)
    if settled:
        print(f"结算 {settled} 条预测")


def main():
    print("回填50期历史回测预测数据")
    print("目的：为前端命中趋势可视化提供足够数据量")

    # 更新数据
    print("\n同步最新数据...")
    try:
        sync_game("ssq", ssq_db_mod)
        sync_game("dlt", dlt_db_mod)
    except Exception as e:
        print(f"同步失败，使用本地数据：{e}")

    backfill_game("双色球", SSQ_CONFIG)
    backfill_game("大乐透", DLT_CONFIG)

    print(f"\n{'='*60}")
    print("回填完成！刷新前端页面即可看到50期命中趋势数据。")


if __name__ == "__main__":
    main()
