"""实验性预测器：基于位置感知+指数衰减+节奏检测+动量趋势的改进算法。

核心改进：
1. 位置感知概率建模：每个红球位置有独立的有效范围和分布
2. 指数衰减加权：近期开奖权重更高（半衰期=14期）
3. 振荡节奏检测：检测每个号码的周期性出现模式
4. 邻号引力：上期开奖号码的±1±2邻号有更高概率
5. 趋势动量：号码频率是否在加速或减速
6. 多模型蓝球共识：4个模型投票选出蓝球
7. 覆盖优先组合选择：确保5注覆盖尽可能多的不同号码

算法版本标识：
- ssq-experimental-v7  /  dlt-experimental-v7
"""

from __future__ import annotations

import math
import random
from collections import Counter
from itertools import combinations
from hashlib import sha256


# ============================================================
# 1. 位置感知概率建模
# ============================================================

def position_frequency(
    draws: list[dict],
    red_pick: int,
    red_pool: int,
    decay_lambda: float = 0.05,
) -> list[dict[int, float]]:
    """按位置计算指数衰减加权频率。

    Returns:
        list of dict: position_freq[pos][number] = 归一化概率
        每个位置一份独立分布，位置0=最小号码，位置red_pick-1=最大号码
    """
    n = len(draws)
    # 指数衰减权重
    weights = [math.exp(-decay_lambda * (n - 1 - i)) for i in range(n)]
    total_weight = sum(weights)

    # 每个位置的计数
    pos_counts = [Counter() for _ in range(red_pick)]
    for i, draw in enumerate(draws):
        w = weights[i]
        reds = sorted(draw[f"r{j}"] for j in range(1, red_pick + 1))
        for pos in range(red_pick):
            pos_counts[pos][reds[pos]] += w

    # 归一化到概率
    result = []
    for pos in range(red_pick):
        probs = {}
        pos_total = sum(pos_counts[pos].values())
        for num in range(1, red_pool + 1):
            probs[num] = pos_counts[pos].get(num, 0) / max(pos_total, 1e-10)
        # 平滑：给每个号码至少一个最小概率
        min_prob = 0.001 / red_pool
        for num in range(1, red_pool + 1):
            probs[num] = max(probs[num], min_prob)
        # 重新归一化
        s = sum(probs.values())
        for num in probs:
            probs[num] /= s
        result.append(probs)
    return result


def position_valid_ranges(red_pick: int, red_pool: int) -> list[tuple[int, int]]:
    """每个位置的有效号码范围。"""
    ranges = []
    for pos in range(red_pick):
        lo = pos + 1  # 前面至少有pos个更小的号码
        hi = red_pool - (red_pick - pos - 1)  # 后面至少有red_pick-pos-1个更大的号码
        ranges.append((lo, hi))
    return ranges


# ============================================================
# 2. 振荡节奏检测
# ============================================================

def detect_rhythm(
    draws: list[dict],
    red_pick: int,
    red_pool: int,
) -> dict[int, float]:
    """检测每个号码的周期性出现模式。

    对每个号码：
    - 计算出现间隔的平均值和标准差
    - 评分 = 当前距上次出现 / 平均间隔，接近1.0表示"该出现了"
    - 间隔越规律（标准差越小），置信度越高

    Returns:
        dict: rhythm_score[number] = 0.0~2.0（>1.0表示逾期未出）
    """
    n = len(draws)
    # 记录每个号码的出现期号索引
    appearances: dict[int, list[int]] = {num: [] for num in range(1, red_pool + 1)}
    for i, draw in enumerate(draws):
        for j in range(1, red_pick + 1):
            appearances[draw[f"r{j}"]].append(i)

    scores = {}
    for num in range(1, red_pool + 1):
        apps = appearances[num]
        if len(apps) < 2:
            scores[num] = 0.5  # 数据不足，中性
            continue

        # 计算间隔
        gaps = [apps[j + 1] - apps[j] for j in range(len(apps) - 1)]
        avg_gap = sum(gaps) / len(gaps)
        std_gap = math.sqrt(sum((g - avg_gap) ** 2 for g in gaps) / len(gaps))

        # 距上次出现
        last_seen = n - 1 - apps[-1]

        # 节奏评分：当前距上次 / 平均间隔
        if avg_gap > 0:
            rhythm_ratio = last_seen / avg_gap
        else:
            rhythm_ratio = 0.5

        # 规律性评分：标准差越小越规律
        regularity = 1.0 / (1.0 + std_gap / max(avg_gap, 1))

        # 综合评分：该出现时(ratio≈1.0)得分最高，规律性加权
        if rhythm_ratio >= 0.8:
            # 已经到了或过了预期出现时间
            scores[num] = min(2.0, rhythm_ratio * regularity)
        else:
            # 还没到预期时间
            scores[num] = max(0.1, rhythm_ratio * regularity)

    return scores


