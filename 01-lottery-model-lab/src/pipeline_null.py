"""Pipeline-level fair-lottery null simulations.

This module deliberately sits outside ``lottery_lab.py``.  It provides the
orchestration needed to answer a stricter question than a fixed-model test:

    If the complete candidate search and selection pipeline were rerun on
    fair ``k/N`` histories, how often would its *best* validation or holdout
    Brier skill look at least as good as the observed result?

The caller supplies a ``PipelineEvaluator``.  That evaluator must rerun the
same candidate generation, hyperparameter search, genetic optimisation, and
selection rule used for the observed history.  Passing one already-selected
model is not a pipeline test; by default this module rejects evaluations with
fewer than two candidates.

Typical integration with the existing Lottery Lab pipeline is:

1. Build one evaluator adapter per lottery zone (SSQ red/blue, DLT front/back).
2. Inside the adapter, reconstruct synthetic ``Draw`` rows from the supplied
   multi-hot history while retaining the real schedule/issue metadata.
3. Run all existing model arms and GA selection using ``context`` split
   indices and the supplied evaluator RNG.
4. Return validation and holdout probability matrices for every searched
   candidate, including the selected GA ensemble.
5. Evaluate the real history with :func:`evaluate_pipeline_history`, then pass
   those statistics to :func:`run_pipeline_null`.

The adapter must be pure with respect to shared result files.  This is
especially important when thread or process parallelism is enabled.
The framework cannot detect feature leakage inside an adapter, so each
candidate prediction must still obey the same strict walk-forward rule as the
observed pipeline.  Extra statistics are interpreted as upper-tail statistics.
"""

from __future__ import annotations

import json
import math
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Literal, Mapping, Protocol, Sequence

import numpy as np


SCHEMA_VERSION = 1
DEFAULT_REPETITIONS = {
    "quick": 100,
    "full": 2_000,
}
STANDARD_STATISTIC_NAMES = (
    "max_validation_brier_skill",
    "max_holdout_brier_skill",
    "selected_validation_brier_skill",
    "selected_holdout_brier_skill",
    "selection_optimism_brier_skill",
    "holdout_winner_gap_brier_skill",
)


@dataclass(frozen=True)
class FairHistorySpec:
    """Dimensions and fixed temporal split for one ``k/N`` lottery zone."""

    pool_size: int
    pick_count: int
    draw_count: int
    validation_start_index: int
    holdout_start_index: int
    label: str = "k_over_n"

    def __post_init__(self) -> None:
        if self.pool_size < 2:
            raise ValueError("pool_size 必须至少为 2")
        if not 0 < self.pick_count < self.pool_size:
            raise ValueError("pick_count 必须在 1 和 pool_size - 1 之间")
        if self.draw_count < 3:
            raise ValueError("draw_count 必须至少为 3")
        if not 0 < self.validation_start_index < self.holdout_start_index:
            raise ValueError("验证集必须严格位于历史区间之后、留出集之前")
        if self.holdout_start_index >= self.draw_count:
            raise ValueError("holdout_start_index 必须小于 draw_count")

    @classmethod
    def from_ratios(
        cls,
        *,
        pool_size: int,
        pick_count: int,
        draw_count: int,
        validation_start_ratio: float = 0.60,
        holdout_start_ratio: float = 0.80,
        label: str = "k_over_n",
    ) -> "FairHistorySpec":
        if not 0.0 < validation_start_ratio < holdout_start_ratio < 1.0:
            raise ValueError("时间切分比例必须满足 0 < validation < holdout < 1")
        return cls(
            pool_size=pool_size,
            pick_count=pick_count,
            draw_count=draw_count,
            validation_start_index=int(draw_count * validation_start_ratio),
            holdout_start_index=int(draw_count * holdout_start_ratio),
            label=label,
        )

    @property
    def validation_count(self) -> int:
        return self.holdout_start_index - self.validation_start_index

    @property
    def holdout_count(self) -> int:
        return self.draw_count - self.holdout_start_index

    def to_dict(self) -> dict[str, object]:
        return {
            "label": self.label,
            "pool_size": self.pool_size,
            "pick_count": self.pick_count,
            "draw_count": self.draw_count,
            "validation_start_index": self.validation_start_index,
            "holdout_start_index": self.holdout_start_index,
            "validation_count": self.validation_count,
            "holdout_count": self.holdout_count,
        }


