"""融合预测器：三重优化生成低重叠票组。

优化策略：
1. 软信号混合：即使量化门控未通过门槛，也混入 10% 历史频率，
   给高频号码轻微倾斜，而非完全均匀。
2. 蓝球配对联合覆盖（大乐透2蓝球）：把2个蓝球作为配对单元，
   用历史配对频率加权选择，提高同一注命中2个蓝球的概率。
3. 红蓝联合优化：将蓝球分配到红球注时，优先匹配历史共现频率高的
   红蓝组合，改善同一注内红蓝同时命中的机会。
"""

from __future__ import annotations

import math
from collections import Counter
from itertools import combinations, permutations
import random
from typing import Callable

from lottery_predictor import _weighted_permutation


def historical_frequency(
    draws: list[dict], prefix: str, pick_count: int, pool_size: int
) -> dict[int, float]:
    """归一化历史频率：均值=1.0，高频>1，低频<1。"""
    counts = Counter()
    for draw in draws:
        for i in range(1, pick_count + 1):
            counts[draw[f"{prefix}{i}"]] += 1
    total = sum(counts.values())
    if total == 0:
        return {n: 1.0 for n in range(1, pool_size + 1)}
    avg = total / pool_size
    return {n: counts.get(n, 0) / avg for n in range(1, pool_size + 1)}


def soft_blend(
    base_probs: dict[int, float] | None,
    hist_freq: dict[int, float],
    pool_size: int,
    alpha: float = 0.1,
) -> dict[int, float]:
    """软混合：(1-alpha)*base + alpha*historical。base=None 时用均匀。"""
    if base_probs is not None:
        avg_base = sum(base_probs.values()) / len(base_probs)
        return {
            n: (1 - alpha) * base_probs[n] / avg_base + alpha * hist_freq[n]
            for n in range(1, pool_size + 1)
        }
    return {
        n: (1 - alpha) * 1.0 + alpha * hist_freq[n]
        for n in range(1, pool_size + 1)
    }


def blue_pair_weights(
    draws: list[dict],
    blue_probs: dict[int, float],
    blue_pool: int,
    alpha: float = 0.1,
) -> dict[tuple[int, int], float]:
    """大乐透蓝球配对权重：历史配对频率 + 单球概率几何平均。"""
    pair_counts: Counter = Counter()
    for draw in draws:
        pair = tuple(sorted([draw["b1"], draw["b2"]]))
        pair_counts[pair] += 1
    total = sum(pair_counts.values())
    avg = total / len(pair_counts) if pair_counts else 1.0

    weights = {}
    for pair in combinations(range(1, blue_pool + 1), 2):
        hist_freq = pair_counts.get(pair, 0) / avg
        prob_weight = (blue_probs[pair[0]] * blue_probs[pair[1]]) ** 0.5
        weights[pair] = (1 - alpha) * prob_weight + alpha * hist_freq
    return weights


def select_low_overlap_pairs(
    rng: random.Random,
    pair_weights: dict[tuple[int, int], float],
    ticket_count: int,
) -> list[list[int]]:
    """选择低重叠蓝球配对，优先使用未覆盖的蓝球。"""
    all_pairs = list(pair_weights.keys())
    chosen: list[tuple[int, int]] = []
    used_blues: set[int] = set()

    for _ in range(ticket_count):
        non_overlap = [
            p for p in all_pairs
            if p not in chosen and p[0] not in used_blues and p[1] not in used_blues
        ]
        candidates = non_overlap if non_overlap else [
            p for p in all_pairs if p not in chosen
        ]
        if not candidates:
            candidates = all_pairs

        weights = [pair_weights[p] for p in candidates]
        total = sum(weights)
        r = rng.random() * total
        cumsum = 0.0
        selected = candidates[-1]
        for pair, w in zip(candidates, weights):
            cumsum += w
            if r <= cumsum:
                selected = pair
                break

        chosen.append(selected)
        used_blues.add(selected[0])
        used_blues.add(selected[1])

    return [list(pair) for pair in chosen]


def red_blue_cooccurrence(
    draws: list[dict], red_pick: int, blue_pick: int
) -> dict[tuple[int, int], int]:
    """构建红蓝共现矩阵：{(red, blue): count}。"""
    coocc: Counter = Counter()
    for draw in draws:
        reds = [draw[f"r{i}"] for i in range(1, red_pick + 1)]
        blues = [draw[f"b{i}"] for i in range(1, blue_pick + 1)]
        for r in reds:
            for b in blues:
                coocc[(r, b)] += 1
    return dict(coocc)


