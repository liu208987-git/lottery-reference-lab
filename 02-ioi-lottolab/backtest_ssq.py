"""双色球预测算法回测脚本（滑动窗口前向验证）

对最近 N 期进行回测：
- 每一期用之前所有期（或最近 W 期）作为训练集
- 调用 build_enhanced_portfolio 生成5注预测
- 与实际开奖对比，统计每注红球命中数、蓝球命中
- 输出 P(≥4红)、P(≥3红)、蓝球命中率等关键指标

用户诉求：每注独立冲击大奖（4+红），而非分散覆盖小奖。
"""

from __future__ import annotations

import argparse
import random
from collections import Counter
from hashlib import sha256

import ssq_db as db
from history_sources import sync_game
from fused_predictor import build_enhanced_portfolio


RED_POOL = 33
RED_PICK = 6
BLUE_POOL = 16
BLUE_PICK = 1


def backtest_config(
    draws: list[dict],
    config_name: str,
    max_overlap: int,
    alpha: float,
    train_window: int | None,
    periods: int,
    candidate_count: int = 500,
) -> dict:
    """对单个配置进行回测。

    返回统计指标字典。
    """
    n = len(draws)
    start = max(250, n - periods)  # 至少留250期训练
    results = []

    for i in range(start, n):
        # 训练数据切片
        if train_window is not None:
            train = draws[max(0, i - train_window):i]
        else:
            train = draws[:i]

        min_train = min(80, train_window or 200)
        if len(train) < max(min_train, 50):
            continue

        actual = draws[i]
        actual_reds = set(actual[f"r{j}"] for j in range(1, RED_PICK + 1))
        actual_blue = actual["b1"]

        # 使用与 ssq_predict 一致的种子生成方式
        seed_payload = f"backtest-{config_name}|{actual['issue']}|{len(train)}".encode("utf-8")
        rng = random.Random(int.from_bytes(sha256(seed_payload).digest()[:8], "big"))

        # 回测时不走量化门控（避免每期重新拟合模型），用 None 让软混合走均匀+历史频率
        tickets = build_enhanced_portfolio(
            rng, train, RED_POOL, RED_PICK, BLUE_POOL, BLUE_PICK, 5,
            red_scores=None, blue_scores=None,
            alpha=alpha, candidate_count=candidate_count,
            max_overlap=max_overlap,
        )

        # 评估每注命中情况
        ticket_red_hits = []
        blue_hit_any = False
        for reds, blues in tickets:
            red_hit = len(set(reds) & actual_reds)
            blue_hit = blues[0] == actual_blue
            ticket_red_hits.append(red_hit)
            if blue_hit:
                blue_hit_any = True

        max_red = max(ticket_red_hits)
        results.append({
            "issue": actual["issue"],
            "actual_reds": sorted(actual_reds),
            "actual_blue": actual_blue,
            "ticket_red_hits": ticket_red_hits,
            "max_red": max_red,
            "blue_hit": blue_hit_any,
            "tickets": tickets,
        })

    # 汇总统计
    total = len(results)
    if total == 0:
        return {"name": config_name, "total": 0}

    ge4 = sum(1 for r in results if r["max_red"] >= 4)
    ge3 = sum(1 for r in results if r["max_red"] >= 3)
    ge2 = sum(1 for r in results if r["max_red"] >= 2)
    blue_hits = sum(1 for r in results if r["blue_hit"])
    avg_max_red = sum(r["max_red"] for r in results) / total

    # 每注红球命中分布
    all_ticket_reds = [h for r in results for h in r["ticket_red_hits"]]
    red_dist = Counter(all_ticket_reds)

    # 详细列出 ≥4红 的期次
    big_hits = [r for r in results if r["max_red"] >= 4]

    return {
        "name": config_name,
        "total": total,
        "p_ge4": ge4 / total,
        "p_ge3": ge3 / total,
        "p_ge2": ge2 / total,
        "blue_rate": blue_hits / total,
        "avg_max_red": avg_max_red,
        "ge4_count": ge4,
        "ge3_count": ge3,
        "red_dist": red_dist,
        "big_hits": big_hits,
        "all_results": results,
    }


