"""Leakage-safe P1 hyperparameter selection for walk-forward lottery models."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

import numpy as np

from p1_analysis import nested_rolling_select


P1_PARAMETER_GRIDS: dict[str, tuple[dict[str, float | int], ...]] = {
    "bayesian_all": (
        {"prior_strength": 24.0},
        {"prior_strength": 6.0},
        {"prior_strength": 12.0},
        {"prior_strength": 48.0},
        {"prior_strength": 96.0},
    ),
    "bayesian_recent_120": (
        {"prior_strength": 24.0, "window": 120},
        {"prior_strength": 12.0, "window": 60},
        {"prior_strength": 24.0, "window": 60},
        {"prior_strength": 48.0, "window": 60},
        {"prior_strength": 12.0, "window": 120},
        {"prior_strength": 48.0, "window": 120},
        {"prior_strength": 12.0, "window": 240},
        {"prior_strength": 24.0, "window": 240},
        {"prior_strength": 48.0, "window": 240},
    ),
    "exp_decay_60": (
        {"prior_strength": 24.0, "half_life": 60.0},
        {"prior_strength": 12.0, "half_life": 30.0},
        {"prior_strength": 24.0, "half_life": 30.0},
        {"prior_strength": 48.0, "half_life": 30.0},
        {"prior_strength": 12.0, "half_life": 60.0},
        {"prior_strength": 48.0, "half_life": 60.0},
        {"prior_strength": 12.0, "half_life": 120.0},
        {"prior_strength": 24.0, "half_life": 120.0},
        {"prior_strength": 48.0, "half_life": 120.0},
    ),
}


DEFAULT_MODEL_PARAMETERS: dict[str, dict[str, float | int]] = {
    model_name: dict(candidates[0])
    for model_name, candidates in P1_PARAMETER_GRIDS.items()
}


@dataclass(frozen=True)
class P1HyperparameterSelection:
    parameters: dict[str, dict[str, float | int]]
    audit_rows: tuple[dict[str, object], ...]
    formation_end_index: int
    min_train_size: int
    validation_size: int
    max_inner_folds: int

    def manifest_dict(self) -> dict[str, object]:
        return {
            "formation_end_index": self.formation_end_index,
            "min_train_size": self.min_train_size,
            "validation_size": self.validation_size,
            "max_inner_folds": self.max_inner_folds,
            "selection_metric": "mean number-level Brier across inner rolling folds",
            "selected_parameters": self.parameters,
        }


def _validated_actual(actual: np.ndarray, pick_count: int) -> np.ndarray:
    values = np.asarray(actual, dtype=float)
    if values.ndim != 2 or values.shape[0] < 2 or values.shape[1] < 2:
        raise ValueError("actual 必须是至少两期、两个号码的二维矩阵")
    if not np.all((values == 0.0) | (values == 1.0)):
        raise ValueError("actual 必须是 0/1 multi-hot")
    if not np.all(values.sum(axis=1) == pick_count):
        raise ValueError("actual 每期必须恰好选择 pick_count 个号码")
    return values


def tunable_probability_candidates(
    actual: np.ndarray,
    pick_count: int,
    model_name: str,
    candidates: Sequence[Mapping[str, float | int]] | None = None,
) -> np.ndarray:
    """Generate candidate-first probabilities, each strictly walk-forward."""

    values = _validated_actual(actual, pick_count)
    if model_name not in P1_PARAMETER_GRIDS:
        raise ValueError(f"不支持的 P1 调参模型: {model_name}")
    candidate_values = tuple(candidates or P1_PARAMETER_GRIDS[model_name])
    if not candidate_values:
        raise ValueError("候选参数不能为空")

    draw_count, pool_size = values.shape
    p0 = pick_count / pool_size
    cumulative = np.vstack(
        [np.zeros((1, pool_size), dtype=float), np.cumsum(values, axis=0)]
    )
    indices = np.arange(draw_count)
    history_sizes = indices[:, np.newaxis]
    result: list[np.ndarray] = []

    if model_name == "bayesian_all":
        counts = cumulative[:-1]
        for candidate in candidate_values:
            prior = float(candidate["prior_strength"])
            if prior <= 0:
                raise ValueError("prior_strength 必须大于 0")
            result.append((counts + prior * p0) / (history_sizes + prior))

    elif model_name == "bayesian_recent_120":
        for candidate in candidate_values:
            prior = float(candidate["prior_strength"])
            window = int(candidate["window"])
            if prior <= 0 or window <= 0:
                raise ValueError("prior_strength 和 window 必须大于 0")
            recent_start = np.maximum(0, indices - window)
            recent_sizes = (indices - recent_start)[:, np.newaxis]
            recent_counts = cumulative[indices] - cumulative[recent_start]
            result.append(
                (recent_counts + prior * p0) / (recent_sizes + prior)
            )

    else:
        half_life_cache: dict[float, tuple[np.ndarray, np.ndarray]] = {}
        for candidate in candidate_values:
            prior = float(candidate["prior_strength"])
            half_life = float(candidate["half_life"])
            if prior <= 0 or half_life <= 0:
                raise ValueError("prior_strength 和 half_life 必须大于 0")
            cached = half_life_cache.get(half_life)
            if cached is None:
                decay = 0.5 ** (1.0 / half_life)
                counts = np.zeros((draw_count, pool_size), dtype=float)
                mass = np.zeros(draw_count, dtype=float)
                running_counts = np.zeros(pool_size, dtype=float)
                running_mass = 0.0
                for target_index in range(1, draw_count):
                    running_counts = (
                        decay * running_counts + values[target_index - 1]
                    )
                    running_mass = decay * running_mass + 1.0
                    counts[target_index] = running_counts
                    mass[target_index] = running_mass
                cached = counts, mass
                half_life_cache[half_life] = cached
            counts, mass = cached
            result.append(
                (counts + prior * p0) / (mass[:, np.newaxis] + prior)
            )

    return np.clip(np.stack(result), 1e-9, 1.0 - 1e-9)


def select_p1_hyperparameters(
    actual: np.ndarray,
    pick_count: int,
    formation_end_index: int,
    *,
    parameter_grids: Mapping[
        str, Sequence[Mapping[str, float | int]]
    ] | None = None,
    max_inner_folds: int = 5,
) -> P1HyperparameterSelection:
    """Freeze P1 parameters before the outer GA validation block begins."""

    values = _validated_actual(actual, pick_count)
    formation_end = int(formation_end_index)
    if not 12 <= formation_end < len(values):
        raise ValueError("formation_end_index 必须至少为 12 且早于数据末尾")
    fold_limit = int(max_inner_folds)
    if fold_limit <= 0:
        raise ValueError("max_inner_folds 必须大于 0")

    validation_size = max(4, int(round(formation_end * 0.10)))
    min_train_size = max(8, int(round(formation_end * 0.30)))
    if min_train_size + validation_size > formation_end:
        min_train_size = formation_end - validation_size
    grids = parameter_grids or P1_PARAMETER_GRIDS
    parameters: dict[str, dict[str, float | int]] = {}
    audit_rows: list[dict[str, object]] = []

    for model_name in P1_PARAMETER_GRIDS:
        candidates = tuple(dict(item) for item in grids[model_name])
        probabilities = tunable_probability_candidates(
            values,
            pick_count,
            model_name,
            candidates,
        )
        selection = nested_rolling_select(
            candidates,
            formation_end + 1,
            candidate_probabilities=probabilities[:, : formation_end + 1],
            outcomes=values[: formation_end + 1],
            outer_start=formation_end,
            min_train_size=min_train_size,
            validation_size=validation_size,
            inner_step=validation_size,
            max_inner_folds=fold_limit,
        )
        decision = selection.decisions[0]
        selected = dict(decision.selected_candidate)
        parameters[model_name] = selected
        fold_ranges = ";".join(
            f"{fold.train_start}:{fold.train_end}|"
            f"{fold.validation_start}:{fold.validation_end}"
            for fold in decision.inner_folds
        )
        for candidate_index, (candidate, score) in enumerate(
            zip(candidates, decision.candidate_scores, strict=True)
        ):
            audit_rows.append(
                {
                    "model": model_name,
                    "candidate_index": candidate_index,
                    "selected": candidate_index == decision.selected_candidate_index,
                    "prior_strength": candidate.get("prior_strength", ""),
                    "window": candidate.get("window", ""),
                    "half_life": candidate.get("half_life", ""),
                    "mean_inner_brier": score,
                    "formation_end_index": formation_end,
                    "min_train_size": min_train_size,
                    "validation_size": validation_size,
                    "inner_fold_count": len(decision.inner_folds),
                    "inner_fold_ranges": fold_ranges,
                }
            )

    return P1HyperparameterSelection(
        parameters=parameters,
        audit_rows=tuple(audit_rows),
        formation_end_index=formation_end,
        min_train_size=min_train_size,
        validation_size=validation_size,
        max_inner_folds=fold_limit,
    )


__all__ = [
    "DEFAULT_MODEL_PARAMETERS",
    "P1HyperparameterSelection",
    "P1_PARAMETER_GRIDS",
    "select_p1_hyperparameters",
    "tunable_probability_candidates",
]