def joint_optimize(
    red_tickets: list[list[int]],
    blue_tickets: list[list[int]],
    cooccurrence: dict[tuple[int, int], int],
) -> list[tuple[list[int], list[int]]]:
    """红蓝联合优化：找到使总历史共现得分最高的红蓝分配方案。"""
    n = len(red_tickets)
    scores = [[0.0] * n for _ in range(n)]
    for i, reds in enumerate(red_tickets):
        for j, blues in enumerate(blue_tickets):
            s = 0
            for r in reds:
                for b in blues:
                    s += cooccurrence.get((r, b), 0)
            scores[i][j] = s

    best_perm = list(range(n))
    best_score = sum(scores[i][i] for i in range(n))
    for perm in permutations(range(n)):
        s = sum(scores[i][perm[i]] for i in range(n))
        if s > best_score:
            best_score = s
            best_perm = list(perm)

    return [(red_tickets[i], blue_tickets[best_perm[i]]) for i in range(n)]


def build_optimized_portfolio(
    rng: random.Random,
    draws: list[dict],
    red_pool: int,
    red_pick: int,
    blue_pool: int,
    blue_pick: int,
    ticket_count: int,
    red_scores: dict[int, float] | None = None,
    blue_scores: dict[int, float] | None = None,
    alpha: float = 0.1,
) -> list[tuple[list[int], list[int]]]:
    """生成三重优化后的低重叠票组。

    1. 软信号混合：base_scores 与历史频率按 (1-alpha):alpha 混合
    2. 蓝球配对覆盖（blue_pick>=2 时）：历史配对频率加权选择
    3. 红蓝联合优化：最大化票内红蓝历史共现得分
    """
    # 1. 历史频率
    red_hist = historical_frequency(draws, "r", red_pick, red_pool)
    blue_hist = historical_frequency(draws, "b", blue_pick, blue_pool)

    # 2. 软混合概率
    red_probs = soft_blend(red_scores, red_hist, red_pool, alpha)
    blue_probs = soft_blend(blue_scores, blue_hist, blue_pool, alpha)

    # 3. 红球低重叠排列
    red_permutation = _weighted_permutation(rng, red_pool, red_probs)
    red_tickets = [
        sorted(red_permutation[i * red_pick:(i + 1) * red_pick])
        for i in range(ticket_count)
    ]

    # 4. 蓝球优化
    if blue_pick >= 2:
        pair_w = blue_pair_weights(draws, blue_probs, blue_pool, alpha)
        blue_tickets = select_low_overlap_pairs(rng, pair_w, ticket_count)
    else:
        blue_permutation = _weighted_permutation(rng, blue_pool, blue_probs)
        blue_tickets = [[blue_permutation[i]] for i in range(ticket_count)]

    # 5. 红蓝联合优化
    coocc = red_blue_cooccurrence(draws, red_pick, blue_pick)
    optimized = joint_optimize(red_tickets, blue_tickets, coocc)

    return optimized


# ============================================================
# 新浪走势指标增强模块
# 参考：红球走势/蓝球走势/连号走势/重号走势 + AC值/和值/大小/质合/012路/遗漏
# ============================================================

# 1-33 范围内的质数
PRIMES = frozenset({2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31})


def compute_ac_value(reds: list[int]) -> int:
    """AC值 = 红球两两差值去重数 - (pick-1)。

    反映号码离散程度，值越大越分散。
    """
    diffs: set[int] = set()
    for i in range(len(reds)):
        for j in range(i + 1, len(reds)):
            diffs.add(abs(reds[j] - reds[i]))
    return len(diffs) - (len(reds) - 1)


def _consecutive_groups(reds_sorted: list[int]) -> int:
    """连号组数：相邻差1的号码构成一组连号。"""
    if len(reds_sorted) < 2:
        return 0
    groups = 0
    in_group = False
    for i in range(1, len(reds_sorted)):
        if reds_sorted[i] - reds_sorted[i - 1] == 1:
            if not in_group:
                groups += 1
                in_group = True
        else:
            in_group = False
    return groups


def compute_red_indicators(reds: list[int], red_pool: int) -> dict:
    """计算单组红球的新浪走势指标。

    包含：AC值、和值、跨度、区间比、奇偶比、大小比、质合比、012路、连号。
    """
    s = sorted(reds)
    zone1_end = (red_pool + 2) // 3
    zone2_end = 2 * (red_pool + 2) // 3
    big_threshold = red_pool // 2
    return {
        "ac": compute_ac_value(s),
        "sum": sum(s),
        "span": s[-1] - s[0],
        "zone": (
            sum(1 for r in s if r <= zone1_end),
            sum(1 for r in s if zone1_end < r <= zone2_end),
            sum(1 for r in s if r > zone2_end),
        ),
        "odd_even": (
            sum(1 for r in s if r % 2 == 1),
            sum(1 for r in s if r % 2 == 0),
        ),
        "big_small": (
            sum(1 for r in s if r <= big_threshold),
            sum(1 for r in s if r > big_threshold),
        ),
        "prime_composite": (
            sum(1 for r in s if r in PRIMES),
            sum(1 for r in s if r not in PRIMES),
        ),
        "mod3": (
            sum(1 for r in s if r % 3 == 0),
            sum(1 for r in s if r % 3 == 1),
            sum(1 for r in s if r % 3 == 2),
        ),
        "consecutive": _consecutive_groups(s),
    }


