"""P1 probability-model evaluation utilities.

This module contains the statistical building blocks that are independent of
the main lottery experiment pipeline:

* a numerically stable conditional-Bernoulli (fixed-size maximum-entropy set)
  normalizer and exact combination likelihood;
* leakage-safe nested rolling hyperparameter selection;
* moving-block bootstrap inference for per-draw Brier-score differences; and
* calibration bins plus the binned Murphy Brier decomposition.

The functions accept arrays supplied by callers and never load project data.
All random procedures use an explicit, recorded NumPy seed.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np


Reduction = Literal["none", "mean", "sum"]


def _integer(name: str, value: object, *, minimum: int = 0) -> int:
    if isinstance(value, (bool, np.bool_)) or not isinstance(
        value, (int, np.integer)
    ):
        raise ValueError(f"{name} must be an integer")
    parsed = int(value)
    if parsed < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return parsed


def _unit_interval(
    name: str,
    value: object,
    *,
    include_zero: bool = False,
    include_one: bool = False,
) -> float:
    if isinstance(value, (bool, np.bool_)):
        raise ValueError(f"{name} must be a finite probability")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a finite probability") from exc
    lower_valid = parsed >= 0.0 if include_zero else parsed > 0.0
    upper_valid = parsed <= 1.0 if include_one else parsed < 1.0
    if not math.isfinite(parsed) or not lower_valid or not upper_valid:
        left = "[" if include_zero else "("
        right = "]" if include_one else ")"
        raise ValueError(f"{name} must be in {left}0, 1{right}")
    return parsed


def _log_weight_matrix(log_weights: object) -> tuple[np.ndarray, bool]:
    try:
        values = np.asarray(log_weights, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise ValueError("log_weights must be a numeric one- or two-dimensional array") from exc
    if values.ndim not in (1, 2):
        raise ValueError("log_weights must be one- or two-dimensional")
    if values.size == 0 or values.shape[-1] == 0:
        raise ValueError("log_weights must not be empty")
    if values.ndim == 2 and values.shape[0] == 0:
        raise ValueError("log_weights must contain at least one row")
    if not np.all(np.isfinite(values)):
        raise ValueError("log_weights must contain only finite values")
    was_vector = values.ndim == 1
    return (values[None, :] if was_vector else values), was_vector


def _validated_pick_count(pick_count: object, pool_size: int) -> int:
    parsed = _integer("pick_count", pick_count)
    if parsed > pool_size:
        raise ValueError("pick_count must not exceed the number of log_weights")
    return parsed


def _log_normalizer_rows(log_weights: np.ndarray, pick_count: int) -> np.ndarray:
    """Compute log elementary symmetric polynomials for a 2-D array."""

    row_count, pool_size = log_weights.shape
    if pick_count == 0:
        return np.zeros(row_count, dtype=np.float64)

    # Descending updates ensure every item can be selected at most once.  The
    # recurrence is e_j(new) = e_j(old) + w_i * e_{j-1}(old), evaluated fully
    # in log space.  Memory is O(k), and runtime is O(Nk) per row.
    result = np.empty(row_count, dtype=np.float64)
    for row_index in range(row_count):
        state = np.full(pick_count + 1, -np.inf, dtype=np.float64)
        state[0] = 0.0
        row = log_weights[row_index]
        shift = float(row.max())
        centered_row = row - shift
        for item_index in range(pool_size):
            upper = min(pick_count, item_index + 1)
            item_log_weight = centered_row[item_index]
            for selected_count in range(upper, 0, -1):
                state[selected_count] = np.logaddexp(
                    state[selected_count],
                    state[selected_count - 1] + item_log_weight,
                )
        result[row_index] = state[pick_count] + pick_count * shift
    return result


def conditional_bernoulli_log_normalizer(
    log_weights: object,
    pick_count: int,
) -> float | np.ndarray:
    """Return ``log(e_k(exp(log_weights)))`` using an O(Nk) log-space DP.

    A one-dimensional input returns one float.  A two-dimensional input treats
    each row as an independent parameter vector and returns one value per row.
    ``pick_count=0`` and ``pick_count=N`` are supported for completeness.
    """

    values, was_vector = _log_weight_matrix(log_weights)
    selected_count = _validated_pick_count(pick_count, values.shape[1])
    result = _log_normalizer_rows(values, selected_count)
    return float(result[0]) if was_vector else result


def _selection_matrix(selections: object) -> tuple[np.ndarray, bool]:
    try:
        values = np.asarray(selections, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise ValueError("selections must be a binary one- or two-dimensional array") from exc
    if values.ndim not in (1, 2):
        raise ValueError("selections must be one- or two-dimensional")
    if values.size == 0 or values.shape[-1] == 0:
        raise ValueError("selections must not be empty")
    if values.ndim == 2 and values.shape[0] == 0:
        raise ValueError("selections must contain at least one row")
    if not np.all(np.isfinite(values)) or not np.all(
        (values == 0.0) | (values == 1.0)
    ):
        raise ValueError("selections must be binary")
    was_vector = values.ndim == 1
    return (values[None, :] if was_vector else values), was_vector


def _broadcast_distribution_inputs(
    log_weights: object,
    selections: object,
    pick_count: int | None,
) -> tuple[np.ndarray, np.ndarray, int, bool]:
    weight_rows, weights_were_vector = _log_weight_matrix(log_weights)
    selection_rows, selections_were_vector = _selection_matrix(selections)
    if weight_rows.shape[1] != selection_rows.shape[1]:
        raise ValueError("log_weights and selections must have the same pool width")

    if weight_rows.shape[0] == selection_rows.shape[0]:
        pass
    elif weight_rows.shape[0] == 1:
        weight_rows = np.broadcast_to(weight_rows, selection_rows.shape)
    elif selection_rows.shape[0] == 1:
        selection_rows = np.broadcast_to(selection_rows, weight_rows.shape)
    else:
        raise ValueError(
            "log_weights and selections must have equal row counts or one row to broadcast"
        )

    row_sums = selection_rows.sum(axis=1).astype(np.int64)
    if pick_count is None:
        if not np.all(row_sums == row_sums[0]):
            raise ValueError(
                "all selections must have the same size when pick_count is omitted"
            )
        selected_count = int(row_sums[0])
    else:
        selected_count = _validated_pick_count(pick_count, weight_rows.shape[1])
        if not np.all(row_sums == selected_count):
            raise ValueError("every selection must contain exactly pick_count entries")

    # When inferred, validate the mathematical boundary after reading row sums.
    selected_count = _validated_pick_count(selected_count, weight_rows.shape[1])
    scalar_result = weights_were_vector and selections_were_vector
    return weight_rows, selection_rows, selected_count, scalar_result


def conditional_bernoulli_log_probability(
    log_weights: object,
    selections: object,
    *,
    pick_count: int | None = None,
) -> float | np.ndarray:
    """Return exact log probabilities of legal fixed-size combinations.

    ``log_weights`` are the natural parameters ``log(w_i)`` in

    ``q(S | w) = prod(i in S) w_i / e_k(w)``.

    Inputs may be row-wise matrices.  A single log-weight vector is also
    broadcast across a matrix of combinations, which is convenient when
    scoring several observed draws under one distribution.
    """

    weight_rows, selection_rows, selected_count, scalar_result = (
        _broadcast_distribution_inputs(log_weights, selections, pick_count)
    )
    # A common shift cancels exactly under the fixed-size condition.  Remove it
    # before both terms so very large natural-parameter offsets do not cause a
    # loss of precision when numerator and normalizer are subtracted.
    centered_weights = weight_rows - weight_rows.max(axis=1, keepdims=True)
    selected_log_weight = np.sum(centered_weights * selection_rows, axis=1)
    log_normalizer = _log_normalizer_rows(centered_weights, selected_count)
    result = selected_log_weight - log_normalizer
    return float(result[0]) if scalar_result else result


def conditional_bernoulli_nll(
    log_weights: object,
    selections: object,
    *,
    pick_count: int | None = None,
    reduction: Reduction = "mean",
) -> float | np.ndarray:
    """Return exact combination negative log likelihood.

    ``reduction='none'`` always returns a one-dimensional array, even for one
    distribution/selection pair.  ``'mean'`` and ``'sum'`` return floats.
    """

    if reduction not in {"none", "mean", "sum"}:
        raise ValueError("reduction must be 'none', 'mean', or 'sum'")
    log_probability = conditional_bernoulli_log_probability(
        log_weights,
        selections,
        pick_count=pick_count,
    )
    losses = -np.atleast_1d(np.asarray(log_probability, dtype=np.float64))
    if reduction == "none":
        return losses
    if reduction == "sum":
        return float(losses.sum())
    return float(losses.mean())


@dataclass(frozen=True)
class RollingFold:
    """One expanding- or fixed-window inner validation fold."""

    train_start: int
    train_end: int
    validation_start: int
    validation_end: int

    @property
    def train_indices(self) -> np.ndarray:
        indices = np.arange(self.train_start, self.train_end, dtype=np.int64)
        indices.flags.writeable = False
        return indices

    @property
    def validation_indices(self) -> np.ndarray:
        indices = np.arange(
            self.validation_start, self.validation_end, dtype=np.int64
        )
        indices.flags.writeable = False
        return indices


@dataclass(frozen=True)
class NestedRollingDecision:
    """Hyperparameter decision made before one untouched outer test window."""

    test_start: int
    test_end: int
    selected_candidate_index: int
    selected_candidate: Any
    candidate_scores: tuple[float, ...]
    inner_folds: tuple[RollingFold, ...]

    @property
    def test_indices(self) -> np.ndarray:
        indices = np.arange(self.test_start, self.test_end, dtype=np.int64)
        indices.flags.writeable = False
        return indices


@dataclass(frozen=True)
class NestedRollingSelectionResult:
    candidates: tuple[Any, ...]
    decisions: tuple[NestedRollingDecision, ...]
    higher_is_better: bool

    @property
    def selected_candidates(self) -> tuple[Any, ...]:
        return tuple(decision.selected_candidate for decision in self.decisions)


def nested_rolling_select(
    candidates: Sequence[Any],
    sample_count: int,
    evaluator: Callable[[Any, np.ndarray, np.ndarray], float] | None = None,
    *,
    candidate_losses: object | None = None,
    candidate_probabilities: object | None = None,
    outcomes: object | None = None,
    outer_start: int,
    min_train_size: int,
    validation_size: int,
    outer_test_size: int = 1,
    outer_step: int = 1,
    inner_step: int | None = None,
    max_inner_folds: int | None = None,
    train_window: int | None = None,
    higher_is_better: bool = False,
) -> NestedRollingSelectionResult:
    """Select candidates with nested, chronological rolling validation.

    For every outer test window starting at ``t``, candidates are scored only
    on inner folds whose validation end is at most ``t``.  Inner training data
    always end before their validation data begin.  The callback receives only
    read-only train and validation index arrays; the untouched outer indices
    are returned to the caller after selection.

    Exactly one score source must be supplied:

    * ``evaluator(candidate, train_indices, validation_indices)``;
    * ``candidate_losses`` with shape ``(candidate_count, sample_count)``; or
    * ``candidate_probabilities`` with shape ``(candidate_count, *outcomes.shape)``.

    The probability form is converted to per-time Brier losses.  Precomputed
    losses or probabilities are sliced only at inner validation indices, but
    the caller remains responsible for ensuring each prediction at time ``t``
    was itself formed using observations strictly before ``t``.

    Ties are resolved deterministically in favour of the earliest candidate.
    ``train_window=None`` uses expanding training history; otherwise only the
    most recent ``train_window`` observations are passed to the evaluator.
    """

    if isinstance(candidates, (str, bytes)):
        raise ValueError("candidates must be a non-empty sequence")
    try:
        candidate_values = tuple(candidates)
    except TypeError as exc:
        raise ValueError("candidates must be a non-empty sequence") from exc
    if not candidate_values:
        raise ValueError("candidates must be a non-empty sequence")
    total_count = _integer("sample_count", sample_count, minimum=1)
    first_test = _integer("outer_start", outer_start, minimum=1)
    minimum_train = _integer("min_train_size", min_train_size, minimum=1)
    validation_count = _integer("validation_size", validation_size, minimum=1)
    test_count = _integer("outer_test_size", outer_test_size, minimum=1)
    outer_stride = _integer("outer_step", outer_step, minimum=1)
    inner_stride = (
        validation_count
        if inner_step is None
        else _integer("inner_step", inner_step, minimum=1)
    )
    fold_limit = (
        None
        if max_inner_folds is None
        else _integer("max_inner_folds", max_inner_folds, minimum=1)
    )
    training_window = (
        None
        if train_window is None
        else _integer("train_window", train_window, minimum=1)
    )
    if training_window is not None and training_window < minimum_train:
        raise ValueError("train_window must be at least min_train_size")
    if first_test < minimum_train + validation_count:
        raise ValueError(
            "outer_start must leave room for min_train_size and validation_size"
        )
    if first_test + test_count > total_count:
        raise ValueError("outer_start and outer_test_size exceed sample_count")

    source_count = sum(
        source is not None
        for source in (evaluator, candidate_losses, candidate_probabilities)
    )
    if source_count != 1:
        raise ValueError(
            "provide exactly one of evaluator, candidate_losses, or "
            "candidate_probabilities"
        )
    if evaluator is not None and not callable(evaluator):
        raise ValueError("evaluator must be callable")
    if candidate_probabilities is None and outcomes is not None:
        raise ValueError("outcomes may only be used with candidate_probabilities")
    if candidate_probabilities is not None:
        if outcomes is None:
            raise ValueError("outcomes are required with candidate_probabilities")
        loss_matrix = candidate_brier_loss_matrix(
            candidate_probabilities,
            outcomes,
        )
    elif candidate_losses is not None:
        try:
            loss_matrix = np.asarray(candidate_losses, dtype=np.float64)
        except (TypeError, ValueError) as exc:
            raise ValueError("candidate_losses must be a finite two-dimensional array") from exc
        if loss_matrix.ndim != 2 or not np.all(np.isfinite(loss_matrix)):
            raise ValueError("candidate_losses must be a finite two-dimensional array")
    else:
        loss_matrix = None
    if loss_matrix is not None and loss_matrix.shape != (
        len(candidate_values),
        total_count,
    ):
        raise ValueError(
            "candidate loss matrix shape must be "
            f"({len(candidate_values)}, {total_count})"
        )

    decisions: list[NestedRollingDecision] = []
    for test_start in range(
        first_test,
        total_count - test_count + 1,
        outer_stride,
    ):
        validation_starts = list(
            range(
                minimum_train,
                test_start - validation_count + 1,
                inner_stride,
            )
        )
        if fold_limit is not None:
            validation_starts = validation_starts[-fold_limit:]
        if not validation_starts:
            raise ValueError(f"no inner folds are available before outer index {test_start}")

        folds = tuple(
            RollingFold(
                train_start=(
                    0
                    if training_window is None
                    else max(0, validation_start - training_window)
                ),
                train_end=validation_start,
                validation_start=validation_start,
                validation_end=validation_start + validation_count,
            )
            for validation_start in validation_starts
        )

        candidate_scores: list[float] = []
        for candidate_index, candidate in enumerate(candidate_values):
            fold_scores: list[float] = []
            for fold_index, fold in enumerate(folds):
                if loss_matrix is None:
                    assert evaluator is not None
                    raw_score = evaluator(
                        candidate,
                        fold.train_indices,
                        fold.validation_indices,
                    )
                else:
                    raw_score = float(
                        loss_matrix[
                            candidate_index,
                            fold.validation_start : fold.validation_end,
                        ].mean()
                    )
                if isinstance(raw_score, (bool, np.bool_)):
                    raise ValueError("evaluator must return one finite numeric score")
                try:
                    score = float(raw_score)
                except (TypeError, ValueError) as exc:
                    raise ValueError(
                        "evaluator must return one finite numeric score "
                        f"for candidate {candidate_index}, fold {fold_index}"
                    ) from exc
                if not math.isfinite(score):
                    raise ValueError(
                        "evaluator must return one finite numeric score "
                        f"for candidate {candidate_index}, fold {fold_index}"
                    )
                fold_scores.append(score)
            candidate_scores.append(float(np.mean(fold_scores)))

        score_array = np.asarray(candidate_scores, dtype=np.float64)
        selected_index = int(
            np.argmax(score_array) if higher_is_better else np.argmin(score_array)
        )
        decisions.append(
            NestedRollingDecision(
                test_start=test_start,
                test_end=test_start + test_count,
                selected_candidate_index=selected_index,
                selected_candidate=candidate_values[selected_index],
                candidate_scores=tuple(candidate_scores),
                inner_folds=folds,
            )
        )

    return NestedRollingSelectionResult(
        candidates=candidate_values,
        decisions=tuple(decisions),
        higher_is_better=bool(higher_is_better),
    )


def candidate_brier_loss_matrix(
    candidate_probabilities: object,
    outcomes: object,
) -> np.ndarray:
    """Convert candidate-first walk-forward probabilities to per-time losses.

    If outcomes have shape ``(T, N)``, probabilities must have shape
    ``(C, T, N)`` and the result has shape ``(C, T)``.  One binary outcome per
    time point, shaped ``(T,)``, is also supported via probabilities ``(C, T)``.
    """

    try:
        probabilities = np.asarray(candidate_probabilities, dtype=np.float64)
        observed = np.asarray(outcomes, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise ValueError("candidate_probabilities and outcomes must be numeric arrays") from exc
    if observed.ndim not in (1, 2) or observed.size == 0:
        raise ValueError("outcomes must be a non-empty one- or two-dimensional array")
    if probabilities.ndim != observed.ndim + 1 or probabilities.shape[1:] != observed.shape:
        raise ValueError(
            "candidate_probabilities must have shape "
            "(candidate_count, *outcomes.shape)"
        )
    if probabilities.shape[0] == 0:
        raise ValueError("candidate_probabilities must contain at least one candidate")
    if not np.all(np.isfinite(probabilities)) or np.any(
        (probabilities < 0.0) | (probabilities > 1.0)
    ):
        raise ValueError(
            "candidate_probabilities must contain finite values in [0, 1]"
        )
    if not np.all(np.isfinite(observed)) or not np.all(
        (observed == 0.0) | (observed == 1.0)
    ):
        raise ValueError("outcomes must be binary")
    squared_errors = (probabilities - observed[None, ...]) ** 2
    if observed.ndim == 1:
        return squared_errors
    return squared_errors.mean(axis=2)


def _difference_vector(differences: object) -> np.ndarray:
    try:
        values = np.asarray(differences, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise ValueError("differences must be a one-dimensional numeric array") from exc
    if values.ndim != 1:
        raise ValueError("differences must be one-dimensional")
    if values.size < 2:
        raise ValueError("differences must contain at least two draws")
    if not np.all(np.isfinite(values)):
        raise ValueError("differences must contain only finite values")
    return values


@dataclass(frozen=True)
class MovingBlockBootstrapResult:
    """Inference for candidate-minus-reference mean Brier score."""

    mean_difference: float
    ci_low: float
    ci_high: float
    confidence_level: float
    p_value_two_sided: float
    standard_error: float
    block_length: int
    replicates: int
    seed: int
    per_draw_differences: np.ndarray
    bootstrap_means: np.ndarray
    null_means: np.ndarray

    @property
    def candidate_is_better(self) -> bool:
        return self.mean_difference < 0.0

    def to_dict(self, *, include_distributions: bool = False) -> dict[str, Any]:
        result: dict[str, Any] = {
            "mean_difference": self.mean_difference,
            "ci_low": self.ci_low,
            "ci_high": self.ci_high,
            "confidence_level": self.confidence_level,
            "p_value_two_sided": self.p_value_two_sided,
            "standard_error": self.standard_error,
            "block_length": self.block_length,
            "replicates": self.replicates,
            "seed": self.seed,
            "candidate_is_better": self.candidate_is_better,
        }
        if include_distributions:
            result.update(
                {
                    "per_draw_differences": self.per_draw_differences.tolist(),
                    "bootstrap_means": self.bootstrap_means.tolist(),
                    "null_means": self.null_means.tolist(),
                }
            )
        return result


def moving_block_bootstrap(
    differences: object,
    *,
    block_length: int | None = None,
    replicates: int = 1999,
    confidence_level: float = 0.95,
    seed: int = 0,
) -> MovingBlockBootstrapResult:
    """Bootstrap the mean of an ordered difference series with moving blocks.

    Percentile limits use the ordinary (uncentred) block bootstrap.  The
    two-sided p-value tests a zero mean using block samples from the centred
    series and a ``+1`` Monte Carlo correction.
    """

    values = _difference_vector(differences)
    replicate_count = _integer("replicates", replicates, minimum=1)
    random_seed = _integer("seed", seed)
    coverage = _unit_interval("confidence_level", confidence_level)
    if block_length is None:
        selected_block_length = max(1, int(round(values.size ** (1.0 / 3.0))))
    else:
        selected_block_length = _integer("block_length", block_length, minimum=1)
    if selected_block_length > values.size:
        raise ValueError("block_length must not exceed the number of draws")

    observed_mean = float(values.mean())
    centered = values - observed_mean
    rng = np.random.default_rng(random_seed)
    block_count = math.ceil(values.size / selected_block_length)
    maximum_start = values.size - selected_block_length
    within_block = np.arange(selected_block_length, dtype=np.int64)
    bootstrap_means = np.empty(replicate_count, dtype=np.float64)
    null_means = np.empty(replicate_count, dtype=np.float64)

    for replicate_index in range(replicate_count):
        starts = rng.integers(0, maximum_start + 1, size=block_count)
        sample_indices = (starts[:, None] + within_block[None, :]).reshape(-1)
        sample_indices = sample_indices[: values.size]
        bootstrap_means[replicate_index] = float(values[sample_indices].mean())
        null_means[replicate_index] = float(centered[sample_indices].mean())

    alpha = 1.0 - coverage
    ci_low, ci_high = np.quantile(
        bootstrap_means,
        [alpha / 2.0, 1.0 - alpha / 2.0],
    )
    p_value = (
        1.0
        + float(np.count_nonzero(np.abs(null_means) >= abs(observed_mean)))
    ) / (replicate_count + 1.0)
    standard_error = (
        float(bootstrap_means.std(ddof=1))
        if replicate_count > 1
        else 0.0
    )

    return MovingBlockBootstrapResult(
        mean_difference=observed_mean,
        ci_low=float(ci_low),
        ci_high=float(ci_high),
        confidence_level=coverage,
        p_value_two_sided=float(p_value),
        standard_error=standard_error,
        block_length=selected_block_length,
        replicates=replicate_count,
        seed=random_seed,
        per_draw_differences=values.copy(),
        bootstrap_means=bootstrap_means,
        null_means=null_means,
    )


def _probabilities_and_outcomes(
    probabilities: object,
    outcomes: object,
) -> tuple[np.ndarray, np.ndarray]:
    try:
        forecast = np.asarray(probabilities, dtype=np.float64)
        observed = np.asarray(outcomes, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise ValueError("probabilities and outcomes must be numeric arrays") from exc
    if forecast.shape != observed.shape:
        raise ValueError("probabilities and outcomes must have the same shape")
    if forecast.ndim not in (1, 2) or forecast.size == 0:
        raise ValueError("probabilities and outcomes must be non-empty 1-D or 2-D arrays")
    if forecast.ndim == 2 and (forecast.shape[0] == 0 or forecast.shape[1] == 0):
        raise ValueError("probabilities and outcomes must not have empty dimensions")
    if not np.all(np.isfinite(forecast)) or np.any(
        (forecast < 0.0) | (forecast > 1.0)
    ):
        raise ValueError("probabilities must contain finite values in [0, 1]")
    if not np.all(np.isfinite(observed)) or not np.all(
        (observed == 0.0) | (observed == 1.0)
    ):
        raise ValueError("outcomes must be binary")
    return forecast, observed


def per_draw_brier_difference(
    candidate_probabilities: object,
    reference_probabilities: object,
    outcomes: object,
) -> np.ndarray:
    """Return candidate-minus-reference Brier differences in time order."""

    candidate, observed = _probabilities_and_outcomes(
        candidate_probabilities,
        outcomes,
    )
    reference, reference_observed = _probabilities_and_outcomes(
        reference_probabilities,
        outcomes,
    )
    # The second validation also protects against exotic array conversion that
    # would produce a different outcome representation.
    if not np.array_equal(observed, reference_observed):
        raise ValueError("outcomes must be identical for candidate and reference")
    if candidate.shape != reference.shape:
        raise ValueError("candidate and reference probabilities must have the same shape")
    squared_difference = (candidate - observed) ** 2 - (reference - observed) ** 2
    if squared_difference.ndim == 1:
        return squared_difference
    return squared_difference.mean(axis=1)


def moving_block_bootstrap_brier_difference(
    candidate_probabilities: object,
    reference_probabilities: object,
    outcomes: object,
    *,
    block_length: int | None = None,
    replicates: int = 1999,
    confidence_level: float = 0.95,
    seed: int = 0,
) -> MovingBlockBootstrapResult:
    """Compare two probability forecasts using per-draw Brier differences."""

    differences = per_draw_brier_difference(
        candidate_probabilities,
        reference_probabilities,
        outcomes,
    )
    return moving_block_bootstrap(
        differences,
        block_length=block_length,
        replicates=replicates,
        confidence_level=confidence_level,
        seed=seed,
    )


@dataclass(frozen=True)
class CalibrationBin:
    index: int
    lower_bound: float
    upper_bound: float
    count: int
    mean_probability: float
    observed_frequency: float
    mean_brier: float

    @property
    def calibration_gap(self) -> float:
        return self.mean_probability - self.observed_frequency

    def to_dict(self) -> dict[str, float | int]:
        return {
            "index": self.index,
            "lower_bound": self.lower_bound,
            "upper_bound": self.upper_bound,
            "count": self.count,
            "mean_probability": self.mean_probability,
            "observed_frequency": self.observed_frequency,
            "mean_brier": self.mean_brier,
            "calibration_gap": self.calibration_gap,
        }


@dataclass(frozen=True)
class CalibrationResult:
    bins: tuple[CalibrationBin, ...]
    sample_count: int
    bin_count: int
    expected_calibration_error: float
    maximum_calibration_error: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "sample_count": self.sample_count,
            "bin_count": self.bin_count,
            "expected_calibration_error": self.expected_calibration_error,
            "maximum_calibration_error": self.maximum_calibration_error,
            "bins": [item.to_dict() for item in self.bins],
        }


def _calibration_components(
    probabilities: object,
    outcomes: object,
    bin_count: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    forecast, observed = _probabilities_and_outcomes(probabilities, outcomes)
    flat_forecast = forecast.reshape(-1)
    flat_observed = observed.reshape(-1)
    selected_bin_count = _integer("bin_count", bin_count, minimum=1)
    bin_indices = np.minimum(
        (flat_forecast * selected_bin_count).astype(np.int64),
        selected_bin_count - 1,
    )
    edges = np.linspace(0.0, 1.0, selected_bin_count + 1)
    return flat_forecast, flat_observed, bin_indices, edges


def calibration_bins(
    probabilities: object,
    outcomes: object,
    *,
    bin_count: int = 10,
) -> CalibrationResult:
    """Aggregate binary forecasts into deterministic equal-width bins."""

    forecast, observed, bin_indices, edges = _calibration_components(
        probabilities,
        outcomes,
        bin_count,
    )
    bins: list[CalibrationBin] = []
    weighted_absolute_gap = 0.0
    maximum_gap = 0.0
    for bin_index in range(len(edges) - 1):
        mask = bin_indices == bin_index
        count = int(np.count_nonzero(mask))
        if count:
            mean_probability = float(forecast[mask].mean())
            observed_frequency = float(observed[mask].mean())
            mean_brier = float(((forecast[mask] - observed[mask]) ** 2).mean())
            gap = abs(mean_probability - observed_frequency)
            weighted_absolute_gap += count * gap
            maximum_gap = max(maximum_gap, gap)
        else:
            mean_probability = math.nan
            observed_frequency = math.nan
            mean_brier = math.nan
        bins.append(
            CalibrationBin(
                index=bin_index,
                lower_bound=float(edges[bin_index]),
                upper_bound=float(edges[bin_index + 1]),
                count=count,
                mean_probability=mean_probability,
                observed_frequency=observed_frequency,
                mean_brier=mean_brier,
            )
        )

    return CalibrationResult(
        bins=tuple(bins),
        sample_count=int(forecast.size),
        bin_count=len(bins),
        expected_calibration_error=weighted_absolute_gap / forecast.size,
        maximum_calibration_error=maximum_gap,
    )


@dataclass(frozen=True)
class BrierDecompositionResult:
    brier_score: float
    reliability: float
    resolution: float
    uncertainty: float
    decomposed_brier: float
    decomposition_residual: float
    base_rate: float
    calibration: CalibrationResult

    def to_dict(self) -> dict[str, Any]:
        return {
            "brier_score": self.brier_score,
            "reliability": self.reliability,
            "resolution": self.resolution,
            "uncertainty": self.uncertainty,
            "decomposed_brier": self.decomposed_brier,
            "decomposition_residual": self.decomposition_residual,
            "base_rate": self.base_rate,
            "calibration": self.calibration.to_dict(),
        }


def brier_decomposition(
    probabilities: object,
    outcomes: object,
    *,
    bin_count: int = 10,
) -> BrierDecompositionResult:
    """Return the binned Murphy reliability-resolution-uncertainty terms.

    With finite bins, ``reliability - resolution + uncertainty`` is the Brier
    score of the grouped forecasts.  ``decomposition_residual`` records the
    difference from the ungrouped score instead of silently claiming an exact
    identity when probabilities vary inside a bin.
    """

    forecast, observed = _probabilities_and_outcomes(probabilities, outcomes)
    calibration = calibration_bins(forecast, observed, bin_count=bin_count)
    base_rate = float(observed.mean())
    sample_count = observed.size
    reliability = 0.0
    resolution = 0.0
    for item in calibration.bins:
        if item.count == 0:
            continue
        weight = item.count / sample_count
        reliability += weight * (
            item.mean_probability - item.observed_frequency
        ) ** 2
        resolution += weight * (item.observed_frequency - base_rate) ** 2
    uncertainty = base_rate * (1.0 - base_rate)
    decomposed = reliability - resolution + uncertainty
    score = float(np.mean((forecast - observed) ** 2))
    return BrierDecompositionResult(
        brier_score=score,
        reliability=float(reliability),
        resolution=float(resolution),
        uncertainty=float(uncertainty),
        decomposed_brier=float(decomposed),
        decomposition_residual=float(score - decomposed),
        base_rate=base_rate,
        calibration=calibration,
    )


__all__ = [
    "BrierDecompositionResult",
    "CalibrationBin",
    "CalibrationResult",
    "MovingBlockBootstrapResult",
    "NestedRollingDecision",
    "NestedRollingSelectionResult",
    "RollingFold",
    "brier_decomposition",
    "calibration_bins",
    "candidate_brier_loss_matrix",
    "conditional_bernoulli_log_normalizer",
    "conditional_bernoulli_log_probability",
    "conditional_bernoulli_nll",
    "moving_block_bootstrap",
    "moving_block_bootstrap_brier_difference",
    "nested_rolling_select",
    "per_draw_brier_difference",
]
