"""Reporting helpers for the P0 null-model audit suite."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from null_audit import (
    CusumChangePointResult,
    OrderStatisticAuditResult,
    PairCooccurrenceAuditResult,
    PermutationTestResult,
    cusum_change_point_test,
    order_statistic_q_audit,
    pair_cooccurrence_audit,
    whole_draw_shuffle_test,
)


def mean_adjacent_overlap(matrix: np.ndarray) -> float:
    values = np.asarray(matrix, dtype=float)
    if values.shape[0] < 2:
        return 0.0
    return float(np.mean(np.sum(values[:-1] * values[1:], axis=1)))


def max_abs_lag1_correlation(matrix: np.ndarray) -> float:
    values = np.asarray(matrix, dtype=float)
    if values.shape[0] < 3:
        return 0.0
    left = values[:-1]
    right = values[1:]
    left_centered = left - left.mean(axis=0)
    right_centered = right - right.mean(axis=0)
    numerator = np.sum(left_centered * right_centered, axis=0)
    denominator = np.sqrt(
        np.sum(left_centered**2, axis=0)
        * np.sum(right_centered**2, axis=0)
    )
    correlations = np.divide(
        numerator,
        denominator,
        out=np.zeros_like(numerator),
        where=denominator > 0.0,
    )
    return float(np.max(np.abs(correlations)))


@dataclass(frozen=True)
class P0PeriodAudit:
    adjacent_overlap: PermutationTestResult
    lag1_correlation: PermutationTestResult
    pair_cooccurrence: PairCooccurrenceAuditResult
    order_statistics: OrderStatisticAuditResult
    change_point: CusumChangePointResult


def run_p0_period_audit(
    matrix: np.ndarray,
    *,
    permutations: int,
    seed: int,
    batch_size: int = 16,
    min_segment: int | None = None,
) -> P0PeriodAudit:
    values = np.asarray(matrix, dtype=float)
    if min_segment is None:
        min_segment = max(20, min(250, values.shape[0] // 10))
    return P0PeriodAudit(
        adjacent_overlap=whole_draw_shuffle_test(
            values,
            mean_adjacent_overlap,
            permutations=permutations,
            seed=seed,
            alternative="two-sided",
        ),
        lag1_correlation=whole_draw_shuffle_test(
            values,
            max_abs_lag1_correlation,
            permutations=permutations,
            seed=seed + 1,
            alternative="greater",
        ),
        pair_cooccurrence=pair_cooccurrence_audit(
            values,
            permutations=permutations,
            seed=seed + 2,
            batch_size=batch_size,
        ),
        order_statistics=order_statistic_q_audit(
            values,
            permutations=permutations,
            seed=seed + 3,
            batch_size=batch_size,
        ),
        change_point=cusum_change_point_test(
            values,
            permutations=permutations,
            seed=seed + 4,
            min_segment=min_segment,
        ),
    )


__all__ = [
    "P0PeriodAudit",
    "max_abs_lag1_correlation",
    "mean_adjacent_overlap",
    "run_p0_period_audit",
]