@dataclass(frozen=True)
class PipelineContext:
    """Deterministic context supplied to every evaluator invocation."""

    spec: FairHistorySpec
    replicate_index: int
    evaluator_seed: int

    @property
    def validation_indices(self) -> np.ndarray:
        return np.arange(
            self.spec.validation_start_index,
            self.spec.holdout_start_index,
            dtype=int,
        )

    @property
    def holdout_indices(self) -> np.ndarray:
        return np.arange(
            self.spec.holdout_start_index,
            self.spec.draw_count,
            dtype=int,
        )


@dataclass(frozen=True)
class CandidatePredictions:
    """Validation and holdout marginal probabilities for one candidate."""

    name: str
    validation_probabilities: np.ndarray
    holdout_probabilities: np.ndarray

    @classmethod
    def from_full_history(
        cls,
        name: str,
        probabilities: np.ndarray,
        context: PipelineContext,
    ) -> "CandidatePredictions":
        values = np.asarray(probabilities, dtype=float)
        expected_shape = (context.spec.draw_count, context.spec.pool_size)
        if values.shape != expected_shape:
            raise ValueError(
                f"{name} 完整概率矩阵形状应为 {expected_shape}，实际为 {values.shape}"
            )
        return cls(
            name=name,
            validation_probabilities=values[context.validation_indices],
            holdout_probabilities=values[context.holdout_indices],
        )


@dataclass(frozen=True)
class PipelineEvaluation:
    """Complete candidate set and the candidate selected by the pipeline."""

    candidates: Sequence[CandidatePredictions]
    selected_name: str
    extra_statistics: Mapping[str, float] = field(default_factory=dict)


class PipelineEvaluator(Protocol):
    def __call__(
        self,
        history: np.ndarray,
        context: PipelineContext,
        rng: np.random.Generator,
    ) -> PipelineEvaluation: ...


@dataclass(frozen=True)
class PipelineStatistics:
    """Standardised statistics from one observed or simulated pipeline run."""

    selected_name: str
    candidate_count: int
    statistics: Mapping[str, float]
    candidate_statistics: Mapping[str, Mapping[str, float]]

    def to_dict(self) -> dict[str, object]:
        return {
            "selected_name": self.selected_name,
            "candidate_count": self.candidate_count,
            "statistics": {
                name: float(value) for name, value in self.statistics.items()
            },
            "candidate_statistics": {
                candidate: {
                    name: float(value) for name, value in values.items()
                }
                for candidate, values in self.candidate_statistics.items()
            },
        }


@dataclass(frozen=True)
class NullStatisticSummary:
    count: int
    mean: float
    standard_deviation: float
    minimum: float
    maximum: float
    quantiles: Mapping[str, float]
    observed: float | None
    empirical_p_value: float | None

    def to_dict(self) -> dict[str, object]:
        return {
            "count": self.count,
            "mean": self.mean,
            "standard_deviation": self.standard_deviation,
            "minimum": self.minimum,
            "maximum": self.maximum,
            "quantiles": dict(self.quantiles),
            "observed": self.observed,
            "empirical_p_value": self.empirical_p_value,
        }


