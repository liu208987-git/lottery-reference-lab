"""全量历史回填：用当前生产算法严格走期预测并结算。

双色球 v15 与大乐透 v7 均以前100期作为最小学习样本。每个目标期只
使用该期之前的数据生成五注，回填记录明确标记为 walk_forward_backfill。

对每个可验证期：
1. 用该期之前的所有数据作为训练集
2. 用自学习最优参数运行预测算法
3. 与实际开奖结果对比结算
4. 直接写入审计数据库

运行：python backfill_all.py
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
import argparse
from collections import Counter
from datetime import datetime
from pathlib import Path

from auto_optimizer import get_optimized_config
from ssq_adaptive_predictor import (
    ALGORITHM_NAME as SSQ_ALGORITHM,
    build_adaptive_portfolio as build_ssq_portfolio,
)
from dlt_adaptive_predictor import (
    ALGORITHM_NAME as DLT_ALGORITHM,
    build_adaptive_portfolio as build_dlt_portfolio,
)


ROOT = Path(__file__).resolve().parent
RESULT_JSON = ROOT / "production_backtest_results.json"
RESULT_REPORT = ROOT / "production_backtest_report.md"
PRIZE_ORDER = {name: rank for rank, name in enumerate(
    ["一等奖", "二等奖", "三等奖", "四等奖", "五等奖", "六等奖",
     "七等奖", "八等奖", "九等奖"], 1
)}


# ============================================================
# 配置
# ============================================================

GAME_CONFIG = {
    "ssq": {
        "db_module": "ssq_db",
        "audit_path": Path(__file__).resolve().parent / "ssq_prediction_audit.db",
        "audit_module": "ssq_prediction_audit",
        "red_pool": 33, "red_pick": 6,
        "blue_pool": 16, "blue_pick": 1,
        "algorithm": SSQ_ALGORITHM,
        "min_train": 100,
    },
    "dlt": {
        "db_module": "dlt_db",
        "audit_path": Path(__file__).resolve().parent / "dlt_prediction_audit.db",
        "audit_module": "dlt_prediction_audit",
        "red_pool": 35, "red_pick": 5,
        "blue_pool": 12, "blue_pick": 2,
        "algorithm": DLT_ALGORITHM,
        "min_train": 100,
    },
}


def _get_optimized_params(game: str) -> dict:
    """获取自学习最优参数。"""
    return get_optimized_config(game) or {}


def _clear_old_predictions(audit_path: Path, algorithm: str):
    """只清除该算法的历史回填，保留真实开奖前锁定记录。"""
    conn = sqlite3.connect(audit_path)
    conn.execute(
        """
        DELETE FROM predictions
        WHERE algorithm=?
          AND provenance IN (
              'walk_forward_backfill', 'backfill_prospective', 'backtest_fill'
          )
        """,
        (algorithm,),
    )
    conn.commit()
    conn.close()
    print(f"已清除 {audit_path.name} 中 {algorithm} 的旧结算回填；未结算预测已保留")


def _batch_insert_predictions(audit_path: Path, records: list[dict]):
    """批量插入预测+结算记录。"""
    conn = sqlite3.connect(audit_path)
    now = datetime.now().isoformat(timespec="seconds")
    for r in records:
        conn.execute("""
            INSERT OR IGNORE INTO predictions
            (issue, algorithm, trained_through, tickets_json, model_json,
             provenance, generated_at, settled_at, actual_json, metrics_json)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        """, (
            r["issue"], r["algorithm"], r["trained_through"],
            json.dumps(r["tickets"], ensure_ascii=False),
            json.dumps(r.get("model_info", {}), ensure_ascii=False),
            "walk_forward_backfill", now, now,
            json.dumps(r["actual"], ensure_ascii=False),
            json.dumps(r["metrics"], ensure_ascii=False),
        ))
    conn.commit()
    conn.close()


def _backfill_game(game: str):
    """回填指定彩种的全量历史数据。"""
    cfg = GAME_CONFIG[game]
    print(f"\n{'='*60}")
    print(f"开始回填 {game.upper()} 全量历史数据")
    print(f"{'='*60}")

    # 动态导入
    import importlib
    db_mod = importlib.import_module(cfg["db_module"])
    audit_mod = importlib.import_module(cfg["audit_module"])

    db_mod.init_db()
    rows = db_mod.get_all_draws("ASC")
    total = len(rows)
    print(f"历史数据：{total} 期")

    # 获取最优参数
    params = _get_optimized_params(game)
    print(
        "算法参数："
        f"mode={params.get('portfolio_mode', 'default')}，"
        f"replicates={params.get('candidate_replicates', 'default')}，"
        f"window={params.get('train_window', 'default')}"
    )

    # 清除旧数据
    _clear_old_predictions(cfg["audit_path"], cfg["algorithm"])

    red_pool = cfg["red_pool"]
    red_pick = cfg["red_pick"]
    blue_pool = cfg["blue_pool"]
    blue_pick = cfg["blue_pick"]
    algorithm = cfg["algorithm"]
    min_train = cfg["min_train"]

    # 从 min_train 期开始回填（需要足够训练数据）
    start_idx = min_train
    total_to_backfill = total - start_idx
    print(f"回填范围：第{start_idx+1}期 ~ 第{total}期（共{total_to_backfill}期）")

    batch = []
    batch_size = 100
    start_time = time.time()
    ge4_count = 0
    ge3_count = 0
    blue_hit_count = 0
    prize_count = 0
    prize_breakdown: Counter = Counter()

    for i in range(start_idx, total):
        train_data = rows[:i]
        actual_draw = rows[i]
        issue = actual_draw["issue"]

        if game == "ssq":
            tickets, adaptive = build_ssq_portfolio(
                str(issue), train_data, params
            )
        else:
            tickets, adaptive = build_dlt_portfolio(
                str(issue), train_data, params,
                red_scores=None, blue_scores=None,
            )

        # 转换为可序列化格式
        tickets_normalized = [[sorted(r), sorted(b)] for r, b in tickets]

        # 实际开奖结果
        actual_reds = [actual_draw[f"r{j}"] for j in range(1, red_pick + 1)]
        if game == "ssq":
            actual_blues = [actual_draw["b1"]]
            actual = {"reds": sorted(actual_reds), "blue": actual_blues[0]}
            metrics = audit_mod.evaluate_tickets(
                tickets_normalized, actual_reds, actual_blues[0])
        else:
            actual_blues = [actual_draw[f"b{j}"] for j in range(1, blue_pick + 1)]
            actual = {"reds": sorted(actual_reds), "blues": sorted(actual_blues)}
            metrics = audit_mod.evaluate_tickets(
                tickets_normalized, actual_reds, actual_blues,
                issue=str(issue),
            )

        # 统计
        max_red = metrics.get("max_red_hits", 0)
        if max_red >= 4:
            ge4_count += 1
        if max_red >= 3:
            ge3_count += 1
        if metrics.get("blue_covered", False):
            blue_hit_count += 1
        if metrics.get("winning_tickets", 0) > 0:
            prize_count += 1
        if metrics.get("best_prize_name"):
            prize_breakdown[metrics["best_prize_name"]] += 1

        batch.append({
            "issue": issue,
            "algorithm": algorithm,
            "trained_through": rows[i-1]["issue"],
            "tickets": tickets_normalized,
            "model_info": {
                "backfill_method": "strict_walk_forward",
                "target_data_used": False,
                **adaptive,
            },
            "actual": actual,
            "metrics": metrics,
        })

        # 批量写入
        if len(batch) >= batch_size:
            _batch_insert_predictions(cfg["audit_path"], batch)
            batch.clear()

        # 进度报告
        done = i - start_idx + 1
        if done % 100 == 0 or done == total_to_backfill:
            elapsed = time.time() - start_time
            speed = done / elapsed if elapsed > 0 else 0
            remaining = (total_to_backfill - done) / speed if speed > 0 else 0
            print(f"  进度: {done}/{total_to_backfill} ({done/total_to_backfill*100:.1f}%) "
                  f"已用{elapsed:.0f}s 剩余~{remaining:.0f}s "
                  f"| ≥4红:{ge4_count} ≥3红:{ge3_count} 蓝中:{blue_hit_count} 中奖:{prize_count}")

    # 写入剩余记录
    if batch:
        _batch_insert_predictions(cfg["audit_path"], batch)

    elapsed = time.time() - start_time
    print(f"\n{game.upper()} 回填完成：{total_to_backfill}期，耗时{elapsed:.1f}s")
    print(f"  统计：≥4红={ge4_count}({ge4_count/total_to_backfill*100:.1f}%) "
          f"≥3红={ge3_count}({ge3_count/total_to_backfill*100:.1f}%) "
          f"蓝球命中={blue_hit_count}({blue_hit_count/total_to_backfill*100:.1f}%) "
          f"中奖期={prize_count}({prize_count/total_to_backfill*100:.1f}%)")

    return {
        "game": game,
        "algorithm": algorithm,
        "history_total": total,
        "history_range": [rows[0]["issue"], rows[-1]["issue"]],
        "validation_range": [rows[start_idx]["issue"], rows[-1]["issue"]],
        "initial_history_periods": min_train,
        "total": total_to_backfill,
        "ge4": ge4_count,
        "ge3": ge3_count,
        "blue_hits": blue_hit_count,
        "prizes": prize_count,
        "prize_breakdown": dict(prize_breakdown),
        "elapsed": elapsed,
    }


def _write_reports(results: dict) -> None:
    payload = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "method": "game_specific_walk_forward_fixed_5_tickets",
        "results": results,
    }
    RESULT_JSON.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# 生产算法全历史回测报告",
        "",
        f"生成时间：{payload['generated_at']}",
        "",
        "口径：每期固定5注，预测目标期只使用此前可见信息。",
        "双色球v15与大乐透v7均以前100期为最小学习样本；历史回填与真实开奖前锁定记录分开标记。",
        "",
        "| 彩种 | 算法 | 回测期数 | ≥4前区 | ≥3前区 | 蓝球覆盖 | 中奖期数 |",
        "|---|---|---:|---:|---:|---:|---:|",
    ]
    for game in ("ssq", "dlt"):
        row = results.get(game, {})
        if "error" in row:
            lines.append(f"| {game.upper()} | - | - | - | - | - | 失败：{row['error']} |")
            continue
        total = row["total"]
        name = "双色球" if game == "ssq" else "大乐透"
        lines.append(
            f"| {name} | {row['algorithm']} | {total} | "
            f"{row['ge4']} ({row['ge4']/total:.2%}) | "
            f"{row['ge3']} ({row['ge3']/total:.2%}) | "
            f"{row['blue_hits']} ({row['blue_hits']/total:.2%}) | "
            f"{row['prizes']} ({row['prizes']/total:.2%}) |"
        )
    for game in ("ssq", "dlt"):
        row = results.get(game, {})
        if "error" in row:
            continue
        name = "双色球" if game == "ssq" else "大乐透"
        lines.extend(["", f"## {name}最佳奖级分布", ""])
        for prize, count in sorted(
            row["prize_breakdown"].items(),
            key=lambda item: PRIZE_ORDER.get(item[0], 99),
        ):
            lines.append(f"- {prize}：{count} 期")
    RESULT_REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="生产算法历史走期回填")
    parser.add_argument(
        "--game", choices=("ssq", "dlt"),
        help="只回填指定彩种；省略时回填两种彩票",
    )
    args = parser.parse_args()
    print("="*60)
    print("全量历史回填工具")
    print(f"时间：{datetime.now().isoformat(timespec='seconds')}")
    print("="*60)

    selected_games = (args.game,) if args.game else ("ssq", "dlt")
    results = {}
    # 单彩种修复时保留另一彩种最近一次报告，避免报告文件丢失其统计。
    if args.game and RESULT_JSON.exists():
        try:
            results.update(json.loads(RESULT_JSON.read_text(encoding="utf-8")).get("results", {}))
        except (OSError, ValueError):
            pass
    for game in selected_games:
        try:
            results[game] = _backfill_game(game)
        except Exception as e:
            print(f"\n{game.upper()} 回填失败：{e}")
            import traceback
            traceback.print_exc()
            results[game] = {"error": str(e)}

    print("\n" + "="*60)
    print("全量回填完成总结")
    print("="*60)
    for game, r in results.items():
        if "error" in r:
            print(f"{game.upper()}: 失败 - {r['error']}")
        else:
            total = r["total"]
            print(f"{game.upper()}: {total}期 | "
                  f"≥4红={r['ge4']}({r['ge4']/total*100:.1f}%) | "
                  f"≥3红={r['ge3']}({r['ge3']/total*100:.1f}%) | "
                  f"蓝中={r['blue_hits']}({r['blue_hits']/total*100:.1f}%) | "
                  f"中奖={r['prizes']}({r['prizes']/total*100:.1f}%) | "
                  f"耗时{r['elapsed']:.0f}s")
    _write_reports(results)
    print(f"JSON结果：{RESULT_JSON}")
    print(f"Markdown报告：{RESULT_REPORT}")


if __name__ == "__main__":
    main()