def compute_blue_indicators(
    blue: int, blue_pool: int, prev_blue: int | None = None
) -> dict:
    """计算蓝球走势指标：大小、奇偶、012路、四区、尾数、振幅。"""
    big_threshold = blue_pool // 2
    result = {
        "big_small": 1 if blue > big_threshold else 0,
        "odd_even": blue % 2,
        "mod3": blue % 3,
        "zone": (blue - 1) // 4,
        "tail": blue % 10,
    }
    if prev_blue is not None:
        result["amplitude"] = abs(blue - prev_blue)
    return result


def compute_indicator_distributions(
    draws: list[dict], red_pick: int, blue_pick: int,
    red_pool: int, blue_pool: int,
) -> dict:
    """从历史开奖计算所有走势指标的频率分布。"""
    red_keys = [
        "ac", "sum", "span", "zone", "odd_even", "big_small",
        "prime_composite", "mod3", "consecutive",
    ]
    blue_keys = ["big_small", "odd_even", "mod3", "zone", "tail"]

    red_dist = {k: Counter() for k in red_keys}
    blue_dist = {k: Counter() for k in blue_keys + ["amplitude"]}
    repeat_dist: Counter = Counter()

    prev_reds: set[int] | None = None
    prev_blue: int | None = None

    for draw in draws:
        reds = [draw[f"r{i}"] for i in range(1, red_pick + 1)]
        ri = compute_red_indicators(reds, red_pool)
        for k in red_keys:
            red_dist[k][ri[k]] += 1

        if prev_reds is not None:
            repeat = len(set(reds) & prev_reds)
            repeat_dist[repeat] += 1
        prev_reds = set(reds)

        blue = draw["b1"]
        bi = compute_blue_indicators(blue, blue_pool, prev_blue)
        for k in bi:
            blue_dist[k][bi[k]] += 1
        prev_blue = blue

    return {"red": red_dist, "blue": blue_dist, "repeat": repeat_dist}


def _smoothed_log_prob(counter: Counter, value, alpha: float = 1.0) -> float:
    """拉普拉斯平滑后的对数概率。"""
    total = sum(counter.values())
    n_unique = len(counter)
    count = counter.get(value, 0)
    prob = (count + alpha) / (total + alpha * (n_unique + 1))
    return math.log(prob)


def score_ticket_by_indicators(
    reds: list[int],
    blue: int,
    prev_reds: set[int] | None,
    prev_blue: int | None,
    dist: dict,
    red_pool: int,
    blue_pool: int,
) -> float:
    """对候选票按走势指标匹配度打分。分数越高越符合历史模式。"""
    score = 0.0
    ri = compute_red_indicators(reds, red_pool)
    for k, v in ri.items():
        score += _smoothed_log_prob(dist["red"][k], v)

    if prev_reds is not None:
        repeat = len(set(reds) & prev_reds)
        score += _smoothed_log_prob(dist["repeat"], repeat)

    bi = compute_blue_indicators(blue, blue_pool, prev_blue)
    for k, v in bi.items():
        if k in dist["blue"]:
            score += _smoothed_log_prob(dist["blue"][k], v)

    return score