# ============================================================
# 3. 邻号引力
# ============================================================

def neighbor_attraction(
    draws: list[dict],
    red_pick: int,
    red_pool: int,
) -> dict[int, float]:
    """上期号码的邻号(±1, ±2)出现概率更高。

    计算每个号码作为邻号出现的条件概率。

    Returns:
        neighbor_score[number] = 归一化邻号引力分数
    """
    n = len(draws)
    neighbor_counts: Counter = Counter()
    total_opportunities = 0

    for i in range(1, n):
        prev_reds = set(draws[i - 1][f"r{j}"] for j in range(1, red_pick + 1))
        curr_reds = set(draws[i][f"r{j}"] for j in range(1, red_pick + 1))

        for prev_r in prev_reds:
            for offset in [-2, -1, 1, 2]:
                neighbor = prev_r + offset
                if 1 <= neighbor <= red_pool:
                    total_opportunities += 1
                    if neighbor in curr_reds:
                        neighbor_counts[neighbor] += 1

    # 归一化
    scores = {}
    for num in range(1, red_pool + 1):
        if total_opportunities > 0:
            scores[num] = neighbor_counts.get(num, 0) / max(total_opportunities / red_pool, 1)
        else:
            scores[num] = 1.0
    return scores


# ============================================================
# 4. 趋势动量
# ============================================================

def trend_momentum(
    draws: list[dict],
    red_pick: int,
    red_pool: int,
    recent_window: int = 20,
    long_window: int = 100,
) -> dict[int, float]:
    """检测号码频率的趋势：近期 vs 长期。

    - 动量 > 1.0：近期频率高于长期（加速/升温）
    - 动量 < 1.0：近期频率低于长期（减速/降温）

    Returns:
        momentum[number] = recent_freq / long_freq
    """
    n = len(draws)
    recent = draws[-min(recent_window, n):]
    long_term = draws[-min(long_window, n):]

    recent_counts = Counter()
    for draw in recent:
        for j in range(1, red_pick + 1):
            recent_counts[draw[f"r{j}"]] += 1

    long_counts = Counter()
    for draw in long_term:
        for j in range(1, red_pick + 1):
            long_counts[draw[f"r{j}"]] += 1

    recent_total = sum(recent_counts.values())
    long_total = sum(long_counts.values())

    scores = {}
    for num in range(1, red_pool + 1):
        recent_freq = recent_counts.get(num, 0) / max(recent_total, 1)
        long_freq = long_counts.get(num, 0) / max(long_total, 1)
        if long_freq > 0:
            scores[num] = recent_freq / long_freq
        else:
            scores[num] = 1.0 if recent_freq > 0 else 0.5

    return scores


# ============================================================
# 5. 综合号码评分
# ============================================================

def composite_number_score(
    draws: list[dict],
    red_pick: int,
    red_pool: int,
    pos_freq: list[dict[int, float]],
    rhythm: dict[int, float],
    neighbor: dict[int, float],
    momentum: dict[int, float],
    pos_weights: list[float] | None = None,
) -> dict[int, float]:
    """综合评分 = 位置频率 + 节奏 + 邻号 + 动量。

    权重：位置频率 0.40, 节奏 0.25, 邻号 0.20, 动量 0.15
    """
    if pos_weights is None:
        pos_weights = [0.40, 0.25, 0.20, 0.15]

    # 聚合位置频率：取所有位置中该号码的最高概率
    combined_scores = {}
    for num in range(1, red_pool + 1):
        pos_prob = max(pos_freq[pos][num] for pos in range(red_pick))
        rhythm_score = rhythm.get(num, 0.5)
        neighbor_score = neighbor.get(num, 1.0)
        momentum_score = momentum.get(num, 1.0)

        combined_scores[num] = (
            pos_prob * pos_weights[0]
            + rhythm_score * pos_weights[1]
            + neighbor_score * pos_weights[2]
            + momentum_score * pos_weights[3]
        )

    # 归一化
    total = sum(combined_scores.values())
    if total > 0:
        for num in combined_scores:
            combined_scores[num] /= total / red_pool

    return combined_scores