@dataclass(frozen=True)
class NullSimulationReport:
    """Serializable null distributions and upper-tail empirical p-values."""

    spec: FairHistorySpec
    mode: str
    repetitions: int
    seed: int
    backend: str
    workers: int
    batch_size: int
    minimum_candidate_count: int
    quantile_levels: Sequence[float]
    observed_statistics: Mapping[str, float]
    summaries: Mapping[str, NullStatisticSummary]
    null_distributions: Mapping[str, Sequence[float]]
    selected_candidate_counts: Mapping[str, int]

    def to_dict(self, *, include_distributions: bool = True) -> dict[str, object]:
        payload: dict[str, object] = {
            "schema_version": SCHEMA_VERSION,
            "spec": self.spec.to_dict(),
            "simulation": {
                "mode": self.mode,
                "repetitions": self.repetitions,
                "seed": self.seed,
                "backend": self.backend,
                "workers": self.workers,
                "batch_size": self.batch_size,
                "minimum_candidate_count": self.minimum_candidate_count,
                "quantile_levels": [float(value) for value in self.quantile_levels],
            },
            "tail": "greater_or_equal",
            "p_value_correction": "(exceedances + 1) / (repetitions + 1)",
            "observed_statistics": {
                name: float(value)
                for name, value in self.observed_statistics.items()
            },
            "summaries": {
                name: summary.to_dict() for name, summary in self.summaries.items()
            },
            "selected_candidate_counts": dict(self.selected_candidate_counts),
        }
        if include_distributions:
            payload["null_distributions"] = {
                name: [float(value) for value in values]
                for name, values in self.null_distributions.items()
            }
        return payload

    def to_json(
        self,
        *,
        include_distributions: bool = True,
        indent: int = 2,
    ) -> str:
        return (
            json.dumps(
                self.to_dict(include_distributions=include_distributions),
                ensure_ascii=False,
                indent=indent,
            )
            + "\n"
        )

    def write_json(
        self,
        path: Path,
        *,
        include_distributions: bool = True,
        indent: int = 2,
    ) -> None:
        destination = Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.name + ".tmp")
        temporary.write_text(
            self.to_json(
                include_distributions=include_distributions,
                indent=indent,
            ),
            encoding="utf-8",
        )
        temporary.replace(destination)


@dataclass(frozen=True)
class _SimulationTask:
    spec: FairHistorySpec
    evaluator: PipelineEvaluator
    replicate_index: int
    history_seed: int
    evaluator_seed: int
    minimum_candidate_count: int
    probability_sum_tolerance: float


@dataclass(frozen=True)
class _SimulationResult:
    replicate_index: int
    selected_name: str
    statistics: Mapping[str, float]


def repetitions_for_mode(mode: Literal["quick", "full"]) -> int:
    try:
        return DEFAULT_REPETITIONS[mode]
    except KeyError as error:
        raise ValueError("mode 必须是 quick 或 full") from error


def generate_fair_history(
    spec: FairHistorySpec,
    rng: np.random.Generator,
) -> np.ndarray:
    """Generate independent uniform fixed-size subsets as a multi-hot matrix."""

    random_scores = rng.random((spec.draw_count, spec.pool_size))
    selected = np.argpartition(
        random_scores,
        kth=spec.pick_count - 1,
        axis=1,
    )[:, : spec.pick_count]
    history = np.zeros((spec.draw_count, spec.pool_size), dtype=float)
    history[np.arange(spec.draw_count)[:, None], selected] = 1.0
    return history


def _validate_history(history: np.ndarray, spec: FairHistorySpec) -> np.ndarray:
    values = np.asarray(history, dtype=float)
    expected_shape = (spec.draw_count, spec.pool_size)
    if values.shape != expected_shape:
        raise ValueError(f"历史矩阵形状应为 {expected_shape}，实际为 {values.shape}")
    if not np.all(np.isfinite(values)):
        raise ValueError("历史矩阵包含非有限值")
    if not np.all((values == 0.0) | (values == 1.0)):
        raise ValueError("历史矩阵必须是 0/1 multi-hot 数据")
    if not np.all(values.sum(axis=1) == spec.pick_count):
        raise ValueError("历史矩阵每期必须恰好包含 pick_count 个号码")
    return values