def build_enhanced_portfolio(
    rng: random.Random,
    draws: list[dict],
    red_pool: int,
    red_pick: int,
    blue_pool: int,
    blue_pick: int,
    ticket_count: int,
    red_scores: dict[int, float] | None = None,
    blue_scores: dict[int, float] | None = None,
    alpha: float = 0.1,
    candidate_count: int = 500,
    max_overlap: int | None = None,
    candidate_adjuster: Callable[[list[int], list[int]], float | None] | None = None,
) -> list[tuple[list[int], list[int]]]:
    """新浪走势指标增强版组合生成。

    流程：
    1. 软信号混合生成红蓝概率
    2. 计算历史走势指标分布（AC值/和值/跨度/区间比/奇偶比/大小比/质合比/012路/连号/重号/蓝球指标）
    3. 生成 candidate_count 个候选票（加权采样）
    4. 对每个候选按指标匹配度打分（对数概率求和）
    5. 贪心选择 Top-N（低重叠约束，红球重叠 <= max_overlap）
    6. 红蓝联合优化
    """
    # 1. 软混合概率
    red_hist = historical_frequency(draws, "r", red_pick, red_pool)
    blue_hist = historical_frequency(draws, "b", blue_pick, blue_pool)
    red_probs = soft_blend(red_scores, red_hist, red_pool, alpha)
    blue_probs = soft_blend(blue_scores, blue_hist, blue_pool, alpha)

    # 2. 历史指标分布
    dist = compute_indicator_distributions(
        draws, red_pick, blue_pick, red_pool, blue_pool)

    # 3. 上一期开奖（用于重号、振幅）
    prev_reds = set(draws[-1][f"r{i}"] for i in range(1, red_pick + 1))
    prev_blue = draws[-1]["b1"]

    # 4. 蓝球配对权重（blue_pick>=2 时）
    pair_w = None
    if blue_pick >= 2:
        pair_w = blue_pair_weights(draws, blue_probs, blue_pool, alpha)

    # 5. 生成候选并打分
    candidates: list[tuple[float, list[int], list[int]]] = []
    for _ in range(candidate_count):
        red_perm = _weighted_permutation(rng, red_pool, red_probs)
        reds = sorted(red_perm[:red_pick])

        if blue_pick >= 2 and pair_w is not None:
            pairs = list(pair_w.keys())
            weights = [pair_w[p] for p in pairs]
            total = sum(weights)
            r = rng.random() * total
            cumsum = 0.0
            chosen_pair = pairs[-1]
            for p, w in zip(pairs, weights):
                cumsum += w
                if r <= cumsum:
                    chosen_pair = p
                    break
            blues = list(chosen_pair)
        else:
            blue_perm = _weighted_permutation(rng, blue_pool, blue_probs)
            blues = [blue_perm[0]]

        score = score_ticket_by_indicators(
            reds, blues[0], prev_reds, prev_blue, dist, red_pool, blue_pool)
        if candidate_adjuster is not None:
            adjustment = candidate_adjuster(reds, blues)
            if adjustment is None:
                continue
            score += float(adjustment)
        candidates.append((score, reds, blues))

    if not candidates:
        raise RuntimeError("候选过滤后没有可用组合")

    # 6. 按分数降序排列
    candidates.sort(key=lambda x: -x[0])

    # 7. 贪心选择低重叠 Top-N
    if max_overlap is None:
        max_overlap = max(1, red_pick - 3)

    selected: list[tuple[float, list[int], list[int]]] = []
    for score, reds, blues in candidates:
        if len(selected) >= ticket_count:
            break
        ok = True
        for _, sel_reds, _ in selected:
            if len(set(reds) & set(sel_reds)) > max_overlap:
                ok = False
                break
        if ok:
            selected.append((score, reds, blues))

    # 放宽限制补充
    if len(selected) < ticket_count:
        for score, reds, blues in candidates:
            if len(selected) >= ticket_count:
                break
            already = any(
                reds == sr and blues == sb
                for _, sr, sb in selected
            )
            if already:
                continue
            selected.append((score, reds, blues))

    red_tickets = [r for _, r, _ in selected[:ticket_count]]
    blue_tickets = [b for _, _, b in selected[:ticket_count]]

    # 8. 红蓝联合优化
    coocc = red_blue_cooccurrence(draws, red_pick, blue_pick)
    optimized = joint_optimize(red_tickets, blue_tickets, coocc)

    return optimized


# ============================================================
# 红蓝分别优化策略：分别生成红球/蓝球候选池，按各自置信度排序
# ============================================================

def compute_red_confidence(
    reds: list[int],
    red_probs: dict[int, float],
    dist: dict,
    prev_reds: set[int] | None,
    red_pool: int,
    prob_weight: float = 0.3,
) -> float:
    """红球组合置信度 = 走势指标匹配度（对数概率） + 号码概率加权。"""
    ri = compute_red_indicators(reds, red_pool)
    indicator_score = 0.0
    for k, v in ri.items():
        indicator_score += _smoothed_log_prob(dist["red"][k], v)
    if prev_reds is not None:
        repeat = len(set(reds) & prev_reds)
        indicator_score += _smoothed_log_prob(dist["repeat"], repeat)
    prob_score = sum(math.log(max(red_probs.get(n, 1e-10), 1e-10)) for n in reds)
    return indicator_score + prob_score * prob_weight


def compute_blue_confidence(
    blues: list[int],
    blue_probs: dict[int, float],
    dist: dict,
    prev_blue: int | None,
    blue_pool: int,
    prob_weight: float = 0.3,
) -> float:
    """蓝球组合置信度 = 蓝球指标匹配度 + 蓝球概率加权。"""
    indicator_score = 0.0
    for b in blues:
        bi = compute_blue_indicators(b, blue_pool, prev_blue)
        for k, v in bi.items():
            if k in dist["blue"]:
                indicator_score += _smoothed_log_prob(dist["blue"][k], v)
    prob_score = sum(math.log(max(blue_probs.get(n, 1e-10), 1e-10)) for n in blues)
    return indicator_score + prob_score * prob_weight


def build_portfolio_separate(
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
    red_candidate_count: int = 1000,
    blue_candidate_count: int = 500,
    max_overlap: int | None = None,
) -> list[tuple[list[int], list[int]]]:
    """红蓝分别优化策略：分别生成候选池，按各自置信度排序，组合输出。

    策略：
    1. 分别生成红球候选池和蓝球候选池（加权采样）
    2. 红球按红球置信度排序（走势指标匹配度 + 号码概率）
    3. 蓝球按蓝球置信度排序（走势指标匹配度 + 号码概率）
    4. 红球贪心选择Top N（低重叠约束，确保覆盖不同红球）
    5. 蓝球选择Top N（去重，确保覆盖不同蓝球）
    6. 组合输出：红球Top1配蓝球Top1 = 最优组合
    """
    # 1. 软混合概率
    red_hist = historical_frequency(draws, "r", red_pick, red_pool)
    blue_hist = historical_frequency(draws, "b", blue_pick, blue_pool)
    red_probs = soft_blend(red_scores, red_hist, red_pool, alpha)
    blue_probs = soft_blend(blue_scores, blue_hist, blue_pool, alpha)

    # 2. 历史指标分布
    dist = compute_indicator_distributions(
        draws, red_pick, blue_pick, red_pool, blue_pool)
    prev_reds = set(draws[-1][f"r{i}"] for i in range(1, red_pick + 1))
    prev_blue = draws[-1]["b1"]

    # 3. 蓝球配对权重（blue_pick>=2 时）
    pair_w = None
    if blue_pick >= 2:
        pair_w = blue_pair_weights(draws, blue_probs, blue_pool, alpha)

    # 4. 生成红球候选池并按置信度排序
    red_candidates: list[tuple[float, list[int]]] = []
    for _ in range(red_candidate_count):
        red_perm = _weighted_permutation(rng, red_pool, red_probs)
        reds = sorted(red_perm[:red_pick])
        confidence = compute_red_confidence(
            reds, red_probs, dist, prev_reds, red_pool)
        red_candidates.append((confidence, reds))
    red_candidates.sort(key=lambda x: -x[0])

    # 5. 生成蓝球候选池并按置信度排序
    blue_candidates: list[tuple[float, list[int]]] = []
    for _ in range(blue_candidate_count):
        if blue_pick >= 2 and pair_w is not None:
            pairs = list(pair_w.keys())
            weights = [pair_w[p] for p in pairs]
            total = sum(weights)
            r = rng.random() * total
            cumsum = 0.0
            chosen_pair = pairs[-1]
            for p, w in zip(pairs, weights):
                cumsum += w
                if r <= cumsum:
                    chosen_pair = p
                    break
            blues = list(chosen_pair)
        else:
            blue_perm = _weighted_permutation(rng, blue_pool, blue_probs)
            blues = [blue_perm[0]]
        confidence = compute_blue_confidence(
            blues, blue_probs, dist, prev_blue, blue_pool)
        blue_candidates.append((confidence, blues))
    blue_candidates.sort(key=lambda x: -x[0])

    # 6. 红球贪心选择Top N（低重叠约束，确保覆盖）
    if max_overlap is None:
        max_overlap = max(1, red_pick - 2)

    selected_reds: list[list[int]] = []
    for _, reds in red_candidates:
        if len(selected_reds) >= ticket_count:
            break
        ok = True
        for sel_reds in selected_reds:
            if len(set(reds) & set(sel_reds)) > max_overlap:
                ok = False
                break
        if ok:
            selected_reds.append(reds)
    # 放宽限制补充
    if len(selected_reds) < ticket_count:
        for _, reds in red_candidates:
            if len(selected_reds) >= ticket_count:
                break
            if reds not in selected_reds:
                selected_reds.append(reds)

    # 7. 蓝球选择Top N（去重，确保覆盖不同蓝球）
    selected_blues: list[list[int]] = []
    seen_blue_keys: set = set()
    for _, blues in blue_candidates:
        if len(selected_blues) >= ticket_count:
            break
        blue_key = tuple(sorted(blues))
        if blue_key in seen_blue_keys:
            continue
        selected_blues.append(blues)
        seen_blue_keys.add(blue_key)
    # 补充
    if len(selected_blues) < ticket_count:
        for _, blues in blue_candidates:
            if len(selected_blues) >= ticket_count:
                break
            selected_blues.append(blues)

    # 8. 组合输出
    while len(selected_reds) < ticket_count:
        selected_reds.append(selected_reds[-1] if selected_reds else list(range(1, red_pick + 1)))
    while len(selected_blues) < ticket_count:
        selected_blues.append(selected_blues[-1] if selected_blues else list(range(1, blue_pick + 1)))

    return list(zip(selected_reds[:ticket_count], selected_blues[:ticket_count]))