# ============================================================
# 6. 多模型蓝球共识
# ============================================================

def blue_consensus_vote(
    draws: list[dict],
    blue_pool: int,
    blue_pick: int,
    prev_blue: int | None = None,
    top_k: int = 4,
) -> list[int]:
    """多模型蓝球共识投票。

    模型A：指数衰减频率（近期权重高）
    模型B：最近10期趋势
    模型C：奇偶交替模式
    模型D：遗漏值分析

    每个模型选出top_k个候选，按共识频率排序。

    Returns:
        list[int]: 共识排序后的蓝球候选列表
    """
    n = len(draws)

    # 模型A：指数衰减频率
    decay_weights = [math.exp(-0.05 * (n - 1 - i)) for i in range(n)]
    model_a_counts = Counter()
    for i, draw in enumerate(draws):
        w = decay_weights[i]
        for j in range(1, blue_pick + 1):
            model_a_counts[draw[f"b{j}"]] += w

    # 模型B：最近10期简单频率
    recent = draws[-10:]
    model_b_counts = Counter()
    for draw in recent:
        for j in range(1, blue_pick + 1):
            model_b_counts[draw[f"b{j}"]] += 1

    # 模型C：奇偶交替模式
    model_c_scores = {}
    if prev_blue is not None:
        prev_parity = prev_blue % 2
        # 如果上期奇→本期倾向于偶（交替），反之亦然
        target_parity = 1 - prev_parity
        for num in range(1, blue_pool + 1):
            if num % 2 == target_parity:
                model_c_scores[num] = 1.5
            else:
                model_c_scores[num] = 0.5
    else:
        for num in range(1, blue_pool + 1):
            model_c_scores[num] = 1.0

    # 模型D：遗漏值分析
    # 距上次出现越久，越可能出现
    last_seen = {}
    for num in range(1, blue_pool + 1):
        last_seen[num] = n  # 从未出现
    for i, draw in enumerate(draws):
        for j in range(1, blue_pick + 1):
            last_seen[draw[f"b{j}"]] = n - 1 - i
    model_d_scores = {}
    for num in range(1, blue_pool + 1):
        # 归一化：遗漏值越大分越高
        model_d_scores[num] = last_seen[num] / max(n, 1)

    # 每个模型选出top_k
    def top_k_from_counter(counter, k):
        sorted_items = sorted(counter.items(), key=lambda x: -x[1])
        return [item[0] for item in sorted_items[:k]]

    def top_k_from_dict(scores, k):
        sorted_items = sorted(scores.items(), key=lambda x: -x[1])
        return [item[0] for item in sorted_items[:k]]

    model_a_top = top_k_from_counter(model_a_counts, top_k)
    model_b_top = top_k_from_counter(model_b_counts, top_k)
    model_c_top = top_k_from_dict(model_c_scores, top_k)
    model_d_top = top_k_from_dict(model_d_scores, top_k)

    # 共识投票：统计每个号码被几个模型选中
    consensus = Counter()
    for num in model_a_top:
        consensus[num] += 1
    for num in model_b_top:
        consensus[num] += 1
    for num in model_c_top:
        consensus[num] += 1
    for num in model_d_top:
        consensus[num] += 1

    # 按共识频率排序，相同共识频率按模型A频率排序
    sorted_consensus = sorted(
        range(1, blue_pool + 1),
        key=lambda n: (consensus.get(n, 0), model_a_counts.get(n, 0)),
        reverse=True,
    )

    return sorted_consensus


