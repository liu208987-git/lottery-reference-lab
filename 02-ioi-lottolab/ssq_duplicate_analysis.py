"""双色球历史开奖号码重复概率分析

从 ssq.db 读取所有历史开奖数据，统计：
1. 完全相同（红球+蓝球）的开奖号码组合
2. 仅红球相同的组合
3. 仅蓝球相同的组合
4. 重复组合的出现次数与概率

运行：python ssq_duplicate_analysis.py
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import ssq_db


def analyze():
    ssq_db.init_db()
    draws = ssq_db.get_all_draws("ASC")
    n = len(draws)
    print("=" * 70)
    print("  双色球历史开奖号码重复概率分析")
    print("=" * 70)
    print(f"\n总期数: {n}")
    print(f"首期: {draws[0]['issue']}  末期: {draws[-1]['issue']}")

    # 构造组合 key
    full_keys = []      # 红球+蓝球
    red_keys = []       # 仅红球
    blue_keys = []      # 仅蓝球
    for d in draws:
        reds = tuple(d[f"r{i}"] for i in range(1, 7))
        blue = d["b1"]
        full_keys.append(reds + (blue,))
        red_keys.append(reds)
        blue_keys.append((blue,))

    # 统计
    full_counter = Counter(full_keys)
    red_counter = Counter(red_keys)
    blue_counter = Counter(blue_keys)

    # ===== 1. 完全相同（红球+蓝球）=====
    print("\n" + "-" * 70)
    print("  1. 完全相同开奖号码（红球+蓝球全部一致）")
    print("-" * 70)
    full_dup = {k: c for k, c in full_counter.items() if c > 1}
    total_full_dup_periods = sum(full_dup.values())
    if full_dup:
        print(f"\n  发现 {len(full_dup)} 组完全相同的号码组合，共 {total_full_dup_periods} 期")
        print(f"  重复发生率: {total_full_dup_periods}/{n} = {total_full_dup_periods/n*100:.4f}%")
        print(f"\n  {'组合':<30} {'出现次数':>8} {'期号列表'}")
        print("  " + "-" * 65)
        # 找出对应期号
        combo_issues = {}
        for d in draws:
            reds = tuple(d[f"r{i}"] for i in range(1, 7))
            key = reds + (d["b1"],)
            combo_issues.setdefault(key, []).append(d["issue"])
        for combo, count in sorted(full_dup.items(), key=lambda x: -x[1]):
            reds_str = " ".join(f"{n:02d}" for n in combo[:6])
            blue_str = f"+ {combo[6]:02d}"
            issues = combo_issues[combo]
            print(f"  {reds_str} {blue_str:<5}  {count:>6}次   {', '.join(issues)}")
    else:
        print(f"\n  未发现任何完全相同的开奖号码组合")
        print(f"  重复发生率: 0/{n} = 0.0000%")

    # ===== 2. 仅红球相同 =====
    print("\n" + "-" * 70)
    print("  2. 仅红球相同（忽略蓝球）")
    print("-" * 70)
    red_dup = {k: c for k, c in red_counter.items() if c > 1}
    total_red_dup = sum(red_dup.values())
    if red_dup:
        print(f"\n  发现 {len(red_dup)} 组红球相同组合，共 {total_red_dup} 期")
        print(f"  红球重复率: {total_red_dup}/{n} = {total_red_dup/n*100:.4f}%")
        print(f"\n  Top 10 出现次数最多的红球组合:")
        print(f"  {'红球':<25} {'次数':>6}")
        print("  " + "-" * 35)
        for combo, count in sorted(red_dup.items(), key=lambda x: -x[1])[:10]:
            reds_str = " ".join(f"{n:02d}" for n in combo)
            print(f"  {reds_str:<25} {count:>4}次")
    else:
        print(f"\n  未发现红球相同的组合")

    # ===== 3. 理论概率对比 =====
    print("\n" + "-" * 70)
    print("  3. 理论概率对比")
    print("-" * 70)
    from math import comb
    red_combos = comb(33, 6)
    full_combos = red_combos * 16
    print(f"  红球组合总数: C(33,6) = {red_combos:,}")
    print(f"  完整组合总数: C(33,6)*16 = {full_combos:,}")
    print(f"\n  单注中一等奖概率: 1/{full_combos:,} ≈ {1/full_combos*100:.8f}%")
    print(f"  历史开奖 {n} 期，理论上完全相同的期望次数:")
    # 生日悖论近似：P(至少一对相同) = 1 - (N!/(N^k * (N-k)!)) ≈ 1 - e^(-k(k-1)/(2N))
    expected_pairs = n * (n - 1) / (2 * full_combos)
    p_at_least_one_dup = 1 - (1 - 1/full_combos) ** (n * (n-1) / 2)
    print(f"    期望重复对数 ≈ {expected_pairs:.6f}")
    print(f"    至少出现1对重复的概率 ≈ {p_at_least_one_dup*100:.6f}%")
    print(f"\n  红球组合（忽略蓝球）:")
    expected_red_pairs = n * (n - 1) / (2 * red_combos)
    p_red_dup = 1 - (1 - 1/red_combos) ** (n * (n-1) / 2)
    print(f"    期望红球重复对数 ≈ {expected_red_pairs:.4f}")
    print(f"    至少1对红球重复的概率 ≈ {p_red_dup*100:.4f}%")

    # ===== 4. 综合结论 =====
    print("\n" + "=" * 70)
    print("  📊 综合结论")
    print("=" * 70)
    actual_full = len(full_dup)
    actual_red = len(red_dup)
    print(f"""
  历史开奖 {n} 期数据:
  ┌──────────────────────────────────────────────────────────┐
  │ 完全相同（红+蓝）重复组数: {actual_full:>6}                              │
  │   实际重复期数:        {total_full_dup_periods:>6} / {n}                       │
  │   实际重复率:          {total_full_dup_periods/n*100 if total_full_dup_periods else 0:.4f}%                              │
  │   理论至少1对重复概率: {p_at_least_one_dup*100:.6f}%                              │
  ├──────────────────────────────────────────────────────────┤
  │ 红球相同重复组数:      {actual_red:>6}                              │
  │   实际红球重复率:      {total_red_dup/n*100:.4f}%                              │
  │   理论至少1对重复概率: {p_red_dup*100:.4f}%                              │
  └──────────────────────────────────────────────────────────┘

  说明:
  - 双色球完整组合空间约 {full_combos:,} 种，历史 {n} 期相对总量极小
  - 在如此庞大的组合空间下，历史 {n} 期内出现完全相同开奖号码的概率
    理论上约 {p_at_least_one_dup*100:.6f}%，{'实际确实未出现重复' if actual_full == 0 else '实际出现了重复（罕见事件）'}
  - {'当前未观察到任何完全相同的开奖号码组合，与理论预期一致。' if actual_full == 0 else '出现了完全重复，需进一步核查数据准确性。'}
  - 红球组合空间 {red_combos:,}，{'已出现红球重复' if actual_red > 0 else '未出现红球重复'}（理论概率 {p_red_dup*100:.4f}%）
""")


if __name__ == "__main__":
    analyze()
