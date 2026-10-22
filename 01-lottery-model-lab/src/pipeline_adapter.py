"""Fast, faithful adapter from Lottery Lab models to pipeline-null simulation.

Date/issue based scores are cached once.  Every null replicate still rebuilds
all history-dependent models and re-runs the GA on its own validation block.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

import numpy as np

from lottery_lab import (
    EPS,
    MODEL_GROUPS,
    Draw,
    GameSpec,
    LunarDate,
    _chaos_scores,
    _traditional_scores,
    add_ga_prediction,
    one_based_mod_array,
    optimize_ga_weights,
    resolve_model_parameters,
    stable_unit,
)
from model_selection import select_p1_hyperparameters
from pipeline_null import (
    CandidatePredictions,
    PipelineContext,
    PipelineEvaluation,
)


def probabilities_from_score_matrix(
    scores: np.ndarray,
    pick_count: int,
) -> np.ndarray:
    values = np.asarray(scores, dtype=float)
    if values.ndim != 2:
        raise ValueError("scores 必须是二维矩阵")
    row_count, pool_size = values.shape
    if not 0 < pick_count < pool_size:
        raise ValueError("pick_count 必须位于 1 和 pool_size - 1 之间")
    means = values.mean(axis=1, keepdims=True)
    standard_deviations = values.std(axis=1, keepdims=True)
    constant = standard_deviations[:, 0] < EPS
    safe_std = np.where(constant[:, np.newaxis], 1.0, standard_deviations)
    logits = (values - means) / safe_std

    low = np.full(row_count, -40.0)
    high = np.full(row_count, 40.0)
    for _ in range(70):
        middle = (low + high) / 2.0
        shifted = np.clip(logits + middle[:, np.newaxis], -40.0, 40.0)
        probabilities = 1.0 / (1.0 + np.exp(-shifted))
        current = probabilities.sum(axis=1)
        below = current < pick_count
        low = np.where(below, middle, low)
        high = np.where(below, high, middle)
    middle = (low + high) / 2.0
    shifted = np.clip(logits + middle[:, np.newaxis], -40.0, 40.0)
    result = 1.0 / (1.0 + np.exp(-shifted))
    if np.any(constant):
        result[constant] = pick_count / pool_size
    return result


@dataclass(frozen=True)
class FixedPredictionCache:
    pool_size: int
    pick_count: int
    tie_noise: np.ndarray
    scores: Mapping[str, np.ndarray]
    probabilities: Mapping[str, np.ndarray]

    @property
    def draw_count(self) -> int:
        return int(self.tie_noise.shape[0])


def build_fixed_prediction_cache(
    draws: Sequence[Draw],
    spec: GameSpec,
    zone: str,
    lunar_dates: Mapping[object, LunarDate],
    *,
    hour_branch: int = 12,
) -> FixedPredictionCache:
    if zone == "front":
        pool_size, pick_count = spec.front_pool, spec.front_pick
    elif zone == "back":
        pool_size, pick_count = spec.back_pool, spec.back_pick
    else:
        raise ValueError("zone 必须是 front 或 back")

    draw_count = len(draws)
    tie_noise = np.empty((draw_count, pool_size), dtype=float)
    chaos = np.empty_like(tie_noise)
    meihua = np.empty_like(tie_noise)
    xiaoliu = np.empty_like(tie_noise)
    for target_index, draw in enumerate(draws):
        tie_seed = f"{spec.code}|{zone}|{draw.issue}|{draw.draw_date.isoformat()}"
        tie_noise[target_index] = [
            stable_unit(tie_seed, number)
            for number in range(1, pool_size + 1)
        ]
        chaos[target_index] = _chaos_scores(
            pool_size,
            ("logistic", spec.code, zone, draw.issue, draw.draw_date.isoformat()),
        )
        lunar = lunar_dates[draw.draw_date]
        meihua[target_index] = _traditional_scores(
            "meihua_yishu", lunar, pool_size, tie_seed, hour_branch
        )
        xiaoliu[target_index] = _traditional_scores(
            "xiaoliu_ren", lunar, pool_size, tie_seed, hour_branch
        )

    fixed_scores = {
        "uniform_random": tie_noise.copy(),
        "chaos_logistic": chaos,
        "meihua_yishu": meihua,
        "xiaoliu_ren": xiaoliu,
    }
    fixed_probabilities = {
        "uniform_random": np.full(
            (draw_count, pool_size), pick_count / pool_size, dtype=float
        ),
        "chaos_logistic": probabilities_from_score_matrix(chaos, pick_count),
        "meihua_yishu": probabilities_from_score_matrix(meihua, pick_count),
        "xiaoliu_ren": probabilities_from_score_matrix(xiaoliu, pick_count),
    }
    return FixedPredictionCache(
        pool_size=pool_size,
        pick_count=pick_count,
        tie_noise=tie_noise,
        scores=fixed_scores,
        probabilities=fixed_probabilities,
    )


def _validate_actual(actual: np.ndarray, cache: FixedPredictionCache) -> np.ndarray:
    values = np.asarray(actual, dtype=float)
    expected_shape = (cache.draw_count, cache.pool_size)
    if values.shape != expected_shape:
        raise ValueError(f"actual 形状应为 {expected_shape}，实际为 {values.shape}")
    if not np.all((values == 0.0) | (values == 1.0)):
        raise ValueError("actual 必须是 0/1 multi-hot")
    if not np.all(values.sum(axis=1) == cache.pick_count):
        raise ValueError("actual 每期必须恰好选择 pick_count 个号码")
    return values


def generate_cached_predictions(
    actual: np.ndarray,
    cache: FixedPredictionCache,
    model_parameters: dict[str, dict[str, float | int]] | None = None,
) -> dict[str, dict[str, np.ndarray]]:
    values = _validate_actual(actual, cache)
    draw_count, pool_size = values.shape
    pick_count = cache.pick_count
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
    predictions = {
        name: {
            "scores": np.zeros((draw_count, pool_size), dtype=float),
            "probabilities": np.zeros((draw_count, pool_size), dtype=float),
        }
        for name in MODEL_GROUPS
        if name != "ga_ensemble"
    }
    for name in cache.scores:
        predictions[name]["scores"] = np.asarray(cache.scores[name]).copy()
        predictions[name]["probabilities"] = np.asarray(
            cache.probabilities[name]
        ).copy()

    cumulative = np.vstack(
        [np.zeros((1, pool_size), dtype=float), np.cumsum(values, axis=0)]
    )
    history_sizes = np.arange(draw_count, dtype=float)[:, np.newaxis]
    bayesian_all = (
        cumulative[:-1] + all_prior * p0
    ) / (history_sizes + all_prior)

    indices = np.arange(draw_count)
    recent_start = np.maximum(0, indices - recent_window)
    recent_sizes = (indices - recent_start)[:, np.newaxis]
    recent_counts = cumulative[indices] - cumulative[recent_start]
    bayesian_recent = (
        recent_counts + recent_prior * p0
    ) / (recent_sizes + recent_prior)

    decay = 0.5 ** (1.0 / exp_half_life)
    exp_counts = np.zeros((draw_count + 1, pool_size), dtype=float)
    exp_mass = np.zeros(draw_count + 1, dtype=float)
    for target_index in range(1, draw_count + 1):
        exp_counts[target_index] = (
            decay * exp_counts[target_index - 1] + values[target_index - 1]
        )
        exp_mass[target_index] = decay * exp_mass[target_index - 1] + 1.0
    exp_probability = (
        exp_counts[:-1] + exp_prior * p0
    ) / (exp_mass[:-1, np.newaxis] + exp_prior)

    short_start = np.maximum(0, indices - 30)
    long_start = np.maximum(0, indices - 200)
    short_sizes = np.maximum(1, indices - short_start)[:, np.newaxis]
    long_sizes = np.maximum(1, indices - long_start)[:, np.newaxis]
    short_frequency = (
        cumulative[indices] - cumulative[short_start]
    ) / short_sizes
    long_frequency = (
        cumulative[indices] - cumulative[long_start]
    ) / long_sizes
    hot_cold = short_frequency - long_frequency + cache.tie_noise * 1e-9

    gaps = np.zeros((draw_count, pool_size), dtype=float)
    last_seen = np.full(pool_size, -1, dtype=int)
    for target_index in range(draw_count):
        gaps[target_index] = np.where(
            last_seen >= 0,
            target_index - 1 - last_seen,
            target_index + 1,
        )
        last_seen[values[target_index] > 0.5] = target_index
    gap_scores = gaps + cache.tie_noise * 1e-6

    transition_probabilities = np.full((draw_count, pool_size), p0)
    cooccurrence_probabilities = np.full((draw_count, pool_size), p0)
    transition_counts = np.zeros((pool_size, pool_size), dtype=float)
    transition_denominators = np.zeros(pool_size, dtype=float)
    cooccurrence_counts = np.zeros((pool_size, pool_size), dtype=float)
    occurrence_counts = np.zeros(pool_size, dtype=float)
    relation_prior_strength = 24.0
    for target_index in range(draw_count):
        anchors = (
            np.flatnonzero(values[target_index - 1] > 0.5)
            if target_index > 0
            else np.asarray([], dtype=int)
        )
        if anchors.size and float(transition_denominators[anchors].sum()) > 0:
            denominator = float(transition_denominators[anchors].sum())
            transition_probabilities[target_index] = (
                transition_counts[anchors].sum(axis=0)
                + relation_prior_strength * len(anchors) * p0
            ) / (denominator + relation_prior_strength * len(anchors))
        if anchors.size and float(occurrence_counts[anchors].sum()) > 0:
            denominator = float(occurrence_counts[anchors].sum())
            cooccurrence_probabilities[target_index] = (
                cooccurrence_counts[anchors].sum(axis=0)
                + relation_prior_strength * len(anchors) * p0
            ) / (denominator + relation_prior_strength * len(anchors))

        if target_index >= 1:
            previous_indices = np.flatnonzero(values[target_index - 1] > 0.5)
            transition_counts[previous_indices] += values[target_index]
            transition_denominators[previous_indices] += 1.0
        current_indices = np.flatnonzero(values[target_index] > 0.5)
        cooccurrence_counts[np.ix_(current_indices, current_indices)] += 1.0
        occurrence_counts[current_indices] += 1.0

    direct = {
        "bayesian_all": bayesian_all,
        "bayesian_recent_120": bayesian_recent,
        "exp_decay_60": exp_probability,
        "markov_transition": transition_probabilities,
        "cooccurrence_network": cooccurrence_probabilities,
    }
    for name, probabilities in direct.items():
        predictions[name]["scores"] = probabilities + cache.tie_noise * 1e-12
        predictions[name]["probabilities"] = np.clip(
            probabilities, EPS, 1.0 - EPS
        )

    predictions["hot_cold"]["scores"] = hot_cold
    predictions["hot_cold"]["probabilities"] = probabilities_from_score_matrix(
        hot_cold, pick_count
    )
    predictions["overdue_gap"]["scores"] = gap_scores
    predictions["overdue_gap"]["probabilities"] = probabilities_from_score_matrix(
        gap_scores, pick_count
    )
    return predictions


@dataclass(frozen=True)
class LotteryPipelineEvaluator:
    cache: FixedPredictionCache
    ga_population: int = 48
    ga_generations: int = 50
    ga_seed: int | None = None
    p1_max_inner_folds: int = 5

    def __call__(
        self,
        history: np.ndarray,
        context: PipelineContext,
        rng: np.random.Generator,
    ) -> PipelineEvaluation:
        del rng
        if context.spec.pool_size != self.cache.pool_size:
            raise ValueError("pipeline spec 与 cache 的 pool_size 不一致")
        if context.spec.pick_count != self.cache.pick_count:
            raise ValueError("pipeline spec 与 cache 的 pick_count 不一致")
        p1_selection = select_p1_hyperparameters(
            np.asarray(history, dtype=float),
            self.cache.pick_count,
            int(context.validation_indices[0]),
            max_inner_folds=self.p1_max_inner_folds,
        )
        predictions = generate_cached_predictions(
            history,
            self.cache,
            model_parameters=p1_selection.parameters,
        )
        ga_seed = context.evaluator_seed if self.ga_seed is None else self.ga_seed
        base_names, weights, validation_fitness = optimize_ga_weights(
            predictions,
            np.asarray(history, dtype=float),
            context.validation_indices,
            self.cache.pick_count,
            seed=ga_seed,
            population_size=self.ga_population,
            generations=self.ga_generations,
        )
        add_ga_prediction(predictions, base_names, weights)
        candidates = tuple(
            CandidatePredictions.from_full_history(
                name,
                model["probabilities"],
                context,
            )
            for name, model in predictions.items()
        )
        return PipelineEvaluation(
            candidates=candidates,
            selected_name="ga_ensemble",
            extra_statistics={"ga_validation_fitness": validation_fitness},
        )


__all__ = [
    "FixedPredictionCache",
    "LotteryPipelineEvaluator",
    "build_fixed_prediction_cache",
    "generate_cached_predictions",
    "probabilities_from_score_matrix",
]