def blue_consensus_pairs(
    draws: list[dict],
    blue_pool: int,
    prev_blue: int | None = None,
    top_k: int = 4,
) -> list[tuple[int, int]]:
    """大乐透蓝球配对共识：从共识候选中选择低重叠的配对。"""
    consensus_order = blue_consensus_vote(
        draws, blue_pool, 2, prev_blue, top_k=top_k)

    # 从共识排序中生成配对，优先用高位候选
    pairs = []
    used = set()
    for i, b1 in enumerate(consensus_order):
        for j, b2 in enumerate(consensus_order):
            if i >= j:
                continue
            pair = (min(b1, b2), max(b1, b2))
            if pair in pairs:
                continue
            # 优先使用未覆盖的蓝球
            if b1 not in used and b2 not in used:
                pairs.append(pair)
                used.add(b1)
                used.add(b2)
            elif len(pairs) < 5:
                pairs.append(pair)

    return pairs


# ============================================================
# 7. 加权采样生成候选组合
# ============================================================

def _weighted_permutation(rng, pool_size, probabilities):
    """Plackett-Luce 加权排列。"""
    if probabilities is None:
        values = list(range(1, pool_size + 1))
        rng.shuffle(values)
        return values
    return sorted(
        range(1, pool_size + 1),
        key=lambda n: -math.log(max(rng.random(), 1e-15))
        / max(probabilities.get(n, 1e-12), 1e-12),
    )


def generate_red_candidates_positional(
    rng: random.Random,
    pos_freq: list[dict[int, float]],
    valid_ranges: list[tuple[int, int]],
    red_pick: int,
    red_pool: int,
    red_scores: dict[int, float],
    n_candidates: int = 2000,
) -> list[tuple[float, list[int]]]:
    """按位置独立采样生成红球候选组合。

    每个位置从其有效范围内按位置频率加权采样，
    然后按综合评分排序。
    """
    candidates = []
    for _ in range(n_candidates):
        reds = []
        used = set()
        for pos in range(red_pick):
            lo, hi = valid_ranges[pos]
            # 从有效范围内按位置频率采样
            valid_nums = [n for n in range(lo, hi + 1) if n not in used]
            if not valid_nums:
                # 回退到全局范围
                valid_nums = [n for n in range(1, red_pool + 1) if n not in used]

            weights = [pos_freq[pos].get(n, 1e-10) for n in valid_nums]
            total_w = sum(weights)
            r = rng.random() * total_w
            cumsum = 0.0
            chosen = valid_nums[-1]
            for n, w in zip(valid_nums, weights):
                cumsum += w
                if r <= cumsum:
                    chosen = n
                    break
            reds.append(chosen)
            used.add(chosen)

        reds.sort()
        # 综合评分 = 位置频率对数 + 综合评分
        pos_score = sum(math.log(max(pos_freq[pos].get(reds[pos], 1e-10), 1e-10))
                        for pos in range(red_pick))
        if red_scores:
            composite_score = sum(math.log(max(red_scores.get(n, 1e-10), 1e-10))
                                  for n in reds)
            total_score = pos_score * 0.6 + composite_score * 0.4
        else:
            total_score = pos_score

        candidates.append((total_score, reds))

    candidates.sort(key=lambda x: -x[0])
    return candidates


# ============================================================
# 8. 覆盖优先组合选择
# ============================================================

