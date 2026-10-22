from __future__ import annotations

import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

import numpy as np


LAB_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB_ROOT / "src"))

from lottery_lab import (  # noqa: E402
    Draw,
    GAME_SPECS,
    LunarDate,
    MODEL_GROUPS,
    build_binary_matrix,
    generate_base_predictions,
)
from pipeline_adapter import (  # noqa: E402
    LotteryPipelineEvaluator,
    build_fixed_prediction_cache,
    generate_cached_predictions,
    probabilities_from_score_matrix,
)
from pipeline_null import FairHistorySpec, evaluate_pipeline_history  # noqa: E402


class PipelineAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        start = date(2024, 1, 1)
        self.draws = []
        self.lunar = {}
        for index in range(48):
            current_date = start + timedelta(days=index * 3)
            front = tuple(
                sorted(
                    np.random.default_rng(index).choice(
                        33, size=6, replace=False
                    )
                    + 1
                )
            )
            back = ((index % 16) + 1,)
            self.draws.append(
                Draw(str(2024001 + index), current_date, front, back)
            )
            self.lunar[current_date] = LunarDate(
                cyclical_year=41,
                month=(index % 12) + 1,
                day=(index % 28) + 1,
                is_leap_month=False,
            )

    def test_matrix_probability_projection_matches_rowwise_version(self) -> None:
        from lottery_lab import probabilities_from_scores

        scores = np.random.default_rng(8).normal(size=(20, 11))
        scores[3] = 1.0
        actual = probabilities_from_score_matrix(scores, 3)
        expected = np.stack(
            [probabilities_from_scores(row, 3) for row in scores]
        )
        np.testing.assert_allclose(actual, expected, atol=1e-12, rtol=0.0)

    def test_cached_predictions_match_main_walk_forward_models(self) -> None:
        spec = GAME_SPECS["ssq"]
        actual, expected = generate_base_predictions(
            self.draws,
            spec,
            "front",
            self.lunar,
        )
        cache = build_fixed_prediction_cache(
            self.draws,
            spec,
            "front",
            self.lunar,
        )
        cached = generate_cached_predictions(actual, cache)
        self.assertEqual(set(cached), set(expected))
        np.testing.assert_array_equal(
            actual,
            build_binary_matrix(self.draws, "front", spec.front_pool),
        )
        for name in expected:
            np.testing.assert_allclose(
                cached[name]["scores"],
                expected[name]["scores"],
                atol=1e-10,
                rtol=0.0,
                err_msg=f"scores mismatch for {name}",
            )
            np.testing.assert_allclose(
                cached[name]["probabilities"],
                expected[name]["probabilities"],
                atol=1e-10,
                rtol=0.0,
                err_msg=f"probability mismatch for {name}",
            )

    def test_cached_predictions_match_custom_p1_parameters(self) -> None:
        spec = GAME_SPECS["ssq"]
        parameters = {
            "bayesian_all": {"prior_strength": 6.0},
            "bayesian_recent_120": {
                "prior_strength": 48.0,
                "window": 60,
            },
            "exp_decay_60": {
                "prior_strength": 12.0,
                "half_life": 120.0,
            },
        }
        actual, expected = generate_base_predictions(
            self.draws,
            spec,
            "front",
            self.lunar,
            model_parameters=parameters,
        )
        cache = build_fixed_prediction_cache(
            self.draws,
            spec,
            "front",
            self.lunar,
        )
        cached = generate_cached_predictions(
            actual,
            cache,
            model_parameters=parameters,
        )
        for name in expected:
            np.testing.assert_allclose(
                cached[name]["probabilities"],
                expected[name]["probabilities"],
                atol=1e-10,
                rtol=0.0,
                err_msg=f"custom parameter mismatch for {name}",
            )

    def test_fixed_ga_seed_makes_pipeline_match_registered_run(self) -> None:
        spec = GAME_SPECS["ssq"]
        actual, _ = generate_base_predictions(
            self.draws,
            spec,
            "front",
            self.lunar,
        )
        cache = build_fixed_prediction_cache(
            self.draws,
            spec,
            "front",
            self.lunar,
        )
        fair_spec = FairHistorySpec(
            pool_size=spec.front_pool,
            pick_count=spec.front_pick,
            draw_count=len(self.draws),
            validation_start_index=24,
            holdout_start_index=36,
            label="fixed-seed-test",
        )
        evaluator = LotteryPipelineEvaluator(
            cache=cache,
            ga_population=8,
            ga_generations=3,
            ga_seed=12345,
        )
        first = evaluate_pipeline_history(
            actual,
            fair_spec,
            evaluator,
            evaluator_seed=1,
            minimum_candidate_count=len(MODEL_GROUPS),
        )
        second = evaluate_pipeline_history(
            actual,
            fair_spec,
            evaluator,
            evaluator_seed=999,
            minimum_candidate_count=len(MODEL_GROUPS),
        )
        self.assertEqual(first.selected_name, "ga_ensemble")
        self.assertEqual(first.statistics, second.statistics)


if __name__ == "__main__":
    unittest.main()
