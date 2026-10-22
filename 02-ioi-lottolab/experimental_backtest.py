"""实验性算法回测脚本：对比v7/v7-lite与当前v4/v5的表现。

运行：python experimental_backtest.py

输出：
1. SSQ：v7全量 vs v7-lite vs v5（基准）
2. DLT：v7全量 vs v7-lite vs v4（基准）
"""

from __future__ import annotations

import random
import time
from collections import Counter
from hashlib import sha256
from datetime import datetime

import ssq_db as ssq_db_mod
import dlt_db as dlt_db_mod
from ssq_prediction_audit import evaluate_tickets as ssq_evaluate
from dlt_prediction_audit import evaluate_tickets as dlt_evaluate
from experimental_predictor import (
    build_experimental_v7,
    build_experimental_v7_lite,
)


# ============================================================
# 配置
# ============================================================

SSQ_CONFIG = {
    "red_pool": 33, "red_pick": 6,
    "blue_pool": 16, "blue_pick": 1,
    "min_train": 300,
    "name": "双色球",
}

DLT_CONFIG = {
    "red_pool": 35, "red_pick": 5,
    "blue_pool": 12, "blue_pick": 2,
    "min_train": 300,
    "name": "大乐透",
}

# 基准结果（来自当前v4/v5回填）
BASELINE = {
    "ssq": {
        "algorithm": "v5 (红蓝分别优化)",
        "total": 3176,
        "ge4": 78, "ge4_pct": 2.5,
        "ge3": 808, "ge3_pct": 25.4,
        "blue_hits": 993, "blue_pct": 31.3,
        "prizes": 1045, "prize_pct": 32.9,
    },
    "dlt": {
        "algorithm": "v4 (指标增强)",
        "total": 2596,
        "ge4": 14, "ge4_pct": 0.5,
        "ge3": 205, "ge3_pct": 7.9,
        "blue_hits": 2028, "blue_pct": 78.1,
        "prizes": 759, "prize_pct": 29.2,
    },
}


# ============================================================
# 回测核心
# ============================================================