def coverage_first_selection(
    candidates: list[tuple[float, list[int]]],
    ticket_count: int = 5,
    red_pick: int = 6,
    max_overlap: int = 2,
    min_coverage: int = 28,
) -> list[list[int]]:
    """覆盖优先的贪心选择。

    1. 第一轮：按评分选择，确保低重叠
    2. 第二轮：如果覆盖不足，放宽限制补充

    Args:
        candidates: [(score, reds), ...] 按评分降序排列
        ticket_count: 需要的注数
        red_pick: 每注红球数
        max_overlap: 最大允许重叠数
        min_coverage: 最小覆盖号码数（SSQ:28, DLT:21）
    """
    selected = []
    covered = set()

    # 第一轮：贪婪选择
    for score, reds in candidates:
        if len(selected) >= ticket_count:
            break
        # 检查重叠
        ok = True
        for sel_reds in selected:
            if len(set(reds) & set(sel_reds)) > max_overlap:
                ok = False
                break
        if ok:
            selected.append(reds)
            covered.update(reds)

    # 第二轮：放宽重叠限制，确保覆盖
    if len(selected) < ticket_count:
        for score, reds in candidates:
            if len(selected) >= ticket_count:
                break
            if reds in selected:
                continue
            selected.append(reds)
            covered.update(reds)

    # 第三轮：如果覆盖率不足，替换低覆盖组合
    if len(covered) < min_coverage and len(selected) >= ticket_count:
        # 尝试从候选池中找能增加覆盖的组合
        for score, reds in candidates:
            if reds in selected:
                continue
            new_covered = set(reds)
            # 找到覆盖最少的票
            worst_idx = -1
            worst_unique = 999
            for idx, sel_reds in enumerate(selected):
                other_covered = set()
                for jdx, other_reds in enumerate(selected):
                    if jdx != idx:
                        other_covered.update(other_reds)
                unique_to_this = set(sel_reds) - other_covered
                if len(unique_to_this) < worst_unique:
                    worst_unique = len(unique_to_this)
                    worst_idx = idx

            if worst_idx >= 0:
                new_total = (covered - set(selected[worst_idx])) | new_covered
                if len(new_total) > len(covered):
                    selected[worst_idx] = reds
                    covered = new_total

    return selected


# ============================================================
# 9. 主入口：v7实验性预测
# ============================================================

def build_experimental_v7(
    rng: random.Random,
    draws: list[dict],
    red_pool: int,
    red_pick: int,
    blue_pool: int,
    blue_pick: int,
    ticket_count: int = 5,
    red_scores: dict[int, float] | None = None,
    blue_scores: dict[int, float] | None = None,
    alpha: float = 0.1,
    n_candidates: int = 2000,
    decay_lambda: float = 0.05,
) -> list[tuple[list[int], list[int]]]:
    """v7实验性预测：位置感知+指数衰减+节奏检测+邻号引力+动量+蓝球共识。

    流程：
    1. 位置感知频率建模（指数衰减加权）
    2. 振荡节奏检测
    3. 邻号引力计算
    4. 趋势动量计算
    5. 综合号码评分
    6. 位置感知红球候选生成
    7. 覆盖优先组合选择
    8. 多模型蓝球共识投票
    9. 红蓝组合输出
    """
    # 1. 位置感知频率
    pos_freq = position_frequency(draws, red_pick, red_pool, decay_lambda)
    valid_ranges = position_valid_ranges(red_pick, red_pool)

    # 2. 节奏检测
    rhythm = detect_rhythm(draws, red_pick, red_pool)

    # 3. 邻号引力
    neighbor = neighbor_attraction(draws, red_pick, red_pool)

    # 4. 趋势动量
    momentum = trend_momentum(draws, red_pick, red_pool)

    # 5. 综合评分
    composite = composite_number_score(
        draws, red_pick, red_pool, pos_freq, rhythm, neighbor, momentum)

    # 如果传入了外部red_scores（量化模型），融合
    if red_scores:
        for n in range(1, red_pool + 1):
            composite[n] = (1 - alpha) * composite[n] + alpha * red_scores.get(n, 1.0)

    # 6. 位置感知候选生成
    red_candidates = generate_red_candidates_positional(
        rng, pos_freq, valid_ranges, red_pick, red_pool,
        composite, n_candidates)

    # 7. 覆盖优先选择
    min_coverage = 28 if red_pool == 33 else 21
    max_overlap = max(1, red_pick - 3)
    selected_reds = coverage_first_selection(
        red_candidates, ticket_count, red_pick, max_overlap, min_coverage)

    # 8. 蓝球共识
    prev_blue = draws[-1]["b1"] if blue_pick == 1 else None
    if blue_pick == 1:
        # SSQ: 单蓝球，共识投票选5个不同蓝球
        blue_order = blue_consensus_vote(
            draws, blue_pool, blue_pick, prev_blue, top_k=5)
        if blue_scores:
            # 融合外部蓝球评分
            blue_order.sort(key=lambda n: (
                blue_order.index(n) if n in blue_order else 999,
                -(blue_scores.get(n, 1.0))
            ))
        selected_blues = [[blue_order[i]]
                          for i in range(min(ticket_count, len(blue_order)))]
    else:
        # DLT: 蓝球配对共识
        pairs = blue_consensus_pairs(draws, blue_pool, prev_blue, top_k=6)
        selected_blues = [list(pair)
                          for pair in pairs[:ticket_count]]

    # 补齐
    while len(selected_reds) < ticket_count:
        selected_reds.append(selected_reds[-1] if selected_reds
                             else list(range(1, red_pick + 1)))
    while len(selected_blues) < ticket_count:
        selected_blues.append(selected_blues[-1] if selected_blues
                              else list(range(1, blue_pick + 1)))

    return list(zip(selected_reds[:ticket_count], selected_blues[:ticket_count]))