# ============================================================
# v6 集成策略：v4联合评分 + v5独立置信度 + 马尔可夫转移 + 多种子共识
# ============================================================

def _smoothed_log_prob(counter: Counter, value) -> float:
    """拉普拉斯平滑对数概率：log((count+1)/(total+unique))"""
    total = sum(counter.values())
    unique = len(counter)
    return math.log((counter.get(value, 0) + 1) / (total + unique))


def build_red_transition_matrix(
    draws: list[dict],
    red_pick: int,
    red_pool: int,
    window: int = 50,
) -> dict[tuple[int, int], float]:
    """构建红球马尔可夫转移矩阵：P(r_i | r_j) = 上期出现r_j时本期出现r_i的概率。"""
    recent = draws[-window:] if len(draws) > window else draws
    transitions: Counter = Counter()
    prev_reds: set[int] = set()
    
    for draw in recent:
        curr_reds = set(draw[f"r{i}"] for i in range(1, red_pick + 1))
        for prev_r in prev_reds:
            for curr_r in curr_reds:
                transitions[(prev_r, curr_r)] += 1
        prev_reds = curr_reds
    
    # 归一化为概率
    prob_matrix: dict[tuple[int, int], float] = {}
    for prev_r in range(1, red_pool + 1):
        total = sum(transitions.get((prev_r, r), 0) for r in range(1, red_pool + 1))
        if total > 0:
            for curr_r in range(1, red_pool + 1):
                prob_matrix[(prev_r, curr_r)] = transitions.get((prev_r, curr_r), 0) / total
        else:
            for curr_r in range(1, red_pool + 1):
                prob_matrix[(prev_r, curr_r)] = 1.0 / red_pool
    
    return prob_matrix


def compute_red_markov_score(
    reds: list[int],
    prev_reds: set[int],
    transition_matrix: dict[tuple[int, int], float],
) -> float:
    """马尔可夫转移评分：基于上期号码的条件概率。"""
    score = 0.0
    for r in reds:
        if prev_reds:
            # 取最大转移概率
            max_trans = max(transition_matrix.get((pr, r), 0) for pr in prev_reds)
            # 同时考虑"上期号码附近"的号码
            near_trans = []
            for pr in prev_reds:
                for offset in [-2, -1, 1, 2]:
                    nr = pr + offset
                    if 1 <= nr <= len(transition_matrix) // (len(transition_matrix) // 35):
                        near_trans.append(transition_matrix.get((pr, nr), 0))
            if near_trans:
                score += math.log(max(max_trans, max(near_trans) * 0.8, 0.01))
            else:
                score += math.log(max(max_trans, 0.01))
        else:
            score += math.log(0.01)
    return score


