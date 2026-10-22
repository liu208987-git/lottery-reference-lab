"""Null-model audits for fixed-size lottery draws.

The functions in this module deliberately operate only on the matrix supplied by
the caller.  They do not load data, infer future observations, or mutate the
main experiment pipeline.  A draw matrix has shape ``(draw_count, pool_size)``
and contains exactly ``pick_count`` ones in every row.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np


Alternative = Literal["greater", "less", "two-sided"]


def _positive_integer(name: str, value: object, *, minimum: int = 1) -> int:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, np.integer)):
        raise ValueError(f"{name} must be an integer")
    parsed = int(value)
    if parsed < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return parsed


def _seed_value(seed: object) -> int:
    parsed = _positive_integer("seed", seed, minimum=0)
    return parsed


def _probability(name: str, value: object) -> float:
    if isinstance(value, (bool, np.bool_)):
        raise ValueError(f"{name} must be a number in (0, 1]")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a number in (0, 1]") from exc
    if not math.isfinite(parsed) or not 0.0 < parsed <= 1.0:
        raise ValueError(f"{name} must be a number in (0, 1]")
    return parsed


def _validate_binary_draw_matrix(
    matrix: object,
    *,
    pool_size: int | None = None,
    pick_count: int | None = None,
) -> tuple[np.ndarray, int, int]:
    try:
        values = np.asarray(matrix, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise ValueError("matrix must be a numeric two-dimensional array") from exc
    if values.ndim != 2:
        raise ValueError("matrix must be two-dimensional")
    if values.shape[0] == 0 or values.shape[1] < 2:
        raise ValueError("matrix must contain at least one draw and two pool entries")
    if not np.all(np.isfinite(values)):
        raise ValueError("matrix must contain only finite values")
    if not np.all((values == 0.0) | (values == 1.0)):
        raise ValueError("matrix must be binary")

    row_sums = values.sum(axis=1)
    if not np.all(row_sums == row_sums[0]):
        raise ValueError("every draw must contain the same number of selections")
    inferred_pool_size = int(values.shape[1])
    inferred_pick_count = int(row_sums[0])
    if not 1 <= inferred_pick_count < inferred_pool_size:
        raise ValueError("pick_count must be between 1 and pool_size - 1")

    if pool_size is not None:
        expected_pool_size = _positive_integer("pool_size", pool_size, minimum=2)
        if expected_pool_size != inferred_pool_size:
            raise ValueError(
                f"pool_size={expected_pool_size} does not match matrix width "
                f"{inferred_pool_size}"
            )
    if pick_count is not None:
        expected_pick_count = _positive_integer("pick_count", pick_count)
        if expected_pick_count != inferred_pick_count:
            raise ValueError(
                f"pick_count={expected_pick_count} does not match row sum "
                f"{inferred_pick_count}"
            )
    return values, inferred_pool_size, inferred_pick_count


def _sample_binary_draws(
    rng: np.random.Generator,
    batch_count: int,
    draw_count: int,
    pool_size: int,
    pick_count: int,
) -> np.ndarray:
    """Sample complete k/N draws uniformly without replacement."""

    priorities = rng.random((batch_count, draw_count, pool_size))
    selected = np.argpartition(priorities, kth=pick_count - 1, axis=2)[
        :, :, :pick_count
    ]
    draws = np.zeros((batch_count, draw_count, pool_size), dtype=np.float64)
    np.put_along_axis(draws, selected, 1.0, axis=2)
    return draws


def _evaluate_statistic(
    statistic: Callable[[np.ndarray], float], matrix: np.ndarray
) -> float:
    if not callable(statistic):
        raise ValueError("statistic must be callable")
    try:
        value = float(statistic(matrix))
    except (TypeError, ValueError) as exc:
        raise ValueError("statistic must return one finite scalar") from exc
    if not math.isfinite(value):
        raise ValueError("statistic must return one finite scalar")
    return value


@dataclass(frozen=True)
class PermutationTestResult:
    observed_statistic: float
    p_value: float
    alternative: Alternative
    permutations: int
    seed: int
    null_distribution: np.ndarray

    @property
    def statistic(self) -> float:
        return self.observed_statistic

    def to_dict(self) -> dict[str, Any]:
        return {
            "observed_statistic": self.observed_statistic,
            "p_value": self.p_value,
            "alternative": self.alternative,
            "permutations": self.permutations,
            "seed": self.seed,
            "null_distribution": self.null_distribution.tolist(),
        }


def shuffle_whole_draws(
    matrix: object, *, rng: np.random.Generator
) -> np.ndarray:
    """Shuffle complete draw rows while preserving every within-draw combination."""

    values, _, _ = _validate_binary_draw_matrix(matrix)
    if not isinstance(rng, np.random.Generator):
        raise ValueError("rng must be a numpy.random.Generator")
    return values[rng.permutation(values.shape[0])].copy()


def whole_draw_shuffle_test(
    matrix: object,
    statistic: Callable[[np.ndarray], float],
    *,
    permutations: int = 999,
    seed: int = 0,
    alternative: Alternative = "greater",
) -> PermutationTestResult:
    """Run a row-permutation test that destroys order but not draw structure."""

    values, _, _ = _validate_binary_draw_matrix(matrix)
    permutation_count = _positive_integer("permutations", permutations)
    random_seed = _seed_value(seed)
    if alternative not in {"greater", "less", "two-sided"}:
        raise ValueError("alternative must be 'greater', 'less', or 'two-sided'")

    observed = _evaluate_statistic(statistic, values)
    rng = np.random.default_rng(random_seed)
    null_distribution = np.empty(permutation_count, dtype=np.float64)
    for index in range(permutation_count):
        shuffled = values[rng.permutation(values.shape[0])]
        null_distribution[index] = _evaluate_statistic(statistic, shuffled)

    denominator = permutation_count + 1.0
    greater_p = (
        1.0 + float(np.count_nonzero(null_distribution >= observed))
    ) / denominator
    less_p = (
        1.0 + float(np.count_nonzero(null_distribution <= observed))
    ) / denominator
    if alternative == "greater":
        p_value = greater_p
    elif alternative == "less":
        p_value = less_p
    else:
        p_value = min(1.0, 2.0 * min(greater_p, less_p))

    return PermutationTestResult(
        observed_statistic=observed,
        p_value=p_value,
        alternative=alternative,
        permutations=permutation_count,
        seed=random_seed,
        null_distribution=null_distribution,
    )


def benjamini_hochberg(
    p_values: object, *, alpha: float = 0.05
) -> tuple[np.ndarray, np.ndarray]:
    """Return Benjamini-Hochberg adjusted q-values and rejection flags."""

    threshold = _probability("alpha", alpha)
    try:
        values = np.asarray(p_values, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise ValueError("p_values must be a one-dimensional numeric array") from exc
    if values.ndim != 1:
        raise ValueError("p_values must be one-dimensional")
    if not np.all(np.isfinite(values)) or np.any((values < 0.0) | (values > 1.0)):
        raise ValueError("p_values must contain finite values in [0, 1]")
    if values.size == 0:
        return np.empty(0, dtype=np.float64), np.empty(0, dtype=bool)

    order = np.argsort(values, kind="stable")
    ordered = values[order]
    ranks = np.arange(1, values.size + 1, dtype=np.float64)
    ordered_q = ordered * values.size / ranks
    ordered_q = np.minimum.accumulate(ordered_q[::-1])[::-1]
    ordered_q = np.clip(ordered_q, 0.0, 1.0)
    q_values = np.empty_like(ordered_q)
    q_values[order] = ordered_q
    return q_values, q_values <= threshold


@dataclass(frozen=True)
class PairCooccurrenceAuditResult:
    draw_count: int
    pool_size: int
    pick_count: int
    pairs: np.ndarray
    observed_counts: np.ndarray
    expected_count: float
    standard_deviation: float
    z_scores: np.ndarray
    raw_p_values: np.ndarray
    bh_q_values: np.ndarray
    bh_rejected: np.ndarray
    max_t_p_values: np.ndarray
    max_t_rejected: np.ndarray
    fdr_alpha: float
    permutations: int
    seed: int
    null_max_statistics: np.ndarray

    @property
    def pair_indices(self) -> np.ndarray:
        return self.pairs

    @property
    def expected_counts(self) -> np.ndarray:
        return np.full(self.observed_counts.shape, self.expected_count)

    @property
    def p_values(self) -> np.ndarray:
        return self.raw_p_values

    @property
    def q_values(self) -> np.ndarray:
        return self.bh_q_values

    @property
    def fdr_rejected(self) -> np.ndarray:
        return self.bh_rejected

    @property
    def max_t_adjusted_p_values(self) -> np.ndarray:
        return self.max_t_p_values

    def to_dict(self) -> dict[str, Any]:
        return {
            "draw_count": self.draw_count,
            "pool_size": self.pool_size,
            "pick_count": self.pick_count,
            "pairs": self.pairs.tolist(),
            "observed_counts": self.observed_counts.tolist(),
            "expected_count": self.expected_count,
            "standard_deviation": self.standard_deviation,
            "z_scores": self.z_scores.tolist(),
            "raw_p_values": self.raw_p_values.tolist(),
            "bh_q_values": self.bh_q_values.tolist(),
            "bh_rejected": self.bh_rejected.tolist(),
            "max_t_p_values": self.max_t_p_values.tolist(),
            "max_t_rejected": self.max_t_rejected.tolist(),
            "fdr_alpha": self.fdr_alpha,
            "permutations": self.permutations,
            "seed": self.seed,
            "null_max_statistics": self.null_max_statistics.tolist(),
        }


def pair_cooccurrence_audit(
    matrix: object,
    *,
    pool_size: int | None = None,
    pick_count: int | None = None,
    permutations: int = 999,
    seed: int = 0,
    batch_size: int = 64,
    fdr_alpha: float = 0.05,
) -> PairCooccurrenceAuditResult:
    """Audit all number pairs with normal, BH-FDR, and max-T inference."""

    values, inferred_pool, inferred_pick = _validate_binary_draw_matrix(
        matrix, pool_size=pool_size, pick_count=pick_count
    )
    permutation_count = _positive_integer("permutations", permutations)
    simulation_batch_size = _positive_integer("batch_size", batch_size)
    random_seed = _seed_value(seed)
    alpha = _probability("fdr_alpha", fdr_alpha)

    draw_count = values.shape[0]
    row_indices, column_indices = np.triu_indices(inferred_pool, k=1)
    pairs = np.column_stack((row_indices + 1, column_indices + 1))
    observed_counts = (values.T @ values)[row_indices, column_indices]
    pair_probability = (
        inferred_pick * (inferred_pick - 1)
        / (inferred_pool * (inferred_pool - 1))
    )
    expected_count = float(draw_count * pair_probability)
    variance = float(draw_count * pair_probability * (1.0 - pair_probability))
    standard_deviation = math.sqrt(max(variance, 0.0))
    if standard_deviation > 0.0:
        z_scores = (observed_counts - expected_count) / standard_deviation
    else:
        z_scores = np.zeros_like(observed_counts, dtype=np.float64)
    raw_p_values = np.asarray(
        [math.erfc(abs(float(value)) / math.sqrt(2.0)) for value in z_scores],
        dtype=np.float64,
    )
    bh_q_values, bh_rejected = benjamini_hochberg(
        raw_p_values, alpha=alpha
    )

    rng = np.random.default_rng(random_seed)
    null_max_statistics = np.empty(permutation_count, dtype=np.float64)
    completed = 0
    while completed < permutation_count:
        current_batch = min(simulation_batch_size, permutation_count - completed)
        simulated = _sample_binary_draws(
            rng,
            current_batch,
            draw_count,
            inferred_pool,
            inferred_pick,
        )
        simulated_counts = np.matmul(simulated.transpose(0, 2, 1), simulated)[
            :, row_indices, column_indices
        ]
        if standard_deviation > 0.0:
            simulated_z = (simulated_counts - expected_count) / standard_deviation
        else:
            simulated_z = np.zeros_like(simulated_counts, dtype=np.float64)
        null_max_statistics[completed : completed + current_batch] = np.max(
            np.abs(simulated_z), axis=1
        )
        completed += current_batch

    absolute_observed = np.abs(z_scores)
    exceedances = np.count_nonzero(
        null_max_statistics[:, np.newaxis] >= absolute_observed[np.newaxis, :],
        axis=0,
    )
    max_t_p_values = (1.0 + exceedances.astype(np.float64)) / (
        permutation_count + 1.0
    )
    max_t_rejected = max_t_p_values <= alpha

    return PairCooccurrenceAuditResult(
        draw_count=draw_count,
        pool_size=inferred_pool,
        pick_count=inferred_pick,
        pairs=pairs,
        observed_counts=observed_counts,
        expected_count=expected_count,
        standard_deviation=standard_deviation,
        z_scores=z_scores,
        raw_p_values=raw_p_values,
        bh_q_values=bh_q_values,
        bh_rejected=bh_rejected,
        max_t_p_values=max_t_p_values,
        max_t_rejected=max_t_rejected,
        fdr_alpha=alpha,
        permutations=permutation_count,
        seed=random_seed,
        null_max_statistics=null_max_statistics,
    )


@dataclass(frozen=True)
class OrderStatisticAuditResult:
    draw_count: int
    pool_size: int
    pick_count: int
    sample_means: np.ndarray
    theoretical_means: np.ndarray
    covariance: np.ndarray
    mean_covariance: np.ndarray
    standardized_deviations: np.ndarray
    q_statistic: float
    p_value: float
    permutations: int
    seed: int
    null_distribution: np.ndarray

    @property
    def actual_means(self) -> np.ndarray:
        return self.sample_means

    @property
    def expected_means(self) -> np.ndarray:
        return self.theoretical_means

    @property
    def statistic(self) -> float:
        return self.q_statistic

    def to_dict(self) -> dict[str, Any]:
        return {
            "draw_count": self.draw_count,
            "pool_size": self.pool_size,
            "pick_count": self.pick_count,
            "sample_means": self.sample_means.tolist(),
            "theoretical_means": self.theoretical_means.tolist(),
            "covariance": self.covariance.tolist(),
            "mean_covariance": self.mean_covariance.tolist(),
            "standardized_deviations": self.standardized_deviations.tolist(),
            "q_statistic": self.q_statistic,
            "p_value": self.p_value,
            "permutations": self.permutations,
            "seed": self.seed,
            "null_distribution": self.null_distribution.tolist(),
        }


def _order_statistic_covariance(pool_size: int, pick_count: int) -> np.ndarray:
    covariance = np.empty((pick_count, pick_count), dtype=np.float64)
    denominator = (pick_count + 1) ** 2 * (pick_count + 2)
    common = (pool_size + 1) * (pool_size - pick_count) / denominator
    for row in range(pick_count):
        for column in range(row, pick_count):
            value = (row + 1) * (pick_count - column) * common
            covariance[row, column] = value
            covariance[column, row] = value
    return covariance


def order_statistic_q_audit(
    matrix: object,
    *,
    pool_size: int | None = None,
    pick_count: int | None = None,
    permutations: int = 999,
    seed: int = 0,
    batch_size: int = 64,
) -> OrderStatisticAuditResult:
    """Audit the mean positions of the sorted k/N order statistics."""

    values, inferred_pool, inferred_pick = _validate_binary_draw_matrix(
        matrix, pool_size=pool_size, pick_count=pick_count
    )
    permutation_count = _positive_integer("permutations", permutations)
    simulation_batch_size = _positive_integer("batch_size", batch_size)
    random_seed = _seed_value(seed)
    draw_count = values.shape[0]

    selected_numbers = np.nonzero(values)[1].reshape(draw_count, inferred_pick) + 1
    sample_means = selected_numbers.mean(axis=0)
    ranks = np.arange(1, inferred_pick + 1, dtype=np.float64)
    theoretical_means = ranks * (inferred_pool + 1) / (inferred_pick + 1)
    covariance = _order_statistic_covariance(inferred_pool, inferred_pick)
    mean_covariance = covariance / draw_count
    precision = np.linalg.pinv(mean_covariance)
    delta = sample_means - theoretical_means
    q_statistic = max(0.0, float(delta @ precision @ delta))
    standard_errors = np.sqrt(np.diag(mean_covariance))
    standardized_deviations = np.divide(
        delta,
        standard_errors,
        out=np.zeros_like(delta),
        where=standard_errors > 0.0,
    )

    rng = np.random.default_rng(random_seed)
    null_distribution = np.empty(permutation_count, dtype=np.float64)
    completed = 0
    while completed < permutation_count:
        current_batch = min(simulation_batch_size, permutation_count - completed)
        priorities = rng.random((current_batch, draw_count, inferred_pool))
        simulated_numbers = (
            np.argpartition(priorities, kth=inferred_pick - 1, axis=2)[
                :, :, :inferred_pick
            ]
            + 1
        )
        simulated_numbers.sort(axis=2)
        simulated_delta = simulated_numbers.mean(axis=1) - theoretical_means
        simulated_q = np.einsum(
            "bi,ij,bj->b", simulated_delta, precision, simulated_delta
        )
        null_distribution[completed : completed + current_batch] = np.maximum(
            simulated_q, 0.0
        )
        completed += current_batch

    p_value = (
        1.0 + float(np.count_nonzero(null_distribution >= q_statistic))
    ) / (permutation_count + 1.0)
    return OrderStatisticAuditResult(
        draw_count=draw_count,
        pool_size=inferred_pool,
        pick_count=inferred_pick,
        sample_means=sample_means,
        theoretical_means=theoretical_means,
        covariance=covariance,
        mean_covariance=mean_covariance,
        standardized_deviations=standardized_deviations,
        q_statistic=q_statistic,
        p_value=p_value,
        permutations=permutation_count,
        seed=random_seed,
        null_distribution=null_distribution,
    )


def _validate_cusum_values(values: object) -> np.ndarray:
    try:
        array = np.asarray(values, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            "values must be a numeric one- or two-dimensional array"
        ) from exc
    if array.ndim == 1:
        array = array[:, np.newaxis]
    elif array.ndim != 2:
        raise ValueError("values must be one- or two-dimensional")
    if array.shape[0] == 0 or array.shape[1] == 0:
        raise ValueError("values must not be empty")
    if not np.all(np.isfinite(array)):
        raise ValueError("values must contain only finite numbers")
    return array


def _cusum_surface(
    values: np.ndarray, min_segment: int
) -> tuple[np.ndarray, np.ndarray]:
    draw_count = values.shape[0]
    split_points = np.arange(min_segment, draw_count - min_segment + 1)
    cumulative = np.cumsum(values, axis=0, dtype=np.float64)
    before = cumulative[split_points - 1] / split_points[:, np.newaxis]
    after = (cumulative[-1] - cumulative[split_points - 1]) / (
        draw_count - split_points
    )[:, np.newaxis]
    scaling = np.sqrt(split_points * (draw_count - split_points) / draw_count)
    return split_points, scaling[:, np.newaxis] * np.abs(before - after)


@dataclass(frozen=True)
class CusumChangePointResult:
    draw_count: int
    feature_count: int
    statistic: float
    change_point: int
    feature_index: int
    p_value: float
    min_segment: int
    permutations: int
    seed: int
    null_distribution: np.ndarray

    @property
    def column(self) -> int:
        return self.feature_index

    @property
    def feature_number(self) -> int:
        return self.feature_index + 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "draw_count": self.draw_count,
            "feature_count": self.feature_count,
            "statistic": self.statistic,
            "change_point": self.change_point,
            "feature_index": self.feature_index,
            "feature_number": self.feature_number,
            "p_value": self.p_value,
            "min_segment": self.min_segment,
            "permutations": self.permutations,
            "seed": self.seed,
            "null_distribution": self.null_distribution.tolist(),
        }


def cusum_change_point_test(
    values: object,
    *,
    permutations: int = 999,
    seed: int = 0,
    min_segment: int = 10,
) -> CusumChangePointResult:
    """Locate a mean change with max-CUSUM and whole-row permutation inference."""

    array = _validate_cusum_values(values)
    permutation_count = _positive_integer("permutations", permutations)
    random_seed = _seed_value(seed)
    minimum_segment = _positive_integer("min_segment", min_segment)
    draw_count, feature_count = array.shape
    if draw_count < 2 * minimum_segment:
        raise ValueError("values must contain at least 2 * min_segment rows")

    split_points, surface = _cusum_surface(array, minimum_segment)
    flat_index = int(np.argmax(surface))
    split_offset, feature_index = np.unravel_index(flat_index, surface.shape)
    observed = float(surface[split_offset, feature_index])
    change_point = int(split_points[split_offset])

    rng = np.random.default_rng(random_seed)
    null_distribution = np.empty(permutation_count, dtype=np.float64)
    for index in range(permutation_count):
        shuffled = array[rng.permutation(draw_count)]
        _, shuffled_surface = _cusum_surface(shuffled, minimum_segment)
        null_distribution[index] = float(np.max(shuffled_surface))
    p_value = (
        1.0 + float(np.count_nonzero(null_distribution >= observed))
    ) / (permutation_count + 1.0)

    return CusumChangePointResult(
        draw_count=draw_count,
        feature_count=feature_count,
        statistic=observed,
        change_point=change_point,
        feature_index=int(feature_index),
        p_value=p_value,
        min_segment=minimum_segment,
        permutations=permutation_count,
        seed=random_seed,
        null_distribution=null_distribution,
    )


@dataclass(frozen=True)
class AuditConfig:
    permutations: int = 999
    seed: int = 0
    batch_size: int = 64
    min_segment: int = 10
    fdr_alpha: float = 0.05

    def __post_init__(self) -> None:
        _positive_integer("permutations", self.permutations)
        _seed_value(self.seed)
        _positive_integer("batch_size", self.batch_size)
        _positive_integer("min_segment", self.min_segment)
        _probability("fdr_alpha", self.fdr_alpha)

    def to_dict(self) -> dict[str, Any]:
        return {
            "permutations": int(self.permutations),
            "seed": int(self.seed),
            "batch_size": int(self.batch_size),
            "min_segment": int(self.min_segment),
            "fdr_alpha": float(self.fdr_alpha),
        }


@dataclass(frozen=True)
class NullAuditResult:
    config: AuditConfig
    pair_cooccurrence: PairCooccurrenceAuditResult
    order_statistics: OrderStatisticAuditResult
    change_point: CusumChangePointResult

    @property
    def pair_audit(self) -> PairCooccurrenceAuditResult:
        return self.pair_cooccurrence

    @property
    def order_statistic(self) -> OrderStatisticAuditResult:
        return self.order_statistics

    @property
    def cusum(self) -> CusumChangePointResult:
        return self.change_point

    def to_dict(self) -> dict[str, Any]:
        return {
            "config": self.config.to_dict(),
            "pair_cooccurrence": self.pair_cooccurrence.to_dict(),
            "order_statistics": self.order_statistics.to_dict(),
            "change_point": self.change_point.to_dict(),
        }


def run_null_audit(
    matrix: object, *, config: AuditConfig = AuditConfig()
) -> NullAuditResult:
    """Run the complete audit suite on one already-delimited draw matrix."""

    if not isinstance(config, AuditConfig):
        raise ValueError("config must be an AuditConfig")
    values, pool_size, pick_count = _validate_binary_draw_matrix(matrix)
    pair_result = pair_cooccurrence_audit(
        values,
        pool_size=pool_size,
        pick_count=pick_count,
        permutations=config.permutations,
        seed=config.seed,
        batch_size=config.batch_size,
        fdr_alpha=config.fdr_alpha,
    )
    order_result = order_statistic_q_audit(
        values,
        pool_size=pool_size,
        pick_count=pick_count,
        permutations=config.permutations,
        seed=config.seed + 1,
        batch_size=config.batch_size,
    )
    change_result = cusum_change_point_test(
        values,
        permutations=config.permutations,
        seed=config.seed + 2,
        min_segment=config.min_segment,
    )
    return NullAuditResult(
        config=config,
        pair_cooccurrence=pair_result,
        order_statistics=order_result,
        change_point=change_result,
    )


__all__ = [
    "AuditConfig",
    "CusumChangePointResult",
    "NullAuditResult",
    "OrderStatisticAuditResult",
    "PairCooccurrenceAuditResult",
    "PermutationTestResult",
    "benjamini_hochberg",
    "cusum_change_point_test",
    "order_statistic_q_audit",
    "pair_cooccurrence_audit",
    "run_null_audit",
    "shuffle_whole_draws",
    "whole_draw_shuffle_test",
]
