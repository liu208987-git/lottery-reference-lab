from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

import numpy as np


LAB_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB_ROOT / "src"))

from pipeline_null import (  # noqa: E402
    CandidatePredictions,
    FairHistorySpec,
    PipelineContext,
    PipelineEvaluation,
    evaluate_pipeline_history,
    familywise_max_t_p_values,
    generate_fair_history,
    repetitions_for_mode,
    run_pipeline_null,
)


def _past_frequency_probabilities(
    history: np.ndarray,
    pick_count: int,
    prior_strength: float = 8.0,
) -> np.ndarray:
    draw_count, pool_size = history.shape
    p0 = pick_count / pool_size
    probabilities = np.zeros_like(history, dtype=float)
    counts = np.zeros(pool_size, dtype=float)
    for index in range(draw_count):
        probabilities[index] = (
            counts + prior_strength * p0
        ) / (index + prior_strength)
        counts += history[index]
    return probabilities


def toy_pipeline_evaluator(
    history: np.ndarray,
    context: PipelineContext,
    rng: np.random.Generator,
) -> PipelineEvaluation:
    spec = context.spec
    p0 = spec.pick_count / spec.pool_size
    uniform = np.full(history.shape, p0, dtype=float)
    past_frequency = _past_frequency_probabilities(history, spec.pick_count)

    bias = np.linspace(-1.0, 1.0, spec.pool_size)
    bias -= bias.mean()
    bias = bias[rng.permutation(spec.pool_size)]
    bias *= min(p0, 1.0 - p0) * 0.20 / float(np.max(np.abs(bias)))
    fixed_preference = np.tile(p0 + bias, (spec.draw_count, 1))

    candidates = (
        CandidatePredictions.from_full_history("uniform", uniform, context),
        CandidatePredictions.from_full_history(
            "past_frequency",
            past_frequency,
            context,
        ),
        CandidatePredictions.from_full_history(
            "fixed_preference",
            fixed_preference,
            context,
        ),
    )
    validation_actual = history[context.validation_indices]

    def validation_brier(candidate: CandidatePredictions) -> float:
        return float(
            np.mean(
                (candidate.validation_probabilities - validation_actual) ** 2
            )
        )

    selected = min(candidates, key=validation_brier)
    return PipelineEvaluation(candidates=candidates, selected_name=selected.name)


def single_candidate_evaluator(
    history: np.ndarray,
    context: PipelineContext,
    rng: np.random.Generator,
) -> PipelineEvaluation:
    del rng
    p0 = context.spec.pick_count / context.spec.pool_size
    probabilities = np.full(history.shape, p0, dtype=float)
    candidate = CandidatePredictions.from_full_history(
        "already_selected_model",
        probabilities,
        context,
    )
    return PipelineEvaluation(
        candidates=(candidate,),
        selected_name=candidate.name,
    )


class PipelineNullTests(unittest.TestCase):
    def setUp(self) -> None:
        self.spec = FairHistorySpec.from_ratios(
            pool_size=8,
            pick_count=2,
            draw_count=48,
            validation_start_ratio=0.50,
            holdout_start_ratio=0.75,
            label="toy_2_of_8",
        )

    def test_generate_fair_history_is_reproducible_and_fixed_size(self) -> None:
        first = generate_fair_history(self.spec, np.random.default_rng(17))
        second = generate_fair_history(self.spec, np.random.default_rng(17))
        np.testing.assert_array_equal(first, second)
        self.assertEqual(first.shape, (48, 8))
        np.testing.assert_array_equal(first.sum(axis=1), np.full(48, 2.0))
        self.assertTrue(np.all((first == 0.0) | (first == 1.0)))

    def test_full_pipeline_null_is_reproducible_and_serializable(self) -> None:
        observed_history = generate_fair_history(
            self.spec,
            np.random.default_rng(999),
        )
        observed = evaluate_pipeline_history(
            observed_history,
            self.spec,
            toy_pipeline_evaluator,
            evaluator_seed=321,
        )
        first = run_pipeline_null(
            self.spec,
            toy_pipeline_evaluator,
            repetitions=24,
            seed=12345,
            observed_statistics=observed,
            batch_size=5,
        )
        second = run_pipeline_null(
            self.spec,
            toy_pipeline_evaluator,
            repetitions=24,
            seed=12345,
            observed_statistics=observed,
            batch_size=5,
        )
        self.assertEqual(first.to_dict(), second.to_dict())
        payload = json.loads(first.to_json())
        self.assertEqual(payload["simulation"]["repetitions"], 24)
        self.assertEqual(sum(payload["selected_candidate_counts"].values()), 24)
        self.assertEqual(
            len(payload["null_distributions"]["max_holdout_brier_skill"]),
            24,
        )
        self.assertEqual(
            set(payload["summaries"]["max_holdout_brier_skill"]["quantiles"]),
            {"0.5", "0.9", "0.95", "0.99"},
        )
        for summary in payload["summaries"].values():
            if summary["empirical_p_value"] is not None:
                self.assertGreaterEqual(summary["empirical_p_value"], 1 / 25)
                self.assertLessEqual(summary["empirical_p_value"], 1.0)

    def test_empirical_p_value_uses_plus_one_correction(self) -> None:
        report = run_pipeline_null(
            self.spec,
            toy_pipeline_evaluator,
            repetitions=9,
            seed=2026,
            observed_statistics={"max_holdout_brier_skill": 10.0},
            batch_size=3,
        )
        self.assertEqual(
            report.summaries[
                "max_holdout_brier_skill"
            ].empirical_p_value,
            0.1,
        )

    def test_familywise_max_t_uses_joint_maximum_and_plus_one(self) -> None:
        adjusted, global_p, global_null = familywise_max_t_p_values(
            [0.4, 0.6],
            [
                [0.1, 0.5, 0.2, 0.3],
                [0.2, 0.4, 0.7, 0.1],
            ],
        )
        np.testing.assert_allclose(global_null, [0.2, 0.5, 0.7, 0.3])
        np.testing.assert_allclose(adjusted, [0.6, 0.4])
        self.assertEqual(global_p, 0.4)

    def test_thread_batches_match_sequential_results(self) -> None:
        sequential = run_pipeline_null(
            self.spec,
            toy_pipeline_evaluator,
            repetitions=18,
            seed=77,
            batch_size=4,
        )
        threaded = run_pipeline_null(
            self.spec,
            toy_pipeline_evaluator,
            repetitions=18,
            seed=77,
            workers=3,
            backend="thread",
            batch_size=4,
        )
        self.assertEqual(
            sequential.null_distributions,
            threaded.null_distributions,
        )
        self.assertEqual(
            sequential.selected_candidate_counts,
            threaded.selected_candidate_counts,
        )

    def test_single_fixed_model_is_rejected_as_incomplete_pipeline(self) -> None:
        history = generate_fair_history(self.spec, np.random.default_rng(8))
        with self.assertRaisesRegex(ValueError, "完整管线零分布"):
            evaluate_pipeline_history(
                history,
                self.spec,
                single_candidate_evaluator,
            )

    def test_quick_and_full_modes_have_distinct_defaults(self) -> None:
        self.assertLess(
            repetitions_for_mode("quick"),
            repetitions_for_mode("full"),
        )


if __name__ == "__main__":
    unittest.main()