def build_portfolio_ensemble(
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
    red_candidate_count: int = 1000,
    blue_candidate_count: int = 500,
    num_seeds: int = 3,
    v4_weight: float = 0.4,
    v5_weight: float = 0.4,
    markov_weight: float = 0.2,
) -> list[tuple[list[int], list[int]]]:
    """v6集成策略：v4联合指标评分 + v5独立置信度 + 马尔可夫转移 + 多种子共识。

    策略：
    1. 分别生成红球候选池和蓝球候选池（多种子）
    2. 红球评分 = v4联合指标评分 * v4_weight
                + v5独立置信度 * v5_weight
                + 马尔可夫转移评分 * markov_weight
    3. 蓝球采用v5独立置信度评分（已证明有效）
    4. 多种子共识：每个种子生成候选，取跨种子频率最高的号码
    5. 贪心选择Top N（低重叠约束）
    6. 组合输出：红球Top1配蓝球Top1 = 最优组合
    """
    # 1. 软混合概率
    red_hist = historical_frequency(draws, "r", red_pick, red_pool)
    blue_hist = historical_frequency(draws, "b", blue_pick, blue_pool)
    red_probs = soft_blend(red_scores, red_hist, red_pool, alpha)
    blue_probs = soft_blend(blue_scores, blue_hist, blue_pool, alpha)

    # 2. 历史指标分布
    dist = compute_indicator_distributions(
        draws, red_pick, blue_pick, red_pool, blue_pool)
    prev_reds = set(draws[-1][f"r{i}"] for i in range(1, red_pick + 1))
    prev_blue = draws[-1]["b1"]

    # 3. 马尔可夫转移矩阵
    transition_matrix = build_red_transition_matrix(draws, red_pick, red_pool)

    # 4. 蓝球配对权重（blue_pick>=2 时）
    pair_w = None
    if blue_pick >= 2:
        pair_w = blue_pair_weights(draws, blue_probs, blue_pool, alpha)

    # 5. 多种子生成红球候选
    all_red_candidates: dict[tuple[int, ...], tuple[float, int]] = {}
    for seed_idx in range(num_seeds):
        seed_rng = random.Random()
        seed_rng.setstate(rng.getstate())
        seed_rng.seed(seed_idx)
        
        for _ in range(red_candidate_count // num_seeds):
            red_perm = _weighted_permutation(seed_rng, red_pool, red_probs)
            reds = tuple(sorted(red_perm[:red_pick]))
            
            if reds in all_red_candidates:
                all_red_candidates[reds] = (all_red_candidates[reds][0], all_red_candidates[reds][1] + 1)
                continue
            
            # v4联合指标评分（完整指标匹配度）
            ri = compute_red_indicators(list(reds), red_pool)
            v4_score = 0.0
            for k, v in ri.items():
                v4_score += _smoothed_log_prob(dist["red"][k], v)
            if prev_reds:
                repeat = len(set(reds) & prev_reds)
                v4_score += _smoothed_log_prob(dist["repeat"], repeat)
            
            # v5独立置信度（含号码概率）
            prob_score = sum(math.log(max(red_probs.get(n, 1e-10), 1e-10)) for n in reds)
            v5_score = v4_score + prob_score * 0.3
            
            # 马尔可夫转移评分
            markov_score = compute_red_markov_score(list(reds), prev_reds, transition_matrix)
            
            # 综合评分
            total_score = v4_score * v4_weight + v5_score * v5_weight + markov_score * markov_weight
            
            all_red_candidates[reds] = (total_score, 1)

    # 6. 综合排序：评分 + 种子共识频率
    red_candidates = []
    for reds, (score, freq) in all_red_candidates.items():
        # 种子共识加成：多个种子都生成了同一组号码
        consensus_bonus = math.log(freq + 1) * 0.5
        red_candidates.append((score + consensus_bonus, list(reds)))
    red_candidates.sort(key=lambda x: -x[0])

    # 7. 多种子生成蓝球候选
    all_blue_candidates: dict[tuple[int, ...], tuple[float, int]] = {}
    for seed_idx in range(num_seeds):
        seed_rng = random.Random()
        seed_rng.setstate(rng.getstate())
        seed_rng.seed(seed_idx + 100)
        
        for _ in range(blue_candidate_count // num_seeds):
            if blue_pick >= 2 and pair_w is not None:
                pairs = list(pair_w.keys())
                weights = [pair_w[p] for p in pairs]
                total_w = sum(weights)
                r = seed_rng.random() * total_w
                cumsum = 0.0
                chosen_pair = pairs[-1]
                for p, w in zip(pairs, weights):
                    cumsum += w
                    if r <= cumsum:
                        chosen_pair = p
                        break
                blues = list(chosen_pair)
            else:
                blue_perm = _weighted_permutation(seed_rng, blue_pool, blue_probs)
                blues = [blue_perm[0]]
            
            blues_key = tuple(sorted(blues))
            if blues_key in all_blue_candidates:
                all_blue_candidates[blues_key] = (all_blue_candidates[blues_key][0], all_blue_candidates[blues_key][1] + 1)
                continue
            
            # v5独立置信度评分
            indicator_score = 0.0
            for b in blues:
                bi = compute_blue_indicators(b, blue_pool, prev_blue)
                for k, v in bi.items():
                    if k in dist["blue"]:
                        indicator_score += _smoothed_log_prob(dist["blue"][k], v)
            prob_score = sum(math.log(max(blue_probs.get(n, 1e-10), 1e-10)) for n in blues)
            total_score = indicator_score + prob_score * 0.3
            
            all_blue_candidates[blues_key] = (total_score, 1)

    # 8. 蓝球排序：评分 + 种子共识频率
    blue_candidates = []
    for blues_key, (score, freq) in all_blue_candidates.items():
        consensus_bonus = math.log(freq + 1) * 0.5
        blue_candidates.append((score + consensus_bonus, list(blues_key)))
    blue_candidates.sort(key=lambda x: -x[0])

    # 9. 红球贪心选择Top N（低重叠约束，确保覆盖）
    max_overlap = max(1, red_pick - 2)
    selected_reds: list[list[int]] = []
    for _, reds in red_candidates:
        if len(selected_reds) >= ticket_count:
            break
        ok = True
        for sel_reds in selected_reds:
            if len(set(reds) & set(sel_reds)) > max_overlap:
                ok = False
                break
        if ok:
            selected_reds.append(reds)
    # 放宽限制补充
    if len(selected_reds) < ticket_count:
        for _, reds in red_candidates:
            if len(selected_reds) >= ticket_count:
                break
            if reds not in selected_reds:
                selected_reds.append(reds)

    # 10. 蓝球选择Top N（去重，确保覆盖不同蓝球）
    selected_blues: list[list[int]] = []
    seen_blue_keys: set = set()
    for _, blues in blue_candidates:
        if len(selected_blues) >= ticket_count:
            break
        blue_key = tuple(sorted(blues))
        if blue_key in seen_blue_keys:
            continue
        selected_blues.append(blues)
        seen_blue_keys.add(blue_key)
    # 补充
    if len(selected_blues) < ticket_count:
        for _, blues in blue_candidates:
            if len(selected_blues) >= ticket_count:
                break
            selected_blues.append(blues)

    # 11. 组合输出
    while len(selected_reds) < ticket_count:
        selected_reds.append(selected_reds[-1] if selected_reds else list(range(1, red_pick + 1)))
    while len(selected_blues) < ticket_count:
        selected_blues.append(selected_blues[-1] if selected_blues else list(range(1, blue_pick + 1)))

    return list(zip(selected_reds[:ticket_count], selected_blues[:ticket_count]))


def format_indicator_summary(
    dist: dict, red_pool: int, blue_pool: int, top_k: int = 3
) -> str:
    """格式化历史走势指标分布摘要（Top-K 高频值）。"""
    lines: list[str] = []

    lines.append("=== 红球走势指标历史分布 ===")
    red_labels = {
        "ac": "AC值", "sum": "和值", "span": "跨度",
        "zone": "区间比", "odd_even": "奇偶比",
        "big_small": "大小比", "prime_composite": "质合比",
        "mod3": "012路", "consecutive": "连号组数",
    }
    for key, label in red_labels.items():
        counter = dist["red"][key]
        total = sum(counter.values())
        top = counter.most_common(top_k)
        parts = []
        for val, cnt in top:
            pct = cnt / total * 100
            parts.append(f"{val}({pct:.1f}%)")
        lines.append(f"  {label}：{', '.join(parts)}")

    repeat = dist["repeat"]
    total_r = sum(repeat.values())
    if total_r > 0:
        parts = []
        for val, cnt in repeat.most_common(top_k):
            pct = cnt / total_r * 100
            parts.append(f"{val}个({pct:.1f}%)")
        lines.append(f"  重号数：{', '.join(parts)}")

    lines.append("\n=== 蓝球走势指标历史分布 ===")
    blue_labels = {
        "big_small": "大小", "odd_even": "奇偶",
        "mod3": "012路", "zone": "四区", "tail": "尾数",
        "amplitude": "振幅",
    }
    for key, label in blue_labels.items():
        counter = dist["blue"].get(key, Counter())
        if not counter:
            continue
        total = sum(counter.values())
        top = counter.most_common(top_k)
        parts = []
        for val, cnt in top:
            pct = cnt / total * 100
            if key == "big_small":
                val_str = "大" if val == 1 else "小"
            elif key == "odd_even":
                val_str = "奇" if val == 1 else "偶"
            else:
                val_str = str(val)
            parts.append(f"{val_str}({pct:.1f}%)")
        lines.append(f"  {label}：{', '.join(parts)}")

    return "\n".join(lines)


def format_ticket_indicators(
    reds: list[int], blue: int, red_pool: int, blue_pool: int,
) -> str:
    """格式化单注号码的走势指标。"""
    ri = compute_red_indicators(reds, red_pool)
    bi = compute_blue_indicators(blue, blue_pool)
    big_small_str = f"{ri['big_small'][0]}小{ri['big_small'][1]}大"
    odd_even_str = f"{ri['odd_even'][0]}奇{ri['odd_even'][1]}偶"
    pc_str = f"{ri['prime_composite'][0]}质{ri['prime_composite'][1]}合"
    mod3_str = f"{ri['mod3'][0]}/{ri['mod3'][1]}/{ri['mod3'][2]}"
    zone_str = f"{ri['zone'][0]}/{ri['zone'][1]}/{ri['zone'][2]}"
    blue_big_small = "大" if bi["big_small"] == 1 else "小"
    blue_odd_even = "奇" if bi["odd_even"] == 1 else "偶"
    return (
        f"和{ri['sum']} 跨{ri['span']} AC{ri['ac']} "
        f"区{zone_str} {big_small_str} {odd_even_str} {pc_str} "
        f"012路{mod3_str} 连{ri['consecutive']} | "
        f"蓝{blue_big_small}{blue_odd_even} 012路{bi['mod3']} "
        f"区{bi['zone'] + 1} 尾{bi['tail']}"
    )