def print_report(stats: dict) -> None:
    name = stats["name"]
    total = stats["total"]
    if total == 0:
        print(f"\n[{name}] 无有效回测数据")
        return

    print(f"\n[{name}] 回测 {total} 期")
    print(f"  P(≥4红命中任意注) = {stats['p_ge4']:.2%}  ({stats['ge4_count']}/{total})")
    print(f"  P(≥3红命中任意注) = {stats['p_ge3']:.2%}  ({stats['ge3_count']}/{total})")
    print(f"  P(≥2红命中任意注) = {stats['p_ge2']:.2%}")
    print(f"  蓝球命中率        = {stats['blue_rate']:.2%}")
    print(f"  平均最高红球命中  = {stats['avg_max_red']:.3f}")

    rd = stats["red_dist"]
    total_tickets = sum(rd.values())
    print(f"  单注红球命中分布（共{total_tickets}注）:")
    for k in sorted(rd.keys()):
        cnt = rd[k]
        pct = cnt / total_tickets * 100
        print(f"    {k}红: {cnt}注 ({pct:.1f}%)")

    # 列出 ≥4红 的期次详情
    big = stats["big_hits"]
    if big:
        print(f"  --- ≥4红命中期次详情 ({len(big)}期) ---")
        for r in big:
            red_str = " ".join(f"{n:02d}" for n in r["actual_reds"])
            print(f"    {r['issue']}期 实际:{red_str}+{r['actual_blue']:02d} "
                  f"各注红中:{r['ticket_red_hits']} 蓝中:{'是' if r['blue_hit'] else '否'}")
    else:
        print(f"  --- 无 ≥4红命中期次 ---")


def main():
    parser = argparse.ArgumentParser(description="双色球预测算法回测")
    parser.add_argument("--periods", type=int, default=50,
                        help="回测最近N期（默认50）")
    parser.add_argument("--no-update", action="store_true", help="不联网更新")
    args = parser.parse_args()

    db.init_db()
    if not args.no_update:
        try:
            sync_game("ssq", db)
        except Exception as e:
            print(f"联网更新失败，使用本地数据：{e}")

    rows = db.get_all_draws("ASC")
    print(f"历史数据 {len(rows)} 期，回测最近 {args.periods} 期")

    # 全量数据回测（3476期）：200期前向验证，测试窗口与alpha的稳健性
    # 配置格式: (名称, max_overlap, alpha, train_window, candidate_count)
    configs = [
        # 基线：覆盖模式（原默认）
        ("覆盖-全历史-α0.1", 3, 0.1, None, 500),
        # 精度模式 + 不同窗口
        ("精度-近50期-α0.2", 6, 0.2, 50, 1000),
        ("精度-近100期-α0.2", 6, 0.2, 100, 1000),
        ("精度-近200期-α0.2", 6, 0.2, 200, 1000),
        # 精度模式 + 不同alpha（50期窗口）
        ("精度-近50期-α0.1", 6, 0.1, 50, 1000),
        ("精度-近50期-α0.3", 6, 0.3, 50, 1000),
        # 精度模式 + 全历史
        ("精度-全历史-α0.1", 6, 0.1, None, 1000),
        ("精度-全历史-α0.2", 6, 0.2, None, 1000),
    ]

    all_stats = []
    for name, mo, al, tw, cc in configs:
        print(f"\n>>> 正在回测配置: {name}")
        stats = backtest_config(
            rows, name, mo, al, tw, args.periods,
            candidate_count=cc,
        )
        all_stats.append(stats)
        print_report(stats)

    # 汇总对比
    print("\n" + "=" * 70)
    print("配置对比汇总")
    print("=" * 70)
    print(f"{'配置':<25s} {'P(≥4红)':>8s} {'P(≥3红)':>8s} {'蓝球率':>8s} {'均最高红':>9s}")
    print("-" * 70)
    for s in all_stats:
        if s["total"] == 0:
            continue
        print(f"{s['name']:<25s} {s['p_ge4']:>7.2%} {s['p_ge3']:>7.2%} "
              f"{s['blue_rate']:>7.2%} {s['avg_max_red']:>8.3f}")

    # 找最优
    best = max(all_stats, key=lambda s: (s.get("p_ge4", 0), s.get("p_ge3", 0)))
    print(f"\n最优配置（按P(≥4红)优先）：{best['name']}")
    print(f"  P(≥4红) = {best.get('p_ge4', 0):.2%}")
    print(f"  P(≥3红) = {best.get('p_ge3', 0):.2%}")


if __name__ == "__main__":
    main()