def _validate_probabilities(
    *,
    candidate_name: str,
    split_name: str,
    probabilities: np.ndarray,
    expected_shape: tuple[int, int],
    pick_count: int,
    probability_sum_tolerance: float,
) -> np.ndarray:
    values = np.asarray(probabilities, dtype=float)
    if values.shape != expected_shape:
        raise ValueError(
            f"{candidate_name} {split_name} 概率矩阵形状应为 "
            f"{expected_shape}，实际为 {values.shape}"
        )
    if not np.all(np.isfinite(values)):
        raise ValueError(f"{candidate_name} {split_name} 概率包含非有限值")
    if np.any(values < 0.0) or np.any(values > 1.0):
        raise ValueError(f"{candidate_name} {split_name} 概率必须在 [0, 1] 内")
    row_sums = values.sum(axis=1)
    if not np.allclose(
        row_sums,
        float(pick_count),
        rtol=0.0,
        atol=probability_sum_tolerance,
    ):
        raise ValueError(
            f"{candidate_name} {split_name} 每期边际概率之和必须为 pick_count"
        )
    return values


def _brier_score(probabilities: np.ndarray, actual: np.ndarray) -> float:
    return float(np.mean((probabilities - actual) ** 2))


def _brier_skill(candidate_brier: float, uniform_brier: float) -> float:
    if uniform_brier <= 0.0:
        raise ValueError("均匀基线 Brier 必须大于 0")
    return 1.0 - candidate_brier / uniform_brier


def _statistics_from_evaluation(
    *,
    history: np.ndarray,
    spec: FairHistorySpec,
    evaluation: PipelineEvaluation,
    minimum_candidate_count: int,
    probability_sum_tolerance: float,
) -> PipelineStatistics:
    candidates = list(evaluation.candidates)
    if len(candidates) < minimum_candidate_count:
        raise ValueError(
            "完整管线零分布要求重跑候选模型选择；"
            f"至少需要 {minimum_candidate_count} 个候选，实际只有 {len(candidates)} 个"
        )
    names = [candidate.name for candidate in candidates]
    if any(not name for name in names):
        raise ValueError("候选模型名称不能为空")
    if len(set(names)) != len(names):
        raise ValueError("候选模型名称必须唯一")
    if evaluation.selected_name not in set(names):
        raise ValueError("selected_name 必须指向候选模型之一")

    validation_actual = history[
        spec.validation_start_index : spec.holdout_start_index
    ]
    holdout_actual = history[spec.holdout_start_index :]
    uniform_probability = spec.pick_count / spec.pool_size
    validation_uniform = np.full_like(validation_actual, uniform_probability)
    holdout_uniform = np.full_like(holdout_actual, uniform_probability)
    validation_uniform_brier = _brier_score(validation_uniform, validation_actual)
    holdout_uniform_brier = _brier_score(holdout_uniform, holdout_actual)

    candidate_statistics: dict[str, dict[str, float]] = {}
    for candidate in candidates:
        validation_probabilities = _validate_probabilities(
            candidate_name=candidate.name,
            split_name="validation",
            probabilities=candidate.validation_probabilities,
            expected_shape=(spec.validation_count, spec.pool_size),
            pick_count=spec.pick_count,
            probability_sum_tolerance=probability_sum_tolerance,
        )
        holdout_probabilities = _validate_probabilities(
            candidate_name=candidate.name,
            split_name="holdout",
            probabilities=candidate.holdout_probabilities,
            expected_shape=(spec.holdout_count, spec.pool_size),
            pick_count=spec.pick_count,
            probability_sum_tolerance=probability_sum_tolerance,
        )
        validation_brier = _brier_score(
            validation_probabilities,
            validation_actual,
        )
        holdout_brier = _brier_score(holdout_probabilities, holdout_actual)
        candidate_statistics[candidate.name] = {
            "validation_brier": validation_brier,
            "holdout_brier": holdout_brier,
            "validation_brier_skill": _brier_skill(
                validation_brier,
                validation_uniform_brier,
            ),
            "holdout_brier_skill": _brier_skill(
                holdout_brier,
                holdout_uniform_brier,
            ),
        }

    validation_skills = [
        values["validation_brier_skill"]
        for values in candidate_statistics.values()
    ]
    holdout_skills = [
        values["holdout_brier_skill"] for values in candidate_statistics.values()
    ]
    selected = candidate_statistics[evaluation.selected_name]
    standard_statistics = {
        "max_validation_brier_skill": max(validation_skills),
        "max_holdout_brier_skill": max(holdout_skills),
        "selected_validation_brier_skill": selected["validation_brier_skill"],
        "selected_holdout_brier_skill": selected["holdout_brier_skill"],
        "selection_optimism_brier_skill": (
            selected["validation_brier_skill"] - selected["holdout_brier_skill"]
        ),
        "holdout_winner_gap_brier_skill": (
            max(holdout_skills) - selected["holdout_brier_skill"]
        ),
    }

    for name, raw_value in evaluation.extra_statistics.items():
        if name in standard_statistics:
            raise ValueError(f"额外统计量与标准统计量重名: {name}")
        value = float(raw_value)
        if not math.isfinite(value):
            raise ValueError(f"额外统计量必须为有限值: {name}")
        standard_statistics[name] = value

    return PipelineStatistics(
        selected_name=evaluation.selected_name,
        candidate_count=len(candidates),
        statistics=standard_statistics,
        candidate_statistics=candidate_statistics,
    )


def evaluate_pipeline_history(
    history: np.ndarray,
    spec: FairHistorySpec,
    evaluator: PipelineEvaluator,
    *,
    evaluator_seed: int = 0,
    replicate_index: int = -1,
    minimum_candidate_count: int = 2,
    probability_sum_tolerance: float = 1e-6,
) -> PipelineStatistics:
    """Run and score the complete pipeline on one observed or null history."""

    if minimum_candidate_count < 2:
        raise ValueError("minimum_candidate_count 不得小于 2")
    if probability_sum_tolerance <= 0.0:
        raise ValueError("probability_sum_tolerance 必须大于 0")
    values = _validate_history(history, spec)
    evaluator_history = values.copy()
    evaluator_history.setflags(write=False)
    context = PipelineContext(
        spec=spec,
        replicate_index=replicate_index,
        evaluator_seed=int(evaluator_seed),
    )
    evaluation = evaluator(
        evaluator_history,
        context,
        np.random.default_rng(evaluator_seed),
    )
    if not isinstance(evaluation, PipelineEvaluation):
        raise TypeError("pipeline evaluator 必须返回 PipelineEvaluation")
    return _statistics_from_evaluation(
        history=values,
        spec=spec,
        evaluation=evaluation,
        minimum_candidate_count=minimum_candidate_count,
        probability_sum_tolerance=probability_sum_tolerance,
    )


def _run_simulation_task(task: _SimulationTask) -> _SimulationResult:
    history = generate_fair_history(
        task.spec,
        np.random.default_rng(task.history_seed),
    )
    result = evaluate_pipeline_history(
        history,
        task.spec,
        task.evaluator,
        evaluator_seed=task.evaluator_seed,
        replicate_index=task.replicate_index,
        minimum_candidate_count=task.minimum_candidate_count,
        probability_sum_tolerance=task.probability_sum_tolerance,
    )
    return _SimulationResult(
        replicate_index=task.replicate_index,
        selected_name=result.selected_name,
        statistics=result.statistics,
    )


def _simulation_seeds(seed: int, repetitions: int) -> list[tuple[int, int]]:
    root = np.random.SeedSequence(seed)
    result: list[tuple[int, int]] = []
    for child in root.spawn(repetitions):
        history_child, evaluator_child = child.spawn(2)
        history_seed = int(
            history_child.generate_state(1, dtype=np.uint64)[0]
        )
        evaluator_seed = int(
            evaluator_child.generate_state(1, dtype=np.uint64)[0]
        )
        result.append((history_seed, evaluator_seed))
    return result


def _quantile_key(value: float) -> str:
    return f"{value:.6g}"


def _summarize_distribution(
    values: Sequence[float],
    quantile_levels: Sequence[float],
    observed: float | None,
) -> NullStatisticSummary:
    array = np.asarray(values, dtype=float)
    if array.size == 0:
        raise ValueError("零分布不能为空")
    empirical_p_value = None
    if observed is not None:
        exceedances = int(np.count_nonzero(array >= observed))
        empirical_p_value = (exceedances + 1.0) / (len(array) + 1.0)
    return NullStatisticSummary(
        count=len(array),
        mean=float(array.mean()),
        standard_deviation=(
            float(array.std(ddof=1)) if len(array) > 1 else 0.0
        ),
        minimum=float(array.min()),
        maximum=float(array.max()),
        quantiles={
            _quantile_key(level): float(np.quantile(array, level))
            for level in quantile_levels
        },
        observed=observed,
        empirical_p_value=empirical_p_value,
    )


def familywise_max_t_p_values(
    observed_values: Sequence[float],
    null_distributions: Sequence[Sequence[float]],
) -> tuple[np.ndarray, float, np.ndarray]:
    """Adjust upper-tail p-values by the maximum across a result family."""

    observed = np.asarray(observed_values, dtype=float)
    null_values = np.asarray(null_distributions, dtype=float)
    if observed.ndim != 1 or observed.size == 0:
        raise ValueError("observed_values 必须是一维非空数组")
    if null_values.ndim != 2 or null_values.shape[0] != observed.size:
        raise ValueError("null_distributions 必须按 family × repetitions 排列")
    if null_values.shape[1] == 0:
        raise ValueError("null_distributions 至少需要一次重复")
    if not np.all(np.isfinite(observed)) or not np.all(np.isfinite(null_values)):
        raise ValueError("observed_values 和 null_distributions 必须全部有限")

    global_null = np.max(null_values, axis=0)
    denominator = global_null.size + 1.0
    adjusted = np.asarray(
        [
            (1.0 + float(np.count_nonzero(global_null >= value))) / denominator
            for value in observed
        ],
        dtype=float,
    )
    global_observed = float(np.max(observed))
    global_p_value = (
        1.0 + float(np.count_nonzero(global_null >= global_observed))
    ) / denominator
    return adjusted, global_p_value, global_null