# ============================================================
# 10. 简化版：纯位置感知+覆盖优先（v7-lite）
# ============================================================

def build_experimental_v7_lite(
    rng: random.Random,
    draws: list[dict],
    red_pool: int,
    red_pick: int,
    blue_pool: int,
    blue_pick: int,
    ticket_count: int = 5,
    red_scores: dict[int, float] | None = None,
    blue_scores: dict[int, float] | None = None,
    alpha: float = 0.1,
    n_candidates: int = 2000,
    decay_lambda: float = 0.05,
) -> list[tuple[list[int], list[int]]]:
    """v7-lite：仅位置感知 + 覆盖优先 + 蓝球共识（去掉节奏/邻号/动量）。

    更轻量，适合快速验证位置感知是否有效。
    """
    # 位置感知频率
    pos_freq = position_frequency(draws, red_pick, red_pool, decay_lambda)
    valid_ranges = position_valid_ranges(red_pick, red_pool)

    # 全局频率（软融合用）
    global_counts = Counter()
    for draw in draws:
        for j in range(1, red_pick + 1):
            global_counts[draw[f"r{j}"]] += 1
    total_g = sum(global_counts.values())
    global_freq = {n: global_counts.get(n, 0) / max(total_g, 1)
                   for n in range(1, red_pool + 1)}

    # 融合位置频率和全局频率
    composite = {}
    for n in range(1, red_pool + 1):
        pos_prob = max(pos_freq[pos][n] for pos in range(red_pick))
        composite[n] = pos_prob * 0.7 + global_freq[n] * 0.3
    if red_scores:
        for n in range(1, red_pool + 1):
            composite[n] = (1 - alpha) * composite[n] + alpha * red_scores.get(n, 1.0)

    # 位置感知候选生成
    red_candidates = generate_red_candidates_positional(
        rng, pos_freq, valid_ranges, red_pick, red_pool,
        composite, n_candidates)

    # 覆盖优先选择
    min_coverage = 28 if red_pool == 33 else 21
    max_overlap = max(1, red_pick - 3)
    selected_reds = coverage_first_selection(
        red_candidates, ticket_count, red_pick, max_overlap, min_coverage)

    # 蓝球共识
    prev_blue = draws[-1]["b1"] if blue_pick == 1 else None
    if blue_pick == 1:
        blue_order = blue_consensus_vote(
            draws, blue_pool, blue_pick, prev_blue, top_k=5)
        if blue_scores:
            blue_order.sort(key=lambda n: (
                blue_order.index(n) if n in blue_order else 999,
                -(blue_scores.get(n, 1.0))
            ))
        selected_blues = [[blue_order[i]]
                          for i in range(min(ticket_count, len(blue_order)))]
    else:
        pairs = blue_consensus_pairs(draws, blue_pool, prev_blue, top_k=6)
        selected_blues = [list(pair) for pair in pairs[:ticket_count]]

    while len(selected_reds) < ticket_count:
        selected_reds.append(selected_reds[-1] if selected_reds
                             else list(range(1, red_pick + 1)))
    while len(selected_blues) < ticket_count:
        selected_blues.append(selected_blues[-1] if selected_blues
                              else list(range(1, blue_pick + 1)))

    return list(zip(selected_reds[:ticket_count], selected_blues[:ticket_count]))