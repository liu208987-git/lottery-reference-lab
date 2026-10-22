from __future__ import annotations

import csv
import hashlib
import json
import math
import random
import shutil
import subprocess
from dataclasses import dataclass
from datetime import date, datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Callable, Iterable, Sequence

import numpy as np

from model_selection import (
    DEFAULT_MODEL_PARAMETERS,
    P1_PARAMETER_GRIDS,
    select_p1_hyperparameters,
)


EPS = 1e-9


@dataclass(frozen=True)
class GameSpec:
    code: str
    name: str
    front_pool: int
    front_pick: int
    back_pool: int
    back_pick: int
    front_columns: tuple[str, ...]
    back_columns: tuple[str, ...]


@dataclass(frozen=True)
class Draw:
    issue: str
    draw_date: date
    front: tuple[int, ...]
    back: tuple[int, ...]


@dataclass(frozen=True)
class LunarDate:
    cyclical_year: int
    month: int
    day: int
    is_leap_month: bool


GAME_SPECS = {
    "ssq": GameSpec(
        code="ssq",
        name="双色球",
        front_pool=33,
        front_pick=6,
        back_pool=16,
        back_pick=1,
        front_columns=("red_1", "red_2", "red_3", "red_4", "red_5", "red_6"),
        back_columns=("blue_1",),
    ),
    "dlt": GameSpec(
        code="dlt",
        name="大乐透",
        front_pool=35,
        front_pick=5,
        back_pool=12,
        back_pick=2,
        front_columns=("front_1", "front_2", "front_3", "front_4", "front_5"),
        back_columns=("back_1", "back_2"),
    ),
}


MODEL_GROUPS = {
    "uniform_random": "随机基线",
    "bayesian_all": "概率统计",
    "bayesian_recent_120": "概率统计",
    "exp_decay_60": "概率统计",
    "hot_cold": "启发式统计",
    "overdue_gap": "启发式统计",
    "markov_transition": "序列模型",
    "cooccurrence_network": "关系网络",
    "chaos_logistic": "现代混沌实验",
    "meihua_yishu": "传统术数实验",
    "xiaoliu_ren": "传统术数实验",
    "ga_ensemble": "进化集成",
}


MODEL_DESCRIPTIONS = {
    "uniform_random": "等概率基线；用稳定哈希打破并列，概率始终为 k/N。",
    "bayesian_all": "全历史 Beta-Bernoulli；先验强度只在历史形成区内滚动选择。",
    "bayesian_recent_120": "滚动窗口 Beta-Bernoulli；窗口与先验只在历史形成区内选择。",
    "exp_decay_60": "指数衰减 Beta-Bernoulli；半衰期与先验只在历史形成区内选择。",
    "hot_cold": "最近 30 期与最近 200 期频率差。",
    "overdue_gap": "按号码距上次出现的遗漏期数排序；用于检验常见遗漏值直觉。",
    "markov_transition": "以前一期号码为条件的一阶跨期转移频率。",
    "cooccurrence_network": "历史同期开奖共现网络，以前一期号码作为锚点评分。",
    "chaos_logistic": "由开奖前已知日期和期号初始化 Logistic 映射的确定性基线。",
    "meihua_yishu": "按常见年月日时起卦公式生成卦数，再映射为号码余数评分。",
    "xiaoliu_ren": "按常见月日起时六宫轮转公式生成三宫，再映射为号码余数评分。",
    "ga_ensemble": "只在验证集进化基础模型非负权重，冻结后用于最终留出集。",
}


DEFAULT_MODEL_START_DATES: dict[str, date | None] = {
    "ssq": None,
    "dlt": date(2014, 1, 1),
}


def filter_draws_for_model(
    draws: Sequence[Draw],
    start_date: date | None,
) -> list[Draw]:
    filtered = [
        draw for draw in draws if start_date is None or draw.draw_date >= start_date
    ]
    if len(filtered) < 100:
        raise ValueError("模型时间窗口至少需要 100 期数据")
    return filtered


def load_draws(path: Path, spec: GameSpec) -> list[Draw]:
    draws: list[Draw] = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            front = tuple(int(row[column]) for column in spec.front_columns)
            back = tuple(int(row[column]) for column in spec.back_columns)
            draws.append(
                Draw(
                    issue=str(row["issue"]),
                    draw_date=date.fromisoformat(row["draw_date"]),
                    front=front,
                    back=back,
                )
            )
    if not draws:
        raise ValueError(f"没有读取到数据: {path}")
    if draws != sorted(draws, key=lambda item: (item.draw_date, item.issue)):
        raise ValueError(f"数据必须按开奖日期升序排列: {path}")
    if len({draw.issue for draw in draws}) != len(draws):
        raise ValueError(f"存在重复期号: {path}")
    for draw in draws:
        validate_draw(draw, spec)
    return draws


def validate_draw(draw: Draw, spec: GameSpec) -> None:
    for zone_name, numbers, expected_count, pool_size in (
        ("front", draw.front, spec.front_pick, spec.front_pool),
        ("back", draw.back, spec.back_pick, spec.back_pool),
    ):
        if len(numbers) != expected_count:
            raise ValueError(
                f"{spec.name} {draw.issue} {zone_name} 号码数量应为 {expected_count}"
            )
        if tuple(sorted(numbers)) != numbers or len(set(numbers)) != len(numbers):
            raise ValueError(f"{spec.name} {draw.issue} {zone_name} 号码需升序且不重复")
        if not all(1 <= number <= pool_size for number in numbers):
            raise ValueError(f"{spec.name} {draw.issue} {zone_name} 号码越界")


def _load_entry_draws(path: Path, spec: GameSpec) -> list[Draw]:
    if not path.exists():
        return []
    entry_draws: list[Draw] = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("lottery_code") != spec.code:
                continue
            draw = Draw(
                issue=str(row["issue"]),
                draw_date=date.fromisoformat(row["draw_date"]),
                front=tuple(int(value) for value in row["front_numbers"].split()),
                back=tuple(int(value) for value in row["back_numbers"].split()),
            )
            validate_draw(draw, spec)
            entry_draws.append(draw)
    return entry_draws


def load_effective_draws(
    base_path: Path,
    spec: GameSpec,
    manual_entries_path: Path | None = None,
    synced_entries_path: Path | None = None,
) -> list[Draw]:
    """Load immutable history plus independent manual and automatic layers.

    Identical records may exist in more than one layer after a later full-history
    refresh; they are de-duplicated.  A same-issue conflict is always rejected.
    """

    layered: list[tuple[str, Draw]] = [
        ("历史 CSV", draw) for draw in load_draws(base_path, spec)
    ]
    for label, path in (
        ("手工录入", manual_entries_path),
        ("自动同步", synced_entries_path),
    ):
        if path is not None:
            layered.extend((label, draw) for draw in _load_entry_draws(path, spec))

    by_issue: dict[str, tuple[str, Draw]] = {}
    for source_label, draw in layered:
        existing = by_issue.get(draw.issue)
        if existing is None:
            by_issue[draw.issue] = (source_label, draw)
            continue
        existing_label, existing_draw = existing
        if existing_draw != draw:
            raise ValueError(
                f"{spec.name}期号 {draw.issue} 在{existing_label}与{source_label}中存在冲突"
            )

    return sorted(
        (draw for _, draw in by_issue.values()),
        key=lambda item: (item.draw_date, item.issue),
    )


def build_binary_matrix(draws: Sequence[Draw], zone: str, pool_size: int) -> np.ndarray:
    matrix = np.zeros((len(draws), pool_size), dtype=np.float64)
    for row_index, draw in enumerate(draws):
        numbers = draw.front if zone == "front" else draw.back
        matrix[row_index, np.asarray(numbers, dtype=int) - 1] = 1.0
    return matrix


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_unit(*parts: object) -> float:
    raw = "|".join(str(part) for part in parts).encode("utf-8")
    value = int.from_bytes(hashlib.sha256(raw).digest()[:8], "big")
    return (value + 0.5) / 2**64


def one_based_mod(value: int, modulus: int) -> int:
    return (value - 1) % modulus + 1


@lru_cache(maxsize=4)
def _load_lunar_calendar_table(path_text: str) -> dict[date, LunarDate]:
    path = Path(path_text)
    result: dict[date, LunarDate] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            item_date = date.fromisoformat(str(row["date"]))
            if item_date in result:
                raise ValueError(f"农历缓存存在重复日期: {item_date.isoformat()}")
            result[item_date] = LunarDate(
                cyclical_year=int(row["cyclical_year"]),
                month=int(row["month"]),
                day=int(row["day"]),
                is_leap_month=str(row["is_leap_month"]).strip().lower()
                in {"1", "true", "yes"},
            )
    if not result:
        raise ValueError(f"农历缓存为空: {path}")
    return result


def load_lunar_dates(
    dates: Iterable[date],
    swift_helper: Path,
    calendar_table_path: Path | None = None,
) -> tuple[dict[date, LunarDate], str]:
    unique_dates = sorted(set(dates))
    if calendar_table_path is not None:
        if not calendar_table_path.exists():
            raise ValueError(f"农历缓存不存在: {calendar_table_path}")
        table = _load_lunar_calendar_table(str(calendar_table_path.resolve()))
        missing = [item for item in unique_dates if item not in table]
        if missing:
            preview = ", ".join(item.isoformat() for item in missing[:3])
            raise ValueError(f"农历缓存缺少 {len(missing)} 个日期，示例: {preview}")
        return (
            {item: table[item] for item in unique_dates},
            "Cached Chinese lunar calendar (Asia/Shanghai)",
        )

    swift = shutil.which("swift")
    if swift and swift_helper.exists():
        payload = "\n".join(item.isoformat() for item in unique_dates) + "\n"
        try:
            completed = subprocess.run(
                [swift, str(swift_helper)],
                input=payload,
                text=True,
                capture_output=True,
                check=True,
                timeout=60,
            )
            result: dict[date, LunarDate] = {}
            for line in completed.stdout.splitlines():
                raw_date, year, month, day, leap = line.split(",")
                result[date.fromisoformat(raw_date)] = LunarDate(
                    cyclical_year=int(year),
                    month=int(month),
                    day=int(day),
                    is_leap_month=leap == "1",
                )
            if len(result) == len(unique_dates):
                return result, "Foundation Chinese Calendar (Asia/Shanghai)"
        except (OSError, subprocess.SubprocessError, ValueError):
            pass

    raise RuntimeError(
        "无法加载中国农历：请提供完整的历法缓存，或在 macOS 上安装 Swift 并保留历法转换脚本"
    )