def run_pipeline_null(
    spec: FairHistorySpec,
    evaluator: PipelineEvaluator,
    *,
    mode: Literal["quick", "full"] = "quick",
    repetitions: int | None = None,
    seed: int = 20260721,
    observed_statistics: Mapping[str, float] | PipelineStatistics | None = None,
    workers: int = 1,
    backend: Literal["sequential", "thread", "process"] = "sequential",
    batch_size: int | None = None,
    quantile_levels: Sequence[float] = (0.50, 0.90, 0.95, 0.99),
    minimum_candidate_count: int = 2,
    probability_sum_tolerance: float = 1e-6,
    progress_callback: Callable[[int, int], None] | None = None,
) -> NullSimulationReport:
    """Rerun the full evaluator on fair histories and build max-stat nulls.

    ``thread`` supports closures but requires a thread-safe evaluator. ``process``
    is appropriate for CPU-heavy pure evaluators, which must then be picklable
    and invoked from a normal ``if __name__ == "__main__"`` entry point on
    spawn-based platforms. Batches bound in-flight work and provide
    deterministic progress callbacks.
    """

    default_repetitions = repetitions_for_mode(mode)
    simulation_count = default_repetitions if repetitions is None else repetitions
    if simulation_count <= 0:
        raise ValueError("repetitions 必须大于 0")
    if workers <= 0:
        raise ValueError("workers 必须大于 0")
    if backend not in {"sequential", "thread", "process"}:
        raise ValueError("backend 必须是 sequential、thread 或 process")
    if workers > 1 and backend == "sequential":
        raise ValueError("workers > 1 时必须选择 thread 或 process backend")
    if minimum_candidate_count < 2:
        raise ValueError("minimum_candidate_count 不得小于 2")
    if probability_sum_tolerance <= 0.0:
        raise ValueError("probability_sum_tolerance 必须大于 0")

    levels = tuple(sorted(set(float(level) for level in quantile_levels)))
    if not levels or any(not 0.0 < level < 1.0 for level in levels):
        raise ValueError("quantile_levels 必须包含 (0, 1) 内的值")
    actual_batch_size = (
        min(simulation_count, 25 if mode == "quick" else 50)
        if batch_size is None
        else batch_size
    )
    if actual_batch_size <= 0:
        raise ValueError("batch_size 必须大于 0")

    if isinstance(observed_statistics, PipelineStatistics):
        observed = {
            name: float(value)
            for name, value in observed_statistics.statistics.items()
        }
    elif observed_statistics is None:
        observed = {}
    else:
        observed = {
            name: float(value) for name, value in observed_statistics.items()
        }
    if any(not math.isfinite(value) for value in observed.values()):
        raise ValueError("observed_statistics 必须全部为有限值")

    seed_pairs = _simulation_seeds(seed, simulation_count)
    tasks = [
        _SimulationTask(
            spec=spec,
            evaluator=evaluator,
            replicate_index=index,
            history_seed=history_seed,
            evaluator_seed=evaluator_seed,
            minimum_candidate_count=minimum_candidate_count,
            probability_sum_tolerance=probability_sum_tolerance,
        )
        for index, (history_seed, evaluator_seed) in enumerate(seed_pairs)
    ]

    distributions: dict[str, list[float]] = {}
    selected_counts: Counter[str] = Counter()
    expected_statistic_names: tuple[str, ...] | None = None
    completed = 0

    executor_class = {
        "thread": ThreadPoolExecutor,
        "process": ProcessPoolExecutor,
    }.get(backend)
    executor = (
        executor_class(max_workers=workers)
        if executor_class is not None and workers > 1
        else None
    )
    try:
        for start in range(0, simulation_count, actual_batch_size):
            batch = tasks[start : start + actual_batch_size]
            if executor is None:
                batch_results = [_run_simulation_task(task) for task in batch]
            else:
                batch_results = list(executor.map(_run_simulation_task, batch))
            batch_results.sort(key=lambda item: item.replicate_index)
            for result in batch_results:
                statistic_names = tuple(sorted(result.statistics))
                if expected_statistic_names is None:
                    expected_statistic_names = statistic_names
                    distributions = {name: [] for name in statistic_names}
                elif statistic_names != expected_statistic_names:
                    raise ValueError(
                        "pipeline evaluator 在不同重复中返回了不一致的统计量集合"
                    )
                for name in expected_statistic_names:
                    distributions[name].append(float(result.statistics[name]))
                selected_counts[result.selected_name] += 1
            completed += len(batch_results)
            if progress_callback is not None:
                progress_callback(completed, simulation_count)
    finally:
        if executor is not None:
            executor.shutdown(wait=True, cancel_futures=True)

    unknown_observed = sorted(set(observed) - set(distributions))
    if unknown_observed:
        raise ValueError(
            "observed_statistics 包含零分布未生成的统计量: "
            + ", ".join(unknown_observed)
        )
    summaries = {
        name: _summarize_distribution(
            values,
            levels,
            observed.get(name),
        )
        for name, values in distributions.items()
    }
    effective_backend = backend if workers > 1 else "sequential"
    return NullSimulationReport(
        spec=spec,
        mode=mode,
        repetitions=simulation_count,
        seed=seed,
        backend=effective_backend,
        workers=workers,
        batch_size=actual_batch_size,
        minimum_candidate_count=minimum_candidate_count,
        quantile_levels=levels,
        observed_statistics=observed,
        summaries=summaries,
        null_distributions={
            name: tuple(values) for name, values in distributions.items()
        },
        selected_candidate_counts=dict(sorted(selected_counts.items())),
    )
