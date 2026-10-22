"""大乐透快速回测：找最优参数配置

大乐透概率分析（5选35 + 2选12）：
- P(4红)/注 ≈ 0.046% — 100期回测中期望0.23次，统计意义极低
- P(3红)/注 ≈ 1.34% — 5注/期，100期期望约6.7次，是有效优化目标
- P(2蓝)/注 ≈ 15.2% — 蓝球命中率是关键差异化指标

大乐透有效中奖门槛：
- 六等奖 3+2（200元）— 回测中可达的实际目标
- 八等奖 3+1 / 2+2（15元）— 覆盖率指标
- 九等奖 3+0 / 2+1 / 1+2 / 0+2（5元）— 保底

评分公式：P(≥3红)*10 + P(3红+2蓝)*30 + 蓝球率*5
"""

import dlt_db as db
from auto_optimizer import _backtest_config

RED_POOL = 35
RED_PICK = 5
BLUE_POOL = 12
BLUE_PICK = 2


def main():
    db.init_db()
    draws = db.get_all_draws("ASC")
    print(f"大乐透历史数据：{len(draws)}期 ({draws[0]['issue']}~{draws[-1]['issue']})")

    periods = 200
    configs = [
        (50, 0.1, 500),
        (50, 0.15, 1000),
        (50, 0.2, 1000),
        (80, 0.1, 1000),
        (80, 0.15, 1000),
        (80, 0.2, 1000),
        (100, 0.1, 1000),
        (100, 0.15, 1000),
        (100, 0.2, 1000),
        (100, 0.2, 1500),
        (150, 0.15, 1000),
        (150, 0.2, 1000),
        (200, 0.1, 1000),
        (200, 0.15, 1000),
        (200, 0.2, 1000),
    ]

    print(f"\n回测最近{periods}期，测试{len(configs)}个配置")
    print("=" * 95)
    print(f"{'配置':<28} {'P(3+2蓝)':>9} {'P(≥3红)':>8} {'P(≥2红)':>8} {'蓝球率':>8} "
          f"{'P(2蓝)':>8} {'均红':>6} {'均蓝':>6} {'评分':>6}")
    print("=" * 95)

    all_results = []
    for window, alpha, cc in configs:
        stats = _backtest_config(
            draws, RED_POOL, RED_PICK, BLUE_POOL, BLUE_PICK,
            max_overlap=RED_PICK,
            alpha=alpha,
            train_window=window,
            periods=periods,
            candidate_count=cc,
        )

        # 计算P(3红+2蓝)和P(2蓝全中)
        p_3r_2b = sum(
            1 for r in stats["results"]
            if r["max_red"] >= 3 and r.get("best_blue", 0) >= 2
        ) / stats["total"] if stats["total"] > 0 else 0

        p_2b_any = sum(
            1 for r in stats["results"]
            if max(r.get("ticket_blue_hits", [0])) >= 2
        ) / stats["total"] if stats["total"] > 0 else 0

        p_ge2 = sum(1 for r in stats["results"] if r["max_red"] >= 2) / stats["total"]

        # 评分：六等奖(3+2)为主，≥3红为辅，蓝球覆盖为参考
        score = stats["p_ge3"] * 10 + p_3r_2b * 30 + stats["blue_rate"] * 5

        name = f"win{window}_a{alpha}_c{cc}"
        avg_blue = sum(
            max(r.get("ticket_blue_hits", [0])) for r in stats["results"]
        ) / stats["total"] if stats["total"] > 0 else 0

        print(f"{name:<28} {p_3r_2b:>8.1%} {stats['p_ge3']:>7.1%} {p_ge2:>7.1%} "
              f"{stats['blue_rate']:>7.1%} {p_2b_any:>7.1%} "
              f"{stats['avg_max_red']:>5.2f} {avg_blue:>5.2f} {score:>5.1f}")

        all_results.append({
            "config": name,
            "window": window,
            "alpha": alpha,
            "candidates": cc,
            "score": score,
            "p_3r_2b": p_3r_2b,
            "p_ge3": stats["p_ge3"],
            "p_ge2": p_ge2,
            "blue_rate": stats["blue_rate"],
            "p_2b_any": p_2b_any,
            "avg_max_red": stats["avg_max_red"],
            "avg_blue": avg_blue,
            "results": stats["results"],
        })

    # 找最优
    all_results.sort(key=lambda x: -x["score"])
    best = all_results[0]
    print("\n" + "=" * 95)
    print(f"最优配置：{best['config']}  评分={best['score']:.1f}")
    print(f"  P(3+2蓝)={best['p_3r_2b']:.1%}  P(≥3红)={best['p_ge3']:.1%}  "
          f"P(≥2红)={best['p_ge2']:.1%}  蓝球率={best['blue_rate']:.1%}")

    # 显示3红以上命中详情
    print(f"\n命中3红以上的期次：")
    count = 0
    for r in best["results"]:
        if r["max_red"] >= 3:
            print(f"  {r['issue']}: {r['max_red']}红+{r['best_blue']}蓝 "
                  f"(红球: {r['ticket_red_hits']}, 蓝球: {r['ticket_blue_hits']})")
            count += 1
    if count == 0:
        print("  无")


if __name__ == "__main__":
    main()