def _sigmoid(values: np.ndarray) -> np.ndarray:
    clipped = np.clip(values, -40.0, 40.0)
    return 1.0 / (1.0 + np.exp(-clipped))


def _shift_logits_to_sum(logits: np.ndarray, target_sum: float) -> np.ndarray:
    low, high = -40.0, 40.0
    for _ in range(70):
        middle = (low + high) / 2.0
        current = float(_sigmoid(logits + middle).sum())
        if current < target_sum:
            low = middle
        else:
            high = middle
    return _sigmoid(logits + (low + high) / 2.0)


def probabilities_from_scores(scores: np.ndarray, pick_count: int) -> np.ndarray:
    scores = np.asarray(scores, dtype=float)
    standard_deviation = float(scores.std())
    if standard_deviation < EPS:
        return np.full(scores.shape, pick_count / len(scores), dtype=float)
    standardized = (scores - float(scores.mean())) / standard_deviation
    return _shift_logits_to_sum(standardized, float(pick_count))


def normalize_direct_probabilities(probabilities: np.ndarray, pick_count: int) -> np.ndarray:
    clipped = np.clip(np.asarray(probabilities, dtype=float), EPS, 1.0 - EPS)
    logits = np.log(clipped / (1.0 - clipped))
    return _shift_logits_to_sum(logits, float(pick_count))


def rank_rows(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=float)
    result = np.zeros_like(values)
    width = values.shape[1]
    if width <= 1:
        return result
    for row_index in range(values.shape[0]):
        order = np.argsort(values[row_index], kind="mergesort")
        result[row_index, order] = np.linspace(0.0, 1.0, width)
    return result


TRIGRAM_BITS = {
    1: (1, 1, 1),  # 乾
    2: (1, 1, 0),  # 兑
    3: (1, 0, 1),  # 离
    4: (1, 0, 0),  # 震
    5: (0, 1, 1),  # 巽
    6: (0, 1, 0),  # 坎
    7: (0, 0, 1),  # 艮
    8: (0, 0, 0),  # 坤
}
BITS_TRIGRAM = {value: key for key, value in TRIGRAM_BITS.items()}


def meihua_components(lunar: LunarDate, hour_branch: int = 12) -> tuple[int, int, int, int]:
    year_branch = one_based_mod(lunar.cyclical_year, 12)
    base = year_branch + lunar.month + lunar.day
    upper = one_based_mod(base, 8)
    lower = one_based_mod(base + hour_branch, 8)
    moving_line = one_based_mod(base + hour_branch, 6)

    upper_bits = list(TRIGRAM_BITS[upper])
    lower_bits = list(TRIGRAM_BITS[lower])
    if moving_line <= 3:
        lower_bits[moving_line - 1] ^= 1
    else:
        upper_bits[moving_line - 4] ^= 1
    changed = BITS_TRIGRAM[
        tuple(lower_bits if moving_line <= 3 else upper_bits)
    ]
    return upper, lower, moving_line, changed


def xiaoliuren_components(lunar: LunarDate, hour_branch: int = 12) -> tuple[int, int, int]:
    month_palace = one_based_mod(lunar.month, 6)
    day_palace = one_based_mod(month_palace + lunar.day - 1, 6)
    hour_palace = one_based_mod(day_palace + hour_branch - 1, 6)
    return month_palace, day_palace, hour_palace


def _traditional_scores(
    model_name: str,
    lunar: LunarDate,
    pool_size: int,
    tie_seed: str,
    hour_branch: int,
) -> np.ndarray:
    numbers = np.arange(1, pool_size + 1)
    if model_name == "meihua_yishu":
        upper, lower, moving_line, changed = meihua_components(lunar, hour_branch)
        scores = (
            1.50 * (one_based_mod_array(numbers, 8) == upper)
            + 1.20 * (one_based_mod_array(numbers, 8) == lower)
            + 0.80 * (one_based_mod_array(numbers, 6) == moving_line)
            + 0.55 * (one_based_mod_array(numbers, 8) == changed)
        ).astype(float)
    elif model_name == "xiaoliu_ren":
        month_palace, day_palace, hour_palace = xiaoliuren_components(
            lunar, hour_branch
        )
        residues = one_based_mod_array(numbers, 6)
        scores = (
            0.45 * (residues == month_palace)
            + 0.80 * (residues == day_palace)
            + 1.50 * (residues == hour_palace)
        ).astype(float)
    else:
        raise ValueError(model_name)
    tie_noise = np.asarray(
        [stable_unit(model_name, tie_seed, number) for number in numbers]
    )
    return scores + tie_noise * 1e-6


def one_based_mod_array(values: np.ndarray, modulus: int) -> np.ndarray:
    return (values - 1) % modulus + 1


def _chaos_scores(pool_size: int, seed_parts: Sequence[object]) -> np.ndarray:
    x = 0.05 + 0.90 * stable_unit(*seed_parts)
    for _ in range(40):
        x = 4.0 * x * (1.0 - x)
        x = min(max(x, EPS), 1.0 - EPS)
    values = []
    for _ in range(pool_size):
        x = 4.0 * x * (1.0 - x)
        x = min(max(x, EPS), 1.0 - EPS)
        values.append(x)
    return np.asarray(values, dtype=float)


def resolve_model_parameters(
    model_parameters: dict[str, dict[str, float | int]] | None = None,
) -> dict[str, dict[str, float | int]]:
    resolved = {
        model_name: dict(parameters)
        for model_name, parameters in DEFAULT_MODEL_PARAMETERS.items()
    }
    if model_parameters:
        for model_name, parameters in model_parameters.items():
            if model_name not in resolved:
                raise ValueError(f"未知可调模型参数: {model_name}")
            resolved[model_name].update(parameters)
    for model_name, parameters in resolved.items():
        if float(parameters["prior_strength"]) <= 0:
            raise ValueError(f"{model_name} prior_strength 必须大于 0")
        if "window" in parameters and int(parameters["window"]) <= 0:
            raise ValueError(f"{model_name} window 必须大于 0")
        if "half_life" in parameters and float(parameters["half_life"]) <= 0:
            raise ValueError(f"{model_name} half_life 必须大于 0")
    return resolved


def generate_base_predictions(
    draws: Sequence[Draw],
    spec: GameSpec,
    zone: str,
    lunar_dates: dict[date, LunarDate],
    hour_branch: int = 12,
    model_parameters: dict[str, dict[str, float | int]] | None = None,
) -> tuple[np.ndarray, dict[str, dict[str, np.ndarray]]]:
    if zone == "front":
        pool_size, pick_count = spec.front_pool, spec.front_pick
    else:
        pool_size, pick_count = spec.back_pool, spec.back_pick

    actual = build_binary_matrix(draws, zone, pool_size)
    draw_count = len(draws)
    p0 = pick_count / pool_size
    resolved_parameters = resolve_model_parameters(model_parameters)
    all_prior = float(
        resolved_parameters["bayesian_all"]["prior_strength"]
    )
    recent_prior = float(
        resolved_parameters["bayesian_recent_120"]["prior_strength"]
    )
    recent_window = int(resolved_parameters["bayesian_recent_120"]["window"])
    exp_prior = float(resolved_parameters["exp_decay_60"]["prior_strength"])
    exp_half_life = float(
        resolved_parameters["exp_decay_60"]["half_life"]
    )
    model_names = [name for name in MODEL_GROUPS if name != "ga_ensemble"]
    predictions = {
        name: {
            "scores": np.zeros((draw_count, pool_size), dtype=float),
            "probabilities": np.zeros((draw_count, pool_size), dtype=float),
        }
        for name in model_names
    }

    cumulative = np.vstack(
        [np.zeros((1, pool_size), dtype=float), np.cumsum(actual, axis=0)]
    )
    decay = 0.5 ** (1.0 / exp_half_life)
    exp_counts = np.zeros((draw_count + 1, pool_size), dtype=float)
    exp_mass = np.zeros(draw_count + 1, dtype=float)
    for target_index in range(1, draw_count + 1):
        exp_counts[target_index] = (
            decay * exp_counts[target_index - 1] + actual[target_index - 1]
        )
        exp_mass[target_index] = decay * exp_mass[target_index - 1] + 1.0

    gaps = np.zeros((draw_count, pool_size), dtype=float)
    last_seen = np.full(pool_size, -1, dtype=int)
    for target_index in range(draw_count):
        gaps[target_index] = np.where(
            last_seen >= 0, target_index - 1 - last_seen, target_index + 1
        )
        last_seen[actual[target_index] > 0.5] = target_index

    transition_counts = np.zeros((pool_size, pool_size), dtype=float)
    transition_denominators = np.zeros(pool_size, dtype=float)
    cooccurrence_counts = np.zeros((pool_size, pool_size), dtype=float)
    occurrence_counts = np.zeros(pool_size, dtype=float)
    relation_prior_strength = 24.0

    for target_index, draw in enumerate(draws):
        history_size = target_index
        tie_seed = f"{spec.code}|{zone}|{draw.issue}|{draw.draw_date.isoformat()}"
        tie_noise = np.asarray(
            [stable_unit(tie_seed, number) for number in range(1, pool_size + 1)]
        )

        uniform_scores = tie_noise.copy()
        uniform_probabilities = np.full(pool_size, p0, dtype=float)

        all_counts = cumulative[target_index]
        bayesian_all = (all_counts + all_prior * p0) / (
            history_size + all_prior
        )

        recent_start = max(0, target_index - recent_window)
        recent_size = target_index - recent_start
        recent_counts = cumulative[target_index] - cumulative[recent_start]
        bayesian_recent = (recent_counts + recent_prior * p0) / (
            recent_size + recent_prior
        )

        exp_probability = (
            exp_counts[target_index] + exp_prior * p0
        ) / (exp_mass[target_index] + exp_prior)

        short_start = max(0, target_index - 30)
        long_start = max(0, target_index - 200)
        short_size = max(1, target_index - short_start)
        long_size = max(1, target_index - long_start)
        short_frequency = (
            cumulative[target_index] - cumulative[short_start]
        ) / short_size
        long_frequency = (
            cumulative[target_index] - cumulative[long_start]
        ) / long_size
        hot_cold = short_frequency - long_frequency + tie_noise * 1e-9

        gap_scores = gaps[target_index] + tie_noise * 1e-6

        if target_index > 0:
            anchors = np.flatnonzero(actual[target_index - 1] > 0.5)
        else:
            anchors = np.asarray([], dtype=int)

        if anchors.size and float(transition_denominators[anchors].sum()) > 0:
            denominator = float(transition_denominators[anchors].sum())
            transition_probability = (
                transition_counts[anchors].sum(axis=0)
                + relation_prior_strength * len(anchors) * p0
            ) / (denominator + relation_prior_strength * len(anchors))
        else:
            transition_probability = np.full(pool_size, p0, dtype=float)

        if anchors.size and float(occurrence_counts[anchors].sum()) > 0:
            denominator = float(occurrence_counts[anchors].sum())
            cooccurrence_probability = (
                cooccurrence_counts[anchors].sum(axis=0)
                + relation_prior_strength * len(anchors) * p0
            ) / (denominator + relation_prior_strength * len(anchors))
        else:
            cooccurrence_probability = np.full(pool_size, p0, dtype=float)

        chaos_scores = _chaos_scores(
            pool_size,
            ("logistic", spec.code, zone, draw.issue, draw.draw_date.isoformat()),
        )
        lunar = lunar_dates[draw.draw_date]
        meihua_scores = _traditional_scores(
            "meihua_yishu", lunar, pool_size, tie_seed, hour_branch
        )
        xiaoliu_scores = _traditional_scores(
            "xiaoliu_ren", lunar, pool_size, tie_seed, hour_branch
        )

        direct_models = {
            "uniform_random": (uniform_scores, uniform_probabilities),
            "bayesian_all": (bayesian_all + tie_noise * 1e-12, bayesian_all),
            "bayesian_recent_120": (
                bayesian_recent + tie_noise * 1e-12,
                bayesian_recent,
            ),
            "exp_decay_60": (
                exp_probability + tie_noise * 1e-12,
                exp_probability,
            ),
            "markov_transition": (
                transition_probability + tie_noise * 1e-12,
                transition_probability,
            ),
            "cooccurrence_network": (
                cooccurrence_probability + tie_noise * 1e-12,
                cooccurrence_probability,
            ),
        }
        score_models = {
            "hot_cold": hot_cold,
            "overdue_gap": gap_scores,
            "chaos_logistic": chaos_scores,
            "meihua_yishu": meihua_scores,
            "xiaoliu_ren": xiaoliu_scores,
        }

        for name, (scores, probabilities) in direct_models.items():
            predictions[name]["scores"][target_index] = scores
            predictions[name]["probabilities"][target_index] = (
                normalize_direct_probabilities(probabilities, pick_count)
            )
        for name, scores in score_models.items():
            predictions[name]["scores"][target_index] = scores
            predictions[name]["probabilities"][target_index] = (
                probabilities_from_scores(scores, pick_count)
            )

        if target_index >= 1:
            previous = actual[target_index - 1]
            current = actual[target_index]
            previous_indices = np.flatnonzero(previous > 0.5)
            transition_counts[previous_indices] += current
            transition_denominators[previous_indices] += 1.0
        current_indices = np.flatnonzero(actual[target_index] > 0.5)
        cooccurrence_counts[np.ix_(current_indices, current_indices)] += 1.0
        occurrence_counts[current_indices] += 1.0

    return actual, predictions


def _population_fitness(
    population: np.ndarray,
    score_tensor: np.ndarray,
    probability_tensor: np.ndarray,
    actual: np.ndarray,
    pick_count: int,
) -> np.ndarray:
    combined_scores = np.einsum("pm,mtn->ptn", population, score_tensor)
    selected = np.argpartition(combined_scores, -pick_count, axis=2)[
        :, :, -pick_count:
    ]
    expanded_actual = np.broadcast_to(actual, combined_scores.shape)
    hits = np.take_along_axis(expanded_actual, selected, axis=2).sum(axis=2)
    mean_hits = hits.mean(axis=1)
    combined_probabilities = np.einsum(
        "pm,mtn->ptn", population, probability_tensor
    )
    brier = ((combined_probabilities - expanded_actual) ** 2).mean(axis=(1, 2))
    return mean_hits - 0.10 * brier


def optimize_ga_weights(
    predictions: dict[str, dict[str, np.ndarray]],
    actual: np.ndarray,
    validation_indices: np.ndarray,
    pick_count: int,
    seed: int,
    population_size: int = 48,
    generations: int = 50,
) -> tuple[list[str], np.ndarray, float]:
    base_names = [name for name in predictions if name != "uniform_random"]
    score_tensor = np.stack(
        [rank_rows(predictions[name]["scores"][validation_indices]) for name in base_names]
    )
    probability_tensor = np.stack(
        [predictions[name]["probabilities"][validation_indices] for name in base_names]
    )
    validation_actual = actual[validation_indices]
    model_count = len(base_names)
    rng = np.random.default_rng(seed)

    population = rng.dirichlet(np.ones(model_count), size=population_size)
    population[0] = np.full(model_count, 1.0 / model_count)
    for model_index in range(min(model_count, population_size - 1)):
        population[model_index + 1] = 0.0
        population[model_index + 1, model_index] = 1.0

    best_fitness = -math.inf
    best_weights = population[0].copy()
    for _ in range(generations):
        fitness = _population_fitness(
            population,
            score_tensor,
            probability_tensor,
            validation_actual,
            pick_count,
        )
        best_index = int(np.argmax(fitness))
        if float(fitness[best_index]) > best_fitness:
            best_fitness = float(fitness[best_index])
            best_weights = population[best_index].copy()

        elite_count = max(4, population_size // 8)
        elite_indices = np.argsort(fitness)[-elite_count:]
        new_population = [population[index].copy() for index in elite_indices]
        while len(new_population) < population_size:
            candidates_a = rng.integers(0, population_size, size=4)
            candidates_b = rng.integers(0, population_size, size=4)
            parent_a = population[candidates_a[np.argmax(fitness[candidates_a])]]
            parent_b = population[candidates_b[np.argmax(fitness[candidates_b])]]
            mix = rng.uniform(0.2, 0.8)
            child = mix * parent_a + (1.0 - mix) * parent_b
            if rng.random() < 0.85:
                child += rng.normal(0.0, 0.07, size=model_count)
            child = np.clip(child, 0.0, None)
            if float(child.sum()) < EPS:
                child = np.full(model_count, 1.0 / model_count)
            else:
                child /= child.sum()
            new_population.append(child)
        population = np.asarray(new_population[:population_size])

    return base_names, best_weights, best_fitness


def add_ga_prediction(
    predictions: dict[str, dict[str, np.ndarray]],
    base_names: Sequence[str],
    weights: np.ndarray,
) -> None:
    ranked_scores = np.stack(
        [rank_rows(predictions[name]["scores"]) for name in base_names]
    )
    probabilities = np.stack(
        [predictions[name]["probabilities"] for name in base_names]
    )
    predictions["ga_ensemble"] = {
        "scores": np.einsum("m,mtn->tn", weights, ranked_scores),
        "probabilities": np.einsum("m,mtn->tn", weights, probabilities),
    }


def selected_numbers(scores: np.ndarray, pick_count: int) -> np.ndarray:
    indices = np.argpartition(scores, -pick_count, axis=1)[:, -pick_count:]
    return np.sort(indices + 1, axis=1)


def _hypergeometric_variance(pool_size: int, pick_count: int) -> float:
    if pool_size <= 1:
        return 0.0
    probability = pick_count / pool_size
    return (
        pick_count
        * probability
        * (1.0 - probability)
        * ((pool_size - pick_count) / (pool_size - 1))
    )


def evaluate_model(
    model_name: str,
    scores: np.ndarray,
    probabilities: np.ndarray,
    actual: np.ndarray,
    pool_size: int,
    pick_count: int,
) -> tuple[dict[str, float | int | str], np.ndarray, np.ndarray]:
    from p1_analysis import conditional_bernoulli_nll

    selected = selected_numbers(scores, pick_count)
    actual_numbers = np.stack(
        [np.flatnonzero(row > 0.5) + 1 for row in actual], axis=0
    )
    selected_zero = selected - 1
    hits = np.take_along_axis(actual, selected_zero, axis=1).sum(axis=1)
    expected_hits = pick_count * pick_count / pool_size
    variance = _hypergeometric_variance(pool_size, pick_count)
    standard_error = math.sqrt(variance / len(hits)) if hits.size else math.nan
    mean_hits = float(hits.mean())
    z_score = (
        (mean_hits - expected_hits) / standard_error
        if standard_error and standard_error > 0
        else 0.0
    )
    p_value = math.erfc(abs(z_score) / math.sqrt(2.0))
    clipped_probabilities = np.clip(probabilities, EPS, 1.0 - EPS)
    brier = float(((clipped_probabilities - actual) ** 2).mean())
    log_loss = float(
        -(
            actual * np.log(clipped_probabilities)
            + (1.0 - actual) * np.log(1.0 - clipped_probabilities)
        ).mean()
    )
    log_odds = np.log(clipped_probabilities) - np.log1p(
        -clipped_probabilities
    )
    combination_losses = conditional_bernoulli_nll(
        log_odds,
        actual,
        pick_count=pick_count,
        reduction="none",
    )
    combination_nll = float(np.mean(combination_losses))
    uniform_combination_nll = math.log(math.comb(pool_size, pick_count))
    uniform_brier = (pick_count / pool_size) * (1.0 - pick_count / pool_size)
    metrics: dict[str, float | int | str] = {
        "model": model_name,
        "model_group": MODEL_GROUPS[model_name],
        "test_draws": int(len(hits)),
        "mean_hits": mean_hits,
        "expected_uniform_hits": expected_hits,
        "hit_lift": mean_hits / expected_hits if expected_hits else math.nan,
        "topk_recall": mean_hits / pick_count,
        "zone_exact_rate": float((hits == pick_count).mean()),
        "brier": brier,
        "brier_skill_vs_uniform": 1.0 - brier / uniform_brier,
        "log_loss": log_loss,
        "combination_nll": combination_nll,
        "uniform_combination_nll": uniform_combination_nll,
        "combination_nll_skill_vs_uniform": (
            1.0 - combination_nll / uniform_combination_nll
            if uniform_combination_nll
            else math.nan
        ),
        "combination_perplexity": math.exp(combination_nll),
        "z_score_vs_uniform": z_score,
        "p_value_two_sided": p_value,
        "mean_hits_ci95_low": mean_hits - 1.96 * standard_error,
        "mean_hits_ci95_high": mean_hits + 1.96 * standard_error,
    }
    return metrics, selected, actual_numbers


def chi_square_survival_approx(statistic: float, degrees_of_freedom: int) -> float:
    if degrees_of_freedom <= 0:
        return math.nan
    transformed = (
        (statistic / degrees_of_freedom) ** (1.0 / 3.0)
        - (1.0 - 2.0 / (9.0 * degrees_of_freedom))
    ) / math.sqrt(2.0 / (9.0 * degrees_of_freedom))
    return 0.5 * math.erfc(transformed / math.sqrt(2.0))


def randomness_diagnostics(
    actual: np.ndarray, pool_size: int, pick_count: int
) -> list[dict[str, float | int | str]]:
    draw_count = actual.shape[0]
    counts = actual.sum(axis=0)
    probability = pick_count / pool_size
    expected_count = draw_count * probability
    covariance_eigenvalue = (
        draw_count
        * probability
        * (1.0 - probability)
        * pool_size
        / (pool_size - 1)
    )
    chi_square = float(((counts - expected_count) ** 2).sum() / covariance_eigenvalue)
    lag_correlations = []
    for number_index in range(pool_size):
        left = actual[:-1, number_index]
        right = actual[1:, number_index]
        if float(left.std()) > EPS and float(right.std()) > EPS:
            lag_correlations.append(float(np.corrcoef(left, right)[0, 1]))
    repeats = (actual[:-1] * actual[1:]).sum(axis=1)
    expected_repeat = pick_count * pick_count / pool_size
    return [
        {
            "metric": "marginal_uniformity_covariance_chi_square",
            "value": chi_square,
            "reference": float(pool_size - 1),
            "p_value_approx": chi_square_survival_approx(
                chi_square, pool_size - 1
            ),
        },
        {
            "metric": "max_abs_count_z",
            "value": float(
                np.max(
                    np.abs(counts - expected_count)
                    / math.sqrt(draw_count * probability * (1 - probability))
                )
            ),
            "reference": 0.0,
            "p_value_approx": math.nan,
        },
        {
            "metric": "mean_lag1_autocorrelation",
            "value": float(np.mean(lag_correlations)),
            "reference": 0.0,
            "p_value_approx": math.nan,
        },
        {
            "metric": "max_abs_lag1_autocorrelation",
            "value": float(np.max(np.abs(lag_correlations))),
            "reference": 0.0,
            "p_value_approx": math.nan,
        },
        {
            "metric": "mean_adjacent_repeat_count",
            "value": float(repeats.mean()),
            "reference": expected_repeat,
            "p_value_approx": math.nan,
        },
    ]


def write_csv(path: Path, rows: Sequence[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        raise ValueError(f"拒绝写入空 CSV: {path}")
    fieldnames = list(rows[0].keys())
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def suggest_next_draw(draws: Sequence[Draw], spec: GameSpec) -> tuple[str, date]:
    latest = draws[-1]
    weekdays = {"ssq": {1, 3, 6}, "dlt": {0, 2, 5}}[spec.code]
    candidate = latest.draw_date
    while True:
        candidate = candidate.fromordinal(candidate.toordinal() + 1)
        if candidate.weekday() in weekdays:
            break
    if candidate.year != latest.draw_date.year:
        year_prefix = str(candidate.year) if spec.code == "ssq" else f"{candidate.year % 100:02d}"
        next_issue = f"{year_prefix}001"
    else:
        issue_width = len(latest.issue)
        next_issue = str(int(latest.issue) + 1).zfill(issue_width)
    return next_issue, candidate


def predict_target(
    data_path: Path,
    spec: GameSpec,
    target_issue: str,
    target_date: date,
    swift_helper: Path,
    ga_weights_path: Path,
    manual_entries_path: Path | None = None,
    synced_entries_path: Path | None = None,
    lunar_calendar_path: Path | None = None,
    hour_branch: int = 12,
    progress_callback: Callable[[dict[str, object]], None] | None = None,
) -> dict[str, object]:
    def emit(
        progress: int,
        stage: str,
        title: str,
        detail: str,
        *,
        zone: str | None = None,
        models: Sequence[str] = (),
    ) -> None:
        if progress_callback is not None:
            progress_callback(
                {
                    "progress": progress,
                    "stage": stage,
                    "title": title,
                    "detail": detail,
                    "zone": zone,
                    "models": list(models),
                }
            )

    emit(
        2,
        "history",
        "读取三层开奖记录",
        "合并原始历史、自动补入与手工记录，并检查期号、日期和号码边界。",
    )
    raw_draws = load_effective_draws(
        data_path,
        spec,
        manual_entries_path,
        synced_entries_path,
    )
    emit(
        9,
        "model_window",
        "冻结模型历史窗口",
        "应用预注册训练起点；大乐透 2014 年前记录只保留审计，不进入当前模型状态。",
    )
    if target_issue in {draw.issue for draw in raw_draws}:
        raise ValueError(f"期号已存在: {target_issue}")
    if target_date < raw_draws[-1].draw_date:
        raise ValueError("预测日期不能早于当前最新开奖日期")
    weights_payload = json.loads(ga_weights_path.read_text(encoding="utf-8"))
    configured_start = (
        weights_payload.get("_meta", {})
        .get("model_start_dates", {})
        .get(spec.code)
    )
    model_start_date = (
        date.fromisoformat(str(configured_start))
        if configured_start
        else DEFAULT_MODEL_START_DATES[spec.code]
    )
    draws = filter_draws_for_model(raw_draws, model_start_date)
    dummy = Draw(
        issue=target_issue,
        draw_date=target_date,
        front=tuple(),
        back=tuple(),
    )
    extended = [*draws, dummy]
    emit(
        15,
        "calendar",
        "换算日期与传统模型特征",
        "为梅花易数和小六壬生成 Asia/Shanghai 农历年月日与固定亥时特征。",
        models=("meihua_yishu", "xiaoliu_ren"),
    )
    lunar_dates, calendar_source = load_lunar_dates(
        (draw.draw_date for draw in extended),
        swift_helper,
        lunar_calendar_path,
    )
    emit(
        34,
        "calendar_ready",
        "历法特征已冻结",
        f"本次历法来源：{calendar_source}。接下来分别计算前后区模型状态。",
        models=("meihua_yishu", "xiaoliu_ren"),
    )
    result: dict[str, object] = {
        "lottery_code": spec.code,
        "lottery_name": spec.name,
        "issue": target_issue,
        "target_date": target_date.isoformat(),
        "calendar_source": calendar_source,
        "model_start_date": (
            model_start_date.isoformat() if model_start_date else None
        ),
        "model_draw_count": len(draws),
        "excluded_history_count": len(raw_draws) - len(draws),
        "warning": "实验性排序结果，不代表中奖概率高于官方随机基线。",
        "zones": {},
    }
    zone_specs = (
        ("front", spec.front_pool, spec.front_pick, 38, 58, 64),
        ("back", spec.back_pool, spec.back_pick, 68, 88, 94),
    )
    base_model_names = tuple(
        name for name in MODEL_GROUPS if name != "ga_ensemble"
    )
    for zone, pool_size, pick_count, start_progress, base_done, zone_done in zone_specs:
        ga_key = f"{spec.code}_{zone}"
        if ga_key not in weights_payload:
            raise ValueError(f"缺少遗传算法权重: {ga_key}")
        selected_parameters = weights_payload[ga_key].get(
            "model_parameters",
            DEFAULT_MODEL_PARAMETERS,
        )
        zone_label = (
            "红球" if spec.code == "ssq" and zone == "front"
            else "蓝球" if spec.code == "ssq"
            else "前区" if zone == "front"
            else "后区"
        )
        emit(
            start_progress,
            f"{zone}_models",
            f"{zone_label}：基础模型与随机基线并行更新",
            "更新贝叶斯频率、指数衰减、冷热差、遗漏、转移、共现、混沌与两组传统规则。",
            zone=zone,
            models=base_model_names,
        )
        _, predictions = generate_base_predictions(
            extended,
            spec,
            zone,
            lunar_dates,
            hour_branch=hour_branch,
            model_parameters=selected_parameters,
        )
        emit(
            base_done,
            f"{zone}_ensemble",
            f"{zone_label}：遗传算法权重集成",
            "读取训练阶段冻结的非负权重，对十个基础模型的排序与概率进行集成。",
            zone=zone,
            models=("ga_ensemble",),
        )
        weight_map = weights_payload[ga_key]["weights"]
        base_names = list(weight_map)
        weights = np.asarray([float(weight_map[name]) for name in base_names])
        add_ga_prediction(predictions, base_names, weights)
        emit(
            zone_done,
            f"{zone}_ranking",
            f"{zone_label}：生成固定大小号码组合",
            f"把每个模型的分数排序为恰好 {pick_count} 个号码，并保留前十位包含概率用于解释。",
            zone=zone,
            models=tuple(predictions),
        )
        zone_result: dict[str, object] = {
            "pool_size": pool_size,
            "pick_count": pick_count,
            "model_parameters": selected_parameters,
            "models": {},
        }
        for model_name, values in predictions.items():
            scores = values["scores"][-1:]
            probabilities = values["probabilities"][-1]
            chosen = selected_numbers(scores, pick_count)[0]
            ranked = np.argsort(values["scores"][-1])[::-1]
            zone_result["models"][model_name] = {
                "numbers": [int(number) for number in chosen],
                "top_scores": [
                    {
                        "number": int(index + 1),
                        "inclusion_probability": float(probabilities[index]),
                    }
                    for index in ranked[: min(10, pool_size)]
                ],
            }
        result["zones"][zone] = zone_result
    emit(
        98,
        "finalize",
        "封装预测实验结果",
        "合并前后区、模型参数、历法来源与风险提示，准备渲染结果卡片。",
    )
    return result


def run_experiment(
    data_paths: dict[str, Path],
    output_dir: Path,
    swift_helper: Path,
    manual_entries_path: Path | None = None,
    synced_entries_path: Path | None = None,
    lunar_calendar_path: Path | None = None,
    validation_start_ratio: float = 0.60,
    test_start_ratio: float = 0.80,
    hour_branch: int = 12,
    ga_population: int = 48,
    ga_generations: int = 50,
    model_start_dates: dict[str, date | None] | None = None,
    audit_permutations: int = 999,
    audit_batch_size: int = 16,
    era_permutations: int = 199,
    pipeline_null_repetitions: int = 99,
    pipeline_null_workers: int = 1,
    pipeline_null_backend: str = "sequential",
    p1_bootstrap_repetitions: int = 1999,
    p1_calibration_bins: int = 10,
    p1_max_inner_folds: int = 5,
) -> dict[str, object]:
    from null_audit import order_statistic_q_audit, whole_draw_shuffle_test
    from p0_reporting import run_p0_period_audit
    from p1_analysis import (
        brier_decomposition,
        calibration_bins,
        moving_block_bootstrap_brier_difference,
    )
    from pipeline_adapter import (
        LotteryPipelineEvaluator,
        build_fixed_prediction_cache,
    )
    from pipeline_null import (
        FairHistorySpec,
        evaluate_pipeline_history,
        familywise_max_t_p_values,
        run_pipeline_null,
    )

    if not 0.0 < validation_start_ratio < test_start_ratio < 1.0:
        raise ValueError("时间切分必须满足 0 < validation < test < 1")
    if audit_permutations <= 0 or era_permutations <= 0:
        raise ValueError("审计代理次数必须大于 0")
    if audit_batch_size <= 0:
        raise ValueError("audit_batch_size 必须大于 0")
    if pipeline_null_repetitions < 0:
        raise ValueError("pipeline_null_repetitions 不能小于 0")
    if p1_bootstrap_repetitions <= 0:
        raise ValueError("p1_bootstrap_repetitions 必须大于 0")
    if p1_calibration_bins <= 0 or p1_max_inner_folds <= 0:
        raise ValueError("P1 分箱数和最大内层折叠数必须大于 0")

    tracked_input_paths: dict[str, Path] = {
        **{f"data:{code}": path for code, path in data_paths.items()},
    }
    if manual_entries_path is not None:
        tracked_input_paths["manual_entries"] = manual_entries_path
    if synced_entries_path is not None:
        tracked_input_paths["synced_entries"] = synced_entries_path
    if lunar_calendar_path is not None:
        tracked_input_paths["lunar_calendar"] = lunar_calendar_path

    def input_signature(path: Path) -> dict[str, object]:
        return {
            "exists": path.exists(),
            "sha256": sha256_file(path) if path.exists() else None,
        }

    input_snapshot = {
        name: input_signature(path) for name, path in tracked_input_paths.items()
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_draws = {
        code: load_effective_draws(
            data_paths[code],
            GAME_SPECS[code],
            manual_entries_path,
            synced_entries_path,
        )
        for code in ("ssq", "dlt")
    }
    after_load_snapshot = {
        name: input_signature(path) for name, path in tracked_input_paths.items()
    }
    if after_load_snapshot != input_snapshot:
        raise RuntimeError("输入数据在加载期间发生变化，已拒绝开始训练")
    effective_start_dates = dict(DEFAULT_MODEL_START_DATES)
    if model_start_dates:
        effective_start_dates.update(model_start_dates)
    all_draws = {
        code: filter_draws_for_model(draws, effective_start_dates[code])
        for code, draws in raw_draws.items()
    }
    lunar_dates, calendar_source = load_lunar_dates(
        (draw.draw_date for draws in raw_draws.values() for draw in draws),
        swift_helper,
        lunar_calendar_path,
    )

    metrics_rows: list[dict[str, object]] = []
    prediction_rows: list[dict[str, object]] = []
    diagnostics_rows: list[dict[str, object]] = []
    p0_summary_rows: list[dict[str, object]] = []
    pair_audit_rows: list[dict[str, object]] = []
    order_audit_rows: list[dict[str, object]] = []
    change_point_rows: list[dict[str, object]] = []
    era_audit_rows: list[dict[str, object]] = []
    cutoff_comparison_rows: list[dict[str, object]] = []
    pipeline_summary_rows: list[dict[str, object]] = []
    pipeline_replicate_rows: list[dict[str, object]] = []
    p1_hyperparameter_rows: list[dict[str, object]] = []
    bootstrap_rows: list[dict[str, object]] = []
    calibration_rows: list[dict[str, object]] = []
    brier_decomposition_rows: list[dict[str, object]] = []
    pipeline_reports: dict[str, object] = {}
    p1_selection_manifest: dict[str, object] = {}
    ga_weights: dict[str, object] = {
        "_meta": {
            "model_start_dates": {
                code: start.isoformat() if start else None
                for code, start in effective_start_dates.items()
            },
            "history_policy": (
                "pre-cutoff draws remain available for audit but are excluded "
                "from model-state calculations"
            ),
            "p1_parameter_policy": (
                "Bayesian prior/window/half-life selected by nested rolling "
                "Brier loss inside the first 60% formation region"
            ),
        }
    }
    split_manifest: dict[str, object] = {}

    source_crosscheck_csv = output_dir / "dlt_source_crosscheck.csv"
    source_crosscheck_json = output_dir / "dlt_source_crosscheck.json"
    equipment_by_issue: dict[str, int] = {}
    if source_crosscheck_csv.exists():
        with source_crosscheck_csv.open(
            "r", encoding="utf-8-sig", newline=""
        ) as handle:
            for row in csv.DictReader(handle):
                raw_value = row.get("equipment_set_reported")
                if raw_value is None:
                    raw_value = row.get("equipment_count_reported", "0")
                equipment_by_issue[str(row["issue"])] = int(raw_value or 0)

    def append_primary_audit(
        *,
        code: str,
        spec: GameSpec,
        zone: str,
        period_name: str,
        period_draws: Sequence[Draw],
        matrix: np.ndarray,
        seed: int,
    ) -> None:
        audit = run_p0_period_audit(
            matrix,
            permutations=audit_permutations,
            seed=seed,
            batch_size=audit_batch_size,
        )
        common = {
            "lottery_code": code,
            "lottery_name": spec.name,
            "zone": zone,
            "period": period_name,
            "period_draws": len(period_draws),
            "period_start_date": period_draws[0].draw_date.isoformat(),
            "period_end_date": period_draws[-1].draw_date.isoformat(),
        }

        for test_name, result, reference, adjustment in (
            (
                "whole_draw_adjacent_overlap",
                audit.adjacent_overlap,
                float(matrix.shape[1] and matrix.sum(axis=1)[0] ** 2 / matrix.shape[1]),
                "whole-draw shuffle; two-sided",
            ),
            (
                "whole_draw_max_abs_lag1_correlation",
                audit.lag1_correlation,
                0.0,
                "whole-draw shuffle; max statistic",
            ),
        ):
            p0_summary_rows.append(
                {
                    **common,
                    "test": test_name,
                    "statistic": result.observed_statistic,
                    "reference": reference,
                    "p_value": result.p_value,
                    "adjustment": adjustment,
                    "permutations": result.permutations,
                    "seed": result.seed,
                    "null_q95": float(np.quantile(result.null_distribution, 0.95)),
                    "null_q99": float(np.quantile(result.null_distribution, 0.99)),
                    "detail": "",
                }
            )

        pair = audit.pair_cooccurrence
        for test_name, rejected, adjusted_p in (
            (
                "pair_cooccurrence_bh_fdr_rejections",
                pair.bh_rejected,
                pair.bh_q_values,
            ),
            (
                "pair_cooccurrence_max_t_rejections",
                pair.max_t_rejected,
                pair.max_t_p_values,
            ),
        ):
            p0_summary_rows.append(
                {
                    **common,
                    "test": test_name,
                    "statistic": int(np.count_nonzero(rejected)),
                    "reference": 0,
                    "p_value": float(np.min(adjusted_p)),
                    "adjustment": (
                        "BH-FDR q=0.05" if "bh_fdr" in test_name else "Monte Carlo max-T"
                    ),
                    "permutations": pair.permutations,
                    "seed": pair.seed,
                    "null_q95": float(np.quantile(pair.null_max_statistics, 0.95)),
                    "null_q99": float(np.quantile(pair.null_max_statistics, 0.99)),
                    "detail": f"pairs={len(pair.pairs)}",
                }
            )
        for index, numbers in enumerate(pair.pairs):
            pair_audit_rows.append(
                {
                    **common,
                    "number_a": int(numbers[0]),
                    "number_b": int(numbers[1]),
                    "observed_count": float(pair.observed_counts[index]),
                    "expected_count": pair.expected_count,
                    "z_score": float(pair.z_scores[index]),
                    "raw_p_value": float(pair.raw_p_values[index]),
                    "bh_q_value": float(pair.bh_q_values[index]),
                    "bh_rejected": bool(pair.bh_rejected[index]),
                    "max_t_p_value": float(pair.max_t_p_values[index]),
                    "max_t_rejected": bool(pair.max_t_rejected[index]),
                    "permutations": pair.permutations,
                }
            )

        order = audit.order_statistics
        p0_summary_rows.append(
            {
                **common,
                "test": "order_statistic_q",
                "statistic": order.q_statistic,
                "reference": order.pick_count,
                "p_value": order.p_value,
                "adjustment": "fair k/N Monte Carlo",
                "permutations": order.permutations,
                "seed": order.seed,
                "null_q95": float(np.quantile(order.null_distribution, 0.95)),
                "null_q99": float(np.quantile(order.null_distribution, 0.99)),
                "detail": "sorted-number position means",
            }
        )
        for position in range(order.pick_count):
            order_audit_rows.append(
                {
                    **common,
                    "position": position + 1,
                    "sample_mean": float(order.sample_means[position]),
                    "theoretical_mean": float(order.theoretical_means[position]),
                    "standardized_deviation": float(
                        order.standardized_deviations[position]
                    ),
                    "q_statistic": order.q_statistic,
                    "p_value": order.p_value,
                    "permutations": order.permutations,
                }
            )

        change = audit.change_point
        before_index = max(0, change.change_point - 1)
        after_index = min(len(period_draws) - 1, change.change_point)
        change_point_rows.append(
            {
                **common,
                "change_index": change.change_point,
                "issue_before": period_draws[before_index].issue,
                "date_before": period_draws[before_index].draw_date.isoformat(),
                "issue_after": period_draws[after_index].issue,
                "date_after": period_draws[after_index].draw_date.isoformat(),
                "feature_number": change.feature_number,
                "statistic": change.statistic,
                "p_value": change.p_value,
                "min_segment": change.min_segment,
                "permutations": change.permutations,
                "seed": change.seed,
            }
        )
        p0_summary_rows.append(
            {
                **common,
                "test": "max_cusum_change_point",
                "statistic": change.statistic,
                "reference": 0.0,
                "p_value": change.p_value,
                "adjustment": "whole-draw permutation; max over dates and numbers",
                "permutations": change.permutations,
                "seed": change.seed,
                "null_q95": float(np.quantile(change.null_distribution, 0.95)),
                "null_q99": float(np.quantile(change.null_distribution, 0.99)),
                "detail": (
                    f"{period_draws[before_index].issue}/"
                    f"{period_draws[after_index].issue}; number={change.feature_number}"
                ),
            }
        )

    def append_era_row(
        *,
        group_type: str,
        group_label: str,
        zone: str,
        group_draws: Sequence[Draw],
        spec: GameSpec,
        seed: int,
    ) -> None:
        if len(group_draws) < 30:
            return
        pool_size = spec.front_pool if zone == "front" else spec.back_pool
        pick_count = spec.front_pick if zone == "front" else spec.back_pick
        matrix = build_binary_matrix(group_draws, zone, pool_size)
        diagnostics = {
            str(row["metric"]): row
            for row in randomness_diagnostics(matrix, pool_size, pick_count)
        }
        marginal = diagnostics["marginal_uniformity_covariance_chi_square"]
        max_z = diagnostics["max_abs_count_z"]
        order = order_statistic_q_audit(
            matrix,
            permutations=era_permutations,
            seed=seed,
            batch_size=audit_batch_size,
        )
        number_values = np.arange(1, pool_size + 1, dtype=float)
        era_audit_rows.append(
            {
                "lottery_code": "dlt",
                "lottery_name": spec.name,
                "zone": zone,
                "group_type": group_type,
                "group_label": group_label,
                "draw_count": len(group_draws),
                "start_date": group_draws[0].draw_date.isoformat(),
                "end_date": group_draws[-1].draw_date.isoformat(),
                "marginal_chi_square": float(marginal["value"]),
                "marginal_df": pool_size - 1,
                "marginal_p_approx": float(marginal["p_value_approx"]),
                "max_abs_count_z": float(max_z["value"]),
                "order_q": order.q_statistic,
                "order_p_monte_carlo": order.p_value,
                "mean_number_sum": float((matrix * number_values).sum(axis=1).mean()),
                "order_sample_means": " ".join(
                    f"{value:.6f}" for value in order.sample_means
                ),
                "order_theoretical_means": " ".join(
                    f"{value:.6f}" for value in order.theoretical_means
                ),
                "permutations": era_permutations,
                "seed": seed,
            }
        )

    for code, draws in all_draws.items():
        spec = GAME_SPECS[code]
        source_draws = raw_draws[code]
        validation_start = int(len(draws) * validation_start_ratio)
        test_start = int(len(draws) * test_start_ratio)
        validation_indices = np.arange(validation_start, test_start)
        test_indices = np.arange(test_start, len(draws))
        split_manifest[code] = {
            "raw_draw_count": len(source_draws),
            "model_draw_count": len(draws),
            "excluded_pre_model_count": len(source_draws) - len(draws),
            "model_start_date": (
                effective_start_dates[code].isoformat()
                if effective_start_dates[code]
                else None
            ),
            "model_start_issue": draws[0].issue,
            "validation_start_index": validation_start,
            "validation_start_date": draws[validation_start].draw_date.isoformat(),
            "test_start_index": test_start,
            "test_start_date": draws[test_start].draw_date.isoformat(),
            "test_end_date": draws[-1].draw_date.isoformat(),
            "test_draw_count": len(test_indices),
        }

        for zone, pool_size, pick_count in (
            ("front", spec.front_pool, spec.front_pick),
            ("back", spec.back_pool, spec.back_pick),
        ):
            primary_periods: list[tuple[str, Sequence[Draw]]] = []
            if effective_start_dates[code] is None:
                primary_periods.append(("full_history_model_window", source_draws))
            else:
                cutoff = effective_start_dates[code]
                primary_periods.extend(
                    [
                        ("full_history", source_draws),
                        (
                            "pre_model_window",
                            [draw for draw in source_draws if draw.draw_date < cutoff],
                        ),
                        ("model_window", draws),
                    ]
                )
            for period_index, (period_name, period_draws) in enumerate(primary_periods):
                if len(period_draws) < 30:
                    continue
                period_matrix = build_binary_matrix(period_draws, zone, pool_size)
                append_primary_audit(
                    code=code,
                    spec=spec,
                    zone=zone,
                    period_name=period_name,
                    period_draws=period_draws,
                    matrix=period_matrix,
                    seed=int(
                        stable_unit("p0", code, zone, period_name, period_index)
                        * (2**32 - 1)
                    ),
                )

            actual = build_binary_matrix(draws, zone, pool_size)
            p1_selection = select_p1_hyperparameters(
                actual,
                pick_count,
                validation_start,
                max_inner_folds=p1_max_inner_folds,
            )
            selection_key = f"{code}_{zone}"
            p1_selection_manifest[selection_key] = p1_selection.manifest_dict()
            for row in p1_selection.audit_rows:
                p1_hyperparameter_rows.append(
                    {
                        "lottery_code": code,
                        "lottery_name": spec.name,
                        "zone": zone,
                        **row,
                    }
                )
            _, predictions = generate_base_predictions(
                draws,
                spec,
                zone,
                lunar_dates,
                hour_branch=hour_branch,
                model_parameters=p1_selection.parameters,
            )
            ga_seed = int(stable_unit("ga", code, zone) * (2**32 - 1))
            base_names, weights, validation_fitness = optimize_ga_weights(
                predictions,
                actual,
                validation_indices,
                pick_count,
                seed=ga_seed,
                population_size=ga_population,
                generations=ga_generations,
            )
            add_ga_prediction(predictions, base_names, weights)
            ga_weights[f"{code}_{zone}"] = {
                "validation_fitness": validation_fitness,
                "model_parameters": p1_selection.parameters,
                "weights": {
                    name: float(weight)
                    for name, weight in zip(base_names, weights, strict=True)
                },
            }

            test_actual = actual[test_indices]
            diagnostic_periods = {
                "model_window_full": np.arange(0, len(draws)),
                "history_60pct": np.arange(0, validation_start),
                "ga_validation_20pct": validation_indices,
                "final_holdout_20pct": test_indices,
            }
            for period_name, period_indices in diagnostic_periods.items():
                diagnostics = randomness_diagnostics(
                    actual[period_indices], pool_size, pick_count
                )
                for row in diagnostics:
                    diagnostics_rows.append(
                        {
                            "lottery_code": code,
                            "lottery_name": spec.name,
                            "zone": zone,
                            "period": period_name,
                            "period_draws": len(period_indices),
                            "period_start_date": draws[int(period_indices[0])].draw_date.isoformat(),
                            "period_end_date": draws[int(period_indices[-1])].draw_date.isoformat(),
                            **row,
                        }
                    )

            zone_metric_rows = []
            zone_bootstrap_rows: list[dict[str, object]] = []
            uniform_test_probabilities = predictions["uniform_random"][
                "probabilities"
            ][test_indices]
            for model_name, values in predictions.items():
                test_probabilities = values["probabilities"][test_indices]
                metrics, selected, actual_numbers = evaluate_model(
                    model_name,
                    values["scores"][test_indices],
                    test_probabilities,
                    test_actual,
                    pool_size,
                    pick_count,
                )
                metrics_row = {
                    "lottery_code": code,
                    "lottery_name": spec.name,
                    "zone": zone,
                    "test_start_date": draws[test_start].draw_date.isoformat(),
                    "test_end_date": draws[-1].draw_date.isoformat(),
                    **metrics,
                }
                zone_metric_rows.append(metrics_row)

                bootstrap = moving_block_bootstrap_brier_difference(
                    test_probabilities,
                    uniform_test_probabilities,
                    test_actual,
                    replicates=p1_bootstrap_repetitions,
                    seed=int(
                        stable_unit("p1-bootstrap", code, zone, model_name)
                        * (2**32 - 1)
                    ),
                )
                zone_bootstrap_rows.append(
                    {
                        "lottery_code": code,
                        "lottery_name": spec.name,
                        "zone": zone,
                        "model": model_name,
                        "reference_model": "uniform_random",
                        **bootstrap.to_dict(),
                    }
                )

                calibration = calibration_bins(
                    test_probabilities,
                    test_actual,
                    bin_count=p1_calibration_bins,
                )
                for calibration_bin in calibration.bins:
                    calibration_rows.append(
                        {
                            "lottery_code": code,
                            "lottery_name": spec.name,
                            "zone": zone,
                            "model": model_name,
                            "test_draws": len(test_indices),
                            "expected_calibration_error": calibration.expected_calibration_error,
                            "maximum_calibration_error": calibration.maximum_calibration_error,
                            **calibration_bin.to_dict(),
                        }
                    )

                decomposition = brier_decomposition(
                    test_probabilities,
                    test_actual,
                    bin_count=p1_calibration_bins,
                )
                brier_decomposition_rows.append(
                    {
                        "lottery_code": code,
                        "lottery_name": spec.name,
                        "zone": zone,
                        "model": model_name,
                        "test_draws": len(test_indices),
                        **{
                            key: value
                            for key, value in decomposition.to_dict().items()
                            if key != "calibration"
                        },
                    }
                )
                for local_index, draw_index in enumerate(test_indices):
                    prediction_rows.append(
                        {
                            "lottery_code": code,
                            "lottery_name": spec.name,
                            "zone": zone,
                            "issue": draws[draw_index].issue,
                            "draw_date": draws[draw_index].draw_date.isoformat(),
                            "model": model_name,
                            "predicted_numbers": " ".join(
                                f"{number:02d}" for number in selected[local_index]
                            ),
                            "actual_numbers": " ".join(
                                f"{number:02d}" for number in actual_numbers[local_index]
                            ),
                            "hits": int(
                                len(
                                    set(selected[local_index])
                                    & set(actual_numbers[local_index])
                                )
                            ),
                        }
                    )
            model_count = len(zone_metric_rows)
            for row in zone_bootstrap_rows:
                row["p_value_bonferroni_within_zone"] = min(
                    1.0,
                    float(row["p_value_two_sided"]) * model_count,
                )
                bootstrap_rows.append(row)
            for row in zone_metric_rows:
                row["p_value_bonferroni"] = min(
                    1.0, float(row["p_value_two_sided"]) * model_count
                )
                metrics_rows.append(row)
                if code == "dlt":
                    cutoff_comparison_rows.append(
                        {
                            "lottery_code": code,
                            "lottery_name": spec.name,
                            "zone": zone,
                            "history_variant": "model_window_2014plus",
                            "model_start_date": draws[0].draw_date.isoformat(),
                            "validation_start_date": draws[validation_start].draw_date.isoformat(),
                            "test_start_date": draws[test_start].draw_date.isoformat(),
                            "test_end_date": draws[-1].draw_date.isoformat(),
                            **{
                                key: value
                                for key, value in row.items()
                                if key
                                not in {
                                    "lottery_code",
                                    "lottery_name",
                                    "zone",
                                    "test_start_date",
                                    "test_end_date",
                                }
                            },
                        }
                    )

            if pipeline_null_repetitions:
                null_spec = FairHistorySpec(
                    pool_size=pool_size,
                    pick_count=pick_count,
                    draw_count=len(draws),
                    validation_start_index=validation_start,
                    holdout_start_index=test_start,
                    label=f"{code}_{zone}",
                )
                cache = build_fixed_prediction_cache(
                    draws,
                    spec,
                    zone,
                    lunar_dates,
                    hour_branch=hour_branch,
                )
                evaluator = LotteryPipelineEvaluator(
                    cache=cache,
                    ga_population=ga_population,
                    ga_generations=ga_generations,
                    ga_seed=ga_seed,
                    p1_max_inner_folds=p1_max_inner_folds,
                )
                observed = evaluate_pipeline_history(
                    actual,
                    null_spec,
                    evaluator,
                    evaluator_seed=ga_seed,
                    minimum_candidate_count=len(MODEL_GROUPS),
                )
                report = run_pipeline_null(
                    null_spec,
                    evaluator,
                    repetitions=pipeline_null_repetitions,
                    seed=int(
                        stable_unit("pipeline-null", code, zone) * (2**32 - 1)
                    ),
                    observed_statistics=observed,
                    workers=pipeline_null_workers,
                    backend=pipeline_null_backend,
                    batch_size=min(25, pipeline_null_repetitions),
                    minimum_candidate_count=len(MODEL_GROUPS),
                )
                ga_key = f"{code}_{zone}"
                pipeline_reports[ga_key] = report.to_dict()
                for statistic_name, summary in report.summaries.items():
                    pipeline_summary_rows.append(
                        {
                            "lottery_code": code,
                            "lottery_name": spec.name,
                            "zone": zone,
                            "statistic": statistic_name,
                            "observed": summary.observed,
                            "null_mean": summary.mean,
                            "null_std": summary.standard_deviation,
                            "null_min": summary.minimum,
                            "null_q50": summary.quantiles.get("0.5"),
                            "null_q90": summary.quantiles.get("0.9"),
                            "null_q95": summary.quantiles.get("0.95"),
                            "null_q99": summary.quantiles.get("0.99"),
                            "null_max": summary.maximum,
                            "empirical_p_value": summary.empirical_p_value,
                            "repetitions": report.repetitions,
                            "selected_candidate_counts": json.dumps(
                                report.selected_candidate_counts,
                                ensure_ascii=False,
                                sort_keys=True,
                            ),
                        }
                    )
                    for replicate_index, value in enumerate(
                        report.null_distributions[statistic_name]
                    ):
                        pipeline_replicate_rows.append(
                            {
                                "lottery_code": code,
                                "lottery_name": spec.name,
                                "zone": zone,
                                "replicate": replicate_index,
                                "statistic": statistic_name,
                                "value": float(value),
                            }
                        )

        if code == "dlt":
            for zone in ("front", "back"):
                groups: list[tuple[str, str, Sequence[Draw]]] = [
                    (
                        "calendar_regime",
                        "pre_2014",
                        [
                            draw
                            for draw in source_draws
                            if draw.draw_date < date(2014, 1, 1)
                        ],
                    ),
                    (
                        "calendar_regime",
                        "2014_and_later",
                        [
                            draw
                            for draw in source_draws
                            if draw.draw_date >= date(2014, 1, 1)
                        ],
                    ),
                    (
                        "statistical_regime",
                        "transition_2013_h2",
                        [
                            draw
                            for draw in source_draws
                            if date(2013, 7, 1)
                            <= draw.draw_date
                            < date(2014, 1, 1)
                        ],
                    ),
                ]
                for year in sorted({draw.draw_date.year for draw in source_draws}):
                    groups.append(
                        (
                            "calendar_year",
                            str(year),
                            [
                                draw
                                for draw in source_draws
                                if draw.draw_date.year == year
                            ],
                        )
                    )
                if equipment_by_issue:
                    for regime_label, predicate in (
                        ("pre_2014", lambda item: item.draw_date < date(2014, 1, 1)),
                        ("2014_and_later", lambda item: item.draw_date >= date(2014, 1, 1)),
                    ):
                        for equipment_set in (0, 1, 2, 3):
                            equipment_label = (
                                "metadata_unavailable"
                                if equipment_set == 0
                                else f"reported_set_{equipment_set}"
                            )
                            groups.append(
                                (
                                    "official_list_equipment_set",
                                    f"{regime_label}_{equipment_label}",
                                    [
                                        draw
                                        for draw in source_draws
                                        if predicate(draw)
                                        and equipment_by_issue.get(draw.issue, 0)
                                        == equipment_set
                                    ],
                                )
                            )
                for group_index, (group_type, group_label, group_draws) in enumerate(groups):
                    append_era_row(
                        group_type=group_type,
                        group_label=group_label,
                        zone=zone,
                        group_draws=group_draws,
                        spec=spec,
                        seed=int(
                            stable_unit(
                                "era", zone, group_type, group_label, group_index
                            )
                            * (2**32 - 1)
                        ),
                    )

            cutoff = date(2014, 1, 1)
            model_validation_date = draws[int(len(draws) * validation_start_ratio)].draw_date
            model_test_date = draws[int(len(draws) * test_start_ratio)].draw_date
            raw_validation_indices = np.asarray(
                [
                    index
                    for index, draw in enumerate(source_draws)
                    if model_validation_date <= draw.draw_date < model_test_date
                ],
                dtype=int,
            )
            raw_test_indices = np.asarray(
                [
                    index
                    for index, draw in enumerate(source_draws)
                    if draw.draw_date >= model_test_date
                ],
                dtype=int,
            )
            for zone, pool_size, pick_count in (
                ("front", spec.front_pool, spec.front_pick),
                ("back", spec.back_pool, spec.back_pick),
            ):
                raw_actual = build_binary_matrix(
                    source_draws,
                    zone,
                    pool_size,
                )
                raw_p1_selection = select_p1_hyperparameters(
                    raw_actual,
                    pick_count,
                    int(raw_validation_indices[0]),
                    max_inner_folds=p1_max_inner_folds,
                )
                _, raw_predictions = generate_base_predictions(
                    source_draws,
                    spec,
                    zone,
                    lunar_dates,
                    hour_branch=hour_branch,
                    model_parameters=raw_p1_selection.parameters,
                )
                raw_base_names, raw_weights, _ = optimize_ga_weights(
                    raw_predictions,
                    raw_actual,
                    raw_validation_indices,
                    pick_count,
                    seed=int(stable_unit("ga", code, zone) * (2**32 - 1)),
                    population_size=ga_population,
                    generations=ga_generations,
                )
                add_ga_prediction(raw_predictions, raw_base_names, raw_weights)
                for model_name, values in raw_predictions.items():
                    metrics, _, _ = evaluate_model(
                        model_name,
                        values["scores"][raw_test_indices],
                        values["probabilities"][raw_test_indices],
                        raw_actual[raw_test_indices],
                        pool_size,
                        pick_count,
                    )
                    cutoff_comparison_rows.append(
                        {
                            "lottery_code": code,
                            "lottery_name": spec.name,
                            "zone": zone,
                            "history_variant": "full_history_2007plus",
                            "model_start_date": source_draws[0].draw_date.isoformat(),
                            "validation_start_date": model_validation_date.isoformat(),
                            "test_start_date": model_test_date.isoformat(),
                            "test_end_date": source_draws[-1].draw_date.isoformat(),
                            **metrics,
                        }
                    )

            pre_draws = [draw for draw in source_draws if draw.draw_date < cutoff]
            post_draws = [draw for draw in source_draws if draw.draw_date >= cutoff]
            for zone, pool_size in (
                ("front", spec.front_pool),
                ("back", spec.back_pool),
            ):
                pre_matrix = build_binary_matrix(pre_draws, zone, pool_size)
                post_matrix = build_binary_matrix(post_draws, zone, pool_size)
                combined = np.vstack((pre_matrix, post_matrix))
                split = len(pre_matrix)

                def regime_shift_statistic(values: np.ndarray) -> float:
                    before = values[:split].mean(axis=0)
                    after = values[split:].mean(axis=0)
                    return float(np.sum((before - after) ** 2))

                shift = whole_draw_shuffle_test(
                    combined,
                    regime_shift_statistic,
                    permutations=audit_permutations,
                    seed=int(
                        stable_unit("dlt-regime-shift", zone) * (2**32 - 1)
                    ),
                    alternative="greater",
                )
                p0_summary_rows.append(
                    {
                        "lottery_code": code,
                        "lottery_name": spec.name,
                        "zone": zone,
                        "period": "pre_2014_vs_2014plus",
                        "period_draws": len(combined),
                        "period_start_date": source_draws[0].draw_date.isoformat(),
                        "period_end_date": source_draws[-1].draw_date.isoformat(),
                        "test": "whole_draw_regime_distribution_shift",
                        "statistic": shift.observed_statistic,
                        "reference": 0.0,
                        "p_value": shift.p_value,
                        "adjustment": "whole-draw permutation across fixed-size regimes",
                        "permutations": shift.permutations,
                        "seed": shift.seed,
                        "null_q95": float(np.quantile(shift.null_distribution, 0.95)),
                        "null_q99": float(np.quantile(shift.null_distribution, 0.99)),
                        "detail": f"pre={len(pre_matrix)}; post={len(post_matrix)}",
                    }
                )

    for row in pipeline_summary_rows:
        row.update(
            {
                "familywise_empirical_p_value": None,
                "familywise_zone_count": None,
                "global_observed_max": None,
                "global_null_q95": None,
                "global_empirical_p_value": None,
            }
        )
    for statistic_name in sorted(
        {
            str(row["statistic"])
            for row in pipeline_summary_rows
            if str(row["statistic"]).endswith("_brier_skill")
        }
    ):
        family_rows = [
            row
            for row in pipeline_summary_rows
            if row["statistic"] == statistic_name
        ]
        family_nulls = [
            pipeline_reports[f"{row['lottery_code']}_{row['zone']}"][
                "null_distributions"
            ][statistic_name]
            for row in family_rows
        ]
        observed_values = [float(row["observed"]) for row in family_rows]
        adjusted_p, global_p, global_null = familywise_max_t_p_values(
            observed_values,
            family_nulls,
        )
        global_observed = max(observed_values)
        global_q95 = float(np.quantile(global_null, 0.95))
        for row, p_value in zip(family_rows, adjusted_p, strict=True):
            row.update(
                {
                    "familywise_empirical_p_value": float(p_value),
                    "familywise_zone_count": len(family_rows),
                    "global_observed_max": global_observed,
                    "global_null_q95": global_q95,
                    "global_empirical_p_value": global_p,
                }
            )

    final_input_snapshot = {
        name: input_signature(path) for name, path in tracked_input_paths.items()
    }
    if final_input_snapshot != input_snapshot:
        raise RuntimeError(
            "输入数据在训练期间发生变化，已拒绝发布可能失配的结果"
        )

    write_csv(output_dir / "model_metrics.csv", metrics_rows)
    write_csv(output_dir / "holdout_predictions.csv", prediction_rows)
    write_csv(output_dir / "randomness_diagnostics.csv", diagnostics_rows)
    write_csv(output_dir / "p0_audit_summary.csv", p0_summary_rows)
    write_csv(output_dir / "pair_cooccurrence_audit.csv", pair_audit_rows)
    write_csv(output_dir / "order_statistic_audit.csv", order_audit_rows)
    write_csv(output_dir / "change_point_audit.csv", change_point_rows)
    write_csv(output_dir / "dlt_era_audit.csv", era_audit_rows)
    write_csv(output_dir / "cutoff_comparison.csv", cutoff_comparison_rows)
    write_csv(
        output_dir / "p1_hyperparameter_selection.csv",
        p1_hyperparameter_rows,
    )
    write_csv(output_dir / "moving_block_bootstrap.csv", bootstrap_rows)
    write_csv(output_dir / "calibration_audit.csv", calibration_rows)
    write_csv(
        output_dir / "brier_decomposition.csv",
        brier_decomposition_rows,
    )
    if pipeline_summary_rows:
        write_csv(output_dir / "pipeline_null_summary.csv", pipeline_summary_rows)
        write_csv(output_dir / "pipeline_null_replicates.csv", pipeline_replicate_rows)
        temporary_pipeline = output_dir / "pipeline_null_report.json.tmp"
        temporary_pipeline.write_text(
            json.dumps(pipeline_reports, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary_pipeline.replace(output_dir / "pipeline_null_report.json")
    (output_dir / "ga_weights.json").write_text(
        json.dumps(ga_weights, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    lab_root = Path(__file__).resolve().parents[1]
    training_code_paths = {
        "run_experiments.py": lab_root / "run_experiments.py",
        "src/lottery_lab.py": Path(__file__).resolve(),
        "src/model_selection.py": lab_root / "src" / "model_selection.py",
        "src/p1_analysis.py": lab_root / "src" / "p1_analysis.py",
        "src/null_audit.py": lab_root / "src" / "null_audit.py",
        "src/p0_reporting.py": lab_root / "src" / "p0_reporting.py",
        "src/pipeline_adapter.py": lab_root / "src" / "pipeline_adapter.py",
        "src/pipeline_null.py": lab_root / "src" / "pipeline_null.py",
        "scripts/chinese_calendar.swift": swift_helper,
    }
    manifest = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "calendar_source": calendar_source,
        "traditional_model_hour_branch": hour_branch,
        "split_policy": {
            "history_and_feature_formation": f"0% to {validation_start_ratio:.0%}",
            "ga_validation_only": f"{validation_start_ratio:.0%} to {test_start_ratio:.0%}",
            "final_holdout": f"{test_start_ratio:.0%} to 100%",
            "walk_forward_rule": "each prediction uses only draws strictly earlier than the target draw",
            "model_start_dates": {
                code: value.isoformat() if value else None
                for code, value in effective_start_dates.items()
            },
            "pre_cutoff_policy": "retained for audit; excluded from model calculations",
        },
        "splits": split_manifest,
        "ga": {
            "population": ga_population,
            "generations": ga_generations,
            "constraints": "non-negative weights summing to one",
        },
        "p0_audit": {
            "whole_draw_shuffle_permutations": audit_permutations,
            "pair_max_t_simulations": audit_permutations,
            "order_statistic_simulations": audit_permutations,
            "change_point_permutations": audit_permutations,
            "era_order_statistic_simulations": era_permutations,
            "pipeline_null_repetitions": pipeline_null_repetitions,
            "pipeline_null_backend": pipeline_null_backend,
            "pipeline_null_workers": pipeline_null_workers,
            "pipeline_scope": "all base candidates plus GA re-fitted in every fair history",
            "pipeline_ga_seed_policy": "fixed pre-registered seed per lottery and zone",
            "pipeline_familywise_policy": "Monte Carlo max-T across four lottery-zone results for Brier-skill statistics",
        },
        "p1": {
            "conditional_probability_model": "fixed-size conditional Bernoulli / maximum-entropy set distribution",
            "combination_nll_parameterization": "log odds of projected inclusion probabilities",
            "hyperparameter_selection": "nested chronological rolling Brier selection wholly inside the first 60% formation region",
            "parameter_grids": P1_PARAMETER_GRIDS,
            "selections": p1_selection_manifest,
            "moving_block_bootstrap_repetitions": p1_bootstrap_repetitions,
            "moving_block_length_policy": "round(test_draws ** (1/3))",
            "calibration_bin_count": p1_calibration_bins,
            "pipeline_null_policy": "re-run P1 nested selection inside every complete fair-history replicate",
        },
        "models": MODEL_DESCRIPTIONS,
        "data_files": {
            code: {
                "path": f"model_data/{path.name}",
                "sha256": input_snapshot[f"data:{code}"]["sha256"],
            }
            for code, path in data_paths.items()
        },
        "calendar_file": (
            {
                "path": "model_data/lunar_calendar.csv",
                "sha256": input_snapshot["lunar_calendar"]["sha256"],
            }
            if lunar_calendar_path
            and input_snapshot.get("lunar_calendar", {}).get("exists")
            else None
        ),
        "code_files": {
            name: {
                "path": name,
                "sha256": sha256_file(path),
            }
            for name, path in training_code_paths.items()
        },
        "manual_entries_file": (
            {
                "path": "data/manual_entries.csv",
                "sha256": input_snapshot["manual_entries"]["sha256"],
            }
            if manual_entries_path
            and input_snapshot.get("manual_entries", {}).get("exists")
            else None
        ),
        "synced_entries_file": (
            {
                "path": "data/synced_entries.csv",
                "sha256": input_snapshot["synced_entries"]["sha256"],
            }
            if synced_entries_path
            and input_snapshot.get("synced_entries", {}).get("exists")
            else None
        ),
        "dlt_source_crosscheck": (
            json.loads(source_crosscheck_json.read_text(encoding="utf-8"))
            if source_crosscheck_json.exists()
            else None
        ),
        "result_files": {},
    }
    result_names = [
        "model_metrics.csv",
        "holdout_predictions.csv",
        "randomness_diagnostics.csv",
        "p0_audit_summary.csv",
        "pair_cooccurrence_audit.csv",
        "order_statistic_audit.csv",
        "change_point_audit.csv",
        "dlt_era_audit.csv",
        "cutoff_comparison.csv",
        "p1_hyperparameter_selection.csv",
        "moving_block_bootstrap.csv",
        "calibration_audit.csv",
        "brier_decomposition.csv",
        "ga_weights.json",
    ]
    if pipeline_summary_rows:
        result_names.extend(
            [
                "pipeline_null_summary.csv",
                "pipeline_null_replicates.csv",
                "pipeline_null_report.json",
            ]
        )
    for optional_name in (
        "dlt_source_crosscheck.csv",
        "dlt_source_crosscheck.json",
    ):
        if (output_dir / optional_name).exists():
            result_names.append(optional_name)
    for name in result_names:
        path = output_dir / name
        manifest["result_files"][name] = {
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
        }
    (output_dir / "experiment_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest
