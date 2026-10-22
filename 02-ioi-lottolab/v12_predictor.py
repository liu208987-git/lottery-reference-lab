"""双色球 V12：有限样本、低维、在线收缩预测器。

V12只估计33个红球的边际入选概率和16个蓝球的分类概率，不拟合
高维完整号码组合。多个固定时间窗口通过在线Hedge权重组合；每期开奖
后才更新专家损失和计数，因此可以从第一期开始做严格走期验证。

组合层在模型评分与分散覆盖之间折中，并强制任意两注红球交集不超过3，
从而保留5注在“三等奖及以上”事件上的最大无重叠覆盖。
"""

from __future__ import annotations

import math
import random
from hashlib import sha256


ALGORITHM_NAME = "ssq-v12-finite-online"
SEED_NAMESPACE = "v12-finite-online-v1"
RED_POOL = 33
RED_PICK = 6
BLUE_POOL = 16
WINDOWS: tuple[int | None, ...] = (16, 32, 64, 128, 256, None)
RED_PRIOR_STRENGTH = 24.0
BLUE_PRIOR_STRENGTH = 16.0


def v12_rng(issue: str, replicate: int = 0) -> random.Random:
    payload = f"{SEED_NAMESPACE}|{issue}|{replicate}".encode("utf-8")
    seed = int.from_bytes(sha256(payload).digest()[:8], "big")
    return random.Random(seed)


def _window_name(window: int | None) -> str:
    return "all" if window is None else str(window)


class V12OnlineForecaster:
    """只用已观察开奖、按正确时间顺序更新的低维在线模型。"""

    def __init__(self) -> None:
        self.issues: list[str] = []
        self.red_prefix: list[list[int]] = [[0] * RED_POOL]
        self.blue_prefix: list[list[int]] = [[0] * BLUE_POOL]
        self.red_loss = {window: 0.0 for window in WINDOWS}
        self.blue_loss = {window: 0.0 for window in WINDOWS}
        self.scored_draws = 0

    @property
    def history_size(self) -> int:
        return len(self.issues)

    def _expert_probabilities(
        self, window: int | None
    ) -> tuple[list[float], list[float]]:
        target = self.history_size
        lower = 0 if window is None else max(0, target - window)
        size = target - lower
        red_counts = [
            self.red_prefix[target][index] - self.red_prefix[lower][index]
            for index in range(RED_POOL)
        ]
        blue_counts = [
            self.blue_prefix[target][index] - self.blue_prefix[lower][index]
            for index in range(BLUE_POOL)
        ]
        red_prior_mean = RED_PICK / RED_POOL
        blue_prior_mean = 1.0 / BLUE_POOL
        red_denominator = size + RED_PRIOR_STRENGTH
        blue_denominator = size + BLUE_PRIOR_STRENGTH
        red = [
            (count + RED_PRIOR_STRENGTH * red_prior_mean) / red_denominator
            for count in red_counts
        ]
        blue = [
            (count + BLUE_PRIOR_STRENGTH * blue_prior_mean) / blue_denominator
            for count in blue_counts
        ]
        return red, blue

    def _hedge_weights(self, losses: dict[int | None, float]) -> dict[int | None, float]:
        if self.scored_draws == 0:
            return {window: 1.0 / len(WINDOWS) for window in WINDOWS}
        # 随样本量缩小学习率，避免短期噪声把权重推到单一窗口。
        eta = math.sqrt(2.0 * math.log(len(WINDOWS)) / self.scored_draws)
        minimum = min(losses.values())
        raw = {
            window: math.exp(-eta * (losses[window] - minimum))
            for window in WINDOWS
        }
        total = sum(raw.values())
        return {window: value / total for window, value in raw.items()}

    def probabilities(self) -> tuple[list[float], list[float], dict]:
        experts = {
            window: self._expert_probabilities(window) for window in WINDOWS
        }
        red_weights = self._hedge_weights(self.red_loss)
        blue_weights = self._hedge_weights(self.blue_loss)
        red = [
            sum(red_weights[window] * experts[window][0][index]
                for window in WINDOWS)
            for index in range(RED_POOL)
        ]
        blue = [
            sum(blue_weights[window] * experts[window][1][index]
                for window in WINDOWS)
            for index in range(BLUE_POOL)
        ]
        metadata = {
            "history_size": self.history_size,
            "scored_draws": self.scored_draws,
            "windows": [_window_name(window) for window in WINDOWS],
            "red_expert_weights": {
                _window_name(window): red_weights[window] for window in WINDOWS
            },
            "blue_expert_weights": {
                _window_name(window): blue_weights[window] for window in WINDOWS
            },
            "red_probability_sum": sum(red),
            "blue_probability_sum": sum(blue),
        }
        return red, blue, metadata

    def observe(self, draw: dict) -> None:
        """先按旧状态结算专家，再加入新开奖；禁止倒序或重复观察。"""
        issue = str(draw["issue"])
        if self.issues and issue <= self.issues[-1]:
            raise ValueError("V12历史必须按期号严格递增输入")
        actual_reds = {
            int(draw[f"r{index}"]) for index in range(1, RED_PICK + 1)
        }
        actual_blue = int(draw["b1"])
        if len(actual_reds) != RED_PICK:
            raise ValueError("红球历史数据非法")

        if self.history_size:
            for window in WINDOWS:
                red, blue = self._expert_probabilities(window)
                red_bce = 0.0
                for index, probability in enumerate(red, 1):
                    probability = min(1 - 1e-12, max(1e-12, probability))
                    observed = 1.0 if index in actual_reds else 0.0
                    red_bce -= (
                        observed * math.log(probability)
                        + (1.0 - observed) * math.log1p(-probability)
                    ) / RED_POOL
                blue_probability = min(
                    1 - 1e-12, max(1e-12, blue[actual_blue - 1]))
                # 用各自无信息基准归一化，使红蓝Hedge学习率可比较。
                self.red_loss[window] += red_bce / 0.5
                self.blue_loss[window] += -math.log(blue_probability) / math.log(BLUE_POOL)
            self.scored_draws += 1

        next_red = self.red_prefix[-1].copy()
        for number in actual_reds:
            next_red[number - 1] += 1
        next_blue = self.blue_prefix[-1].copy()
        next_blue[actual_blue - 1] += 1
        self.red_prefix.append(next_red)
        self.blue_prefix.append(next_blue)
        self.issues.append(issue)


def _gumbel(rng: random.Random) -> float:
    value = min(1 - 1e-15, max(1e-15, rng.random()))
    return -math.log(-math.log(value))


def _red_score(reds: tuple[int, ...], red_probabilities: list[float]) -> float:
    score = 0.0
    for number in reds:
        probability = min(1 - 1e-9, max(1e-9, red_probabilities[number - 1]))
        score += math.log(probability / (1.0 - probability))
    return score


def build_v12_portfolio(
    rng: random.Random,
    red_probabilities: list[float],
    blue_probabilities: list[float],
    ticket_count: int = 5,
    *,
    candidate_count: int = 400,
    coverage_bonus: float = 0.12,
    return_metadata: bool = False,
):
    """从低维概率生成5注；模型评分优先，同时保持高奖事件不重叠。"""
    if ticket_count != 5:
        raise ValueError("V12当前仅锁定每期5注的评估口径")
    if len(red_probabilities) != RED_POOL or len(blue_probabilities) != BLUE_POOL:
        raise ValueError("V12概率向量长度错误")

    odds_logs = []
    for probability in red_probabilities:
        probability = min(1 - 1e-9, max(1e-9, float(probability)))
        odds_logs.append(math.log(probability / (1.0 - probability)))

    candidate_sets: set[tuple[int, ...]] = set()
    deterministic = tuple(sorted(
        sorted(range(1, RED_POOL + 1), key=lambda n: -odds_logs[n - 1])[:RED_PICK]
    ))
    candidate_sets.add(deterministic)
    for _ in range(candidate_count):
        ranked = sorted(
            range(1, RED_POOL + 1),
            key=lambda number: -(odds_logs[number - 1] + _gumbel(rng)),
        )
        candidate_sets.add(tuple(sorted(ranked[:RED_PICK])))

    candidates = sorted(
        ((_red_score(reds, red_probabilities), reds) for reds in candidate_sets),
        key=lambda item: (-item[0], item[1]),
    )
    score_values = [score for score, _ in candidates]
    mean = sum(score_values) / len(score_values)
    variance = sum((score - mean) ** 2 for score in score_values) / len(score_values)
    scale = max(math.sqrt(variance), 1e-9)

    selected: list[tuple[float, tuple[int, ...]]] = []
    covered: set[int] = set()
    while len(selected) < ticket_count:
        eligible = []
        for score, reds in candidates:
            if any(reds == chosen for _, chosen in selected):
                continue
            red_set = set(reds)
            if any(len(red_set & set(chosen)) > 3 for _, chosen in selected):
                continue
            objective = (score - mean) / scale + coverage_bonus * len(red_set - covered)
            eligible.append((objective, score, reds))
        if not eligible:
            # 理论上400个候选足够；极端概率向量下用均匀候选安全补足。
            for _ in range(20000):
                reds = tuple(sorted(rng.sample(range(1, RED_POOL + 1), RED_PICK)))
                red_set = set(reds)
                if all(len(red_set & set(chosen)) <= 3 for _, chosen in selected):
                    candidates.append((_red_score(reds, red_probabilities), reds))
                    break
            else:
                raise RuntimeError("V12无法构造低重叠5注")
            continue
        _, score, reds = max(eligible, key=lambda item: (item[0], item[1], item[2]))
        selected.append((score, reds))
        covered.update(reds)

    selected.sort(key=lambda item: (-item[0], item[1]))
    blue_order = sorted(
        range(1, BLUE_POOL + 1),
        key=lambda number: (-blue_probabilities[number - 1], number),
    )[:ticket_count]
    tickets = [
        (list(selected[index][1]), [blue_order[index]])
        for index in range(ticket_count)
    ]
    max_overlap = max(
        len(set(tickets[left][0]) & set(tickets[right][0]))
        for left in range(ticket_count) for right in range(left + 1, ticket_count)
    )
    metadata = {
        "algorithm": ALGORITHM_NAME,
        "candidate_count": len(candidate_sets),
        "coverage_bonus": coverage_bonus,
        "red_coverage": len(set().union(*(set(ticket[0]) for ticket in tickets))),
        "blue_coverage": len({ticket[1][0] for ticket in tickets}),
        "max_red_overlap": max_overlap,
        "third_plus_upper_bound_preserved": max_overlap <= 3,
        "ranking_is_probability": False,
    }
    return (tickets, metadata) if return_metadata else tickets


def build_v12_from_history(
    history: list[dict], issue: str, *, return_metadata: bool = False
):
    if not history:
        raise ValueError("V12至少需要1期已知历史")
    model = V12OnlineForecaster()
    for draw in history:
        model.observe(draw)
    red, blue, model_metadata = model.probabilities()
    tickets, portfolio_metadata = build_v12_portfolio(
        v12_rng(issue), red, blue, return_metadata=True)
    metadata = {**model_metadata, **portfolio_metadata}
    return (tickets, metadata) if return_metadata else tickets


__all__ = [
    "ALGORITHM_NAME",
    "V12OnlineForecaster",
    "build_v12_from_history",
    "build_v12_portfolio",
    "v12_rng",
]