def run_backtest(
    game: str,
    config: dict,
    build_func,
    build_func_name: str,
    periods: int | None = None,
) -> dict:
    """对指定算法进行全量前向回测。

    Args:
        game: "ssq" or "dlt"
        config: 游戏配置
        build_func: 预测函数
        build_func_name: 算法名称
        periods: 回测期数（None=全量）

    Returns:
        dict: 回测统计结果
    """
    if game == "ssq":
        db_mod = ssq_db_mod
        evaluate = ssq_evaluate
    else:
        db_mod = dlt_db_mod
        evaluate = dlt_evaluate

    db_mod.init_db()
    draws = db_mod.get_all_draws("ASC")
    total = len(draws)

    red_pool = config["red_pool"]
    red_pick = config["red_pick"]
    blue_pool = config["blue_pool"]
    blue_pick = config["blue_pick"]
    min_train = config["min_train"]

    start_idx = min_train
    if periods is not None:
        start_idx = max(start_idx, total - periods)

    total_to_test = total - start_idx

    print(f"\n{'='*60}")
    print(f"回测 {config['name']} · {build_func_name}")
    print(f"{'='*60}")
    print(f"历史数据：{total} 期，回测范围：第{start_idx+1}~{total}期（共{total_to_test}期）")

    ge4_count = 0      # ≥4红
    ge3_count = 0      # ≥3红
    ge5_count = 0      # ≥5红（全中）
    blue_hit_count = 0  # 蓝球命中
    prize_count = 0     # 中奖期数
    prize_levels: Counter = Counter()  # 奖项等级分布
    total_union_hits = 0  # 覆盖命中总数

    start_time = time.time()

    for i in range(start_idx, total):
        train_data = draws[:i]
        actual_draw = draws[i]
        issue = actual_draw["issue"]

        # 训练窗口
        window = 200 if game == "ssq" else 100
        if len(train_data) > window:
            train_window = train_data[-window:]
        else:
            train_window = train_data

        # 生成预测
        seed_payload = f"experimental-{build_func_name}|{issue}".encode("utf-8")
        rng = random.Random(int.from_bytes(sha256(seed_payload).digest()[:8], "big"))

        tickets = build_func(
            rng, train_window,
            red_pool, red_pick, blue_pool, blue_pick, 5,
            red_scores=None, blue_scores=None,
            alpha=0.1,
            n_candidates=2000,
        )

        # 转换格式
        tickets_normalized = [[sorted(r), sorted(b)] for r, b in tickets]

        # 结算
        actual_reds = [actual_draw[f"r{j}"] for j in range(1, red_pick + 1)]
        if game == "ssq":
            actual_blues = [actual_draw["b1"]]
            metrics = evaluate(tickets_normalized, actual_reds, actual_blues[0])
        else:
            actual_blues = [actual_draw[f"b{j}"] for j in range(1, blue_pick + 1)]
            metrics = evaluate(tickets_normalized, actual_reds, actual_blues)

        # 统计
        max_red = metrics["max_red_hits"]
        if max_red >= red_pick:
            ge5_count += 1
        if max_red >= 4:
            ge4_count += 1
        if max_red >= 3:
            ge3_count += 1
        if metrics["blue_covered"]:
            blue_hit_count += 1
        if metrics["winning_tickets"] > 0:
            prize_count += 1
        total_union_hits += metrics["union_red_hits"]

        pname = metrics.get("best_prize_name")
        if pname:
            prize_levels[pname] += 1

        # 进度报告
        done = i - start_idx + 1
        if done % 500 == 0 or done == total_to_test:
            elapsed = time.time() - start_time
            speed = done / elapsed if elapsed > 0 else 0
            remaining = (total_to_test - done) / speed if speed > 0 else 0
            print(f"  进度: {done}/{total_to_test} ({done/total_to_test*100:.1f}%) "
                  f"已用{elapsed:.0f}s 剩余~{remaining:.0f}s "
                  f"| ≥5红:{ge5_count} ≥4红:{ge4_count} ≥3红:{ge3_count} "
                  f"蓝中:{blue_hit_count} 中奖:{prize_count}")

    elapsed = time.time() - start_time

    print(f"\n{config['name']} · {build_func_name} 回测完成：{total_to_test}期，耗时{elapsed:.1f}s")
    print(f"  统计：≥5红={ge5_count}({ge5_count/total_to_test*100:.1f}%) "
          f"≥4红={ge4_count}({ge4_count/total_to_test*100:.1f}%) "
          f"≥3红={ge3_count}({ge3_count/total_to_test*100:.1f}%) "
          f"蓝球命中={blue_hit_count}({blue_hit_count/total_to_test*100:.1f}%) "
          f"中奖期={prize_count}({prize_count/total_to_test*100:.1f}%)")
    print(f"  奖项分布：{dict(prize_levels.most_common())}")
    print(f"  平均覆盖命中：{total_union_hits/total_to_test:.2f}/6")

    return {
        "game": game,
        "algorithm": build_func_name,
        "total": total_to_test,
        "ge5": ge5_count,
        "ge5_pct": ge5_count / total_to_test * 100,
        "ge4": ge4_count,
        "ge4_pct": ge4_count / total_to_test * 100,
        "ge3": ge3_count,
        "ge3_pct": ge3_count / total_to_test * 100,
        "blue_hits": blue_hit_count,
        "blue_pct": blue_hit_count / total_to_test * 100,
        "prizes": prize_count,
        "prize_pct": prize_count / total_to_test * 100,
        "prize_levels": dict(prize_levels),
        "avg_union_hits": total_union_hits / total_to_test,
        "elapsed": elapsed,
    }


# ============================================================
# 对比输出
# ============================================================

def print_comparison(game: str, baseline: dict, results: list[dict]):
    """打印对比表格。"""
    print(f"\n{'='*80}")
    print(f"  {game.upper()} 算法对比")
    print(f"{'='*80}")

    header = f"{'算法':<25} {'期数':>6} {'≥5红':>8} {'≥4红':>8} {'≥3红':>8} {'蓝中':>8} {'中奖':>8} {'耗时':>6}"
    print(header)
    print("-" * 80)

    # 基准
    b = baseline
    print(f"{b['algorithm']:<25} {b['total']:>6} "
          f"{'N/A':>8} "
          f"{b['ge4']}({b['ge4_pct']:.1f}%){'':>2} "
          f"{b['ge3']}({b['ge3_pct']:.1f}%){'':>2} "
          f"{b['blue_hits']}({b['blue_pct']:.1f}%){'':>2} "
          f"{b['prizes']}({b['prize_pct']:.1f}%){'':>2} "
          f"{'N/A':>6}")

    for r in results:
        name = r["algorithm"]
        # 计算与基准的差异
        ge4_diff = r["ge4_pct"] - b["ge4_pct"]
        ge3_diff = r["ge3_pct"] - b["ge3_pct"]
        blue_diff = r["blue_pct"] - b["blue_pct"]
        prize_diff = r["prize_pct"] - b["prize_pct"]

        print(f"{name:<25} {r['total']:>6} "
              f"{r['ge5']}({r['ge5_pct']:.1f}%){'':>2} "
              f"{r['ge4']}({r['ge4_pct']:.1f}%){'':>2} "
              f"{r['ge3']}({r['ge3_pct']:.1f}%){'':>2} "
              f"{r['blue_hits']}({r['blue_pct']:.1f}%){'':>2} "
              f"{r['prizes']}({r['prize_pct']:.1f}%){'':>2} "
              f"{r['elapsed']:.0f}s")

        # 差异标记
        parts = []
        if ge4_diff > 0.1:
            parts.append(f"≥4红+{ge4_diff:.1f}%")
        elif ge4_diff < -0.1:
            parts.append(f"≥4红{ge4_diff:.1f}%")
        if ge3_diff > 0.5:
            parts.append(f"≥3红+{ge3_diff:.1f}%")
        elif ge3_diff < -0.5:
            parts.append(f"≥3红{ge3_diff:.1f}%")
        if blue_diff > 0.5:
            parts.append(f"蓝中+{blue_diff:.1f}%")
        elif blue_diff < -0.5:
            parts.append(f"蓝中{blue_diff:.1f}%")
        if prize_diff > 0.5:
            parts.append(f"中奖+{prize_diff:.1f}%")
        elif prize_diff < -0.5:
            parts.append(f"中奖{prize_diff:.1f}%")

        if parts:
            print(f"  {'':>25} {'':>6} 差异: {', '.join(parts)}")
        if r.get("prize_levels"):
            pl = r["prize_levels"]
            pl_str = " ".join(f"{k}:{v}" for k, v in sorted(pl.items()))
            print(f"  {'':>25} {'':>6} 奖项: {pl_str}")

    print("-" * 80)


# ============================================================
# 主入口
# ============================================================

def main():
    print("=" * 60)
    print("实验性算法回测工具")
    print(f"时间：{datetime.now().isoformat(timespec='seconds')}")
    print("=" * 60)

    # 算法列表
    algorithms = [
        ("v7-lite (位置感知+覆盖优先)", build_experimental_v7_lite),
        ("v7 (位置+节奏+邻号+动量+共识)", build_experimental_v7),
    ]

    all_results = {"ssq": [], "dlt": []}

    for game, config in [("ssq", SSQ_CONFIG), ("dlt", DLT_CONFIG)]:
        for algo_name, build_func in algorithms:
            try:
                result = run_backtest(game, config, build_func, algo_name)
                all_results[game].append(result)
            except Exception as e:
                print(f"\n{game.upper()} · {algo_name} 回测失败：{e}")
                import traceback
                traceback.print_exc()

    # 打印对比
    for game in ["ssq", "dlt"]:
        if all_results[game]:
            print_comparison(game, BASELINE[game], all_results[game])

    print("\n" + "=" * 60)
    print("回测完成")
    print("=" * 60)


if __name__ == "__main__":
    main()