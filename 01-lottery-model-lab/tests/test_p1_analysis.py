from __future__ import annotations

import itertools
import math
import sys
import unittest
from pathlib import Path

import numpy as np


LAB_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB_ROOT / "src"))

from p1_analysis import (  # noqa: E402
    brier_decomposition,
    calibration_bins,
    candidate_brier_loss_matrix,
    conditional_bernoulli_log_normalizer,
    conditional_bernoulli_log_probability,
    conditional_bernoulli_nll,
    moving_block_bootstrap,
    moving_block_bootstrap_brier_difference,
    nested_rolling_select,
    per_draw_brier_difference,
)


class ConditionalBernoulliTests(unittest.TestCase):
    def test_log_normalizer_and_combination_probabilities_match_brute_force(self) -> None:
        log_weights = np.asarray([-0.8, 0.1, 0.9, -0.2, 0.4])
        pick_count = 2
        combinations = list(itertools.combinations(range(len(log_weights)), pick_count))
        brute_terms = np.asarray(
            [sum(log_weights[index] for index in combination) for combination in combinations]
        )
        maximum = float(brute_terms.max())
        expected_log_normalizer = maximum + math.log(
            float(np.exp(brute_terms - maximum).sum())
        )

        actual_log_normalizer = conditional_bernoulli_log_normalizer(
            log_weights,
            pick_count,
        )
        self.assertAlmostEqual(actual_log_normalizer, expected_log_normalizer, places=14)

        selections = np.zeros((len(combinations), len(log_weights)))
        for row_index, combination in enumerate(combinations):
            selections[row_index, list(combination)] = 1.0
        log_probabilities = conditional_bernoulli_log_probability(
            log_weights,
            selections,
        )
        self.assertAlmostEqual(float(np.exp(log_probabilities).sum()), 1.0, places=14)
        np.testing.assert_allclose(
            log_probabilities,
            brute_terms - expected_log_normalizer,
            atol=1e-14,
            rtol=0.0,
        )

    def test_extreme_log_weights_are_stable_and_shift_invariant(self) -> None:
        log_weights = np.asarray([-1000.0, -250.0, 0.0, 400.0, 999.0])
        selection = np.asarray([0, 0, 0, 1, 1])
        shifted = log_weights + 723.5

        first = conditional_bernoulli_log_probability(log_weights, selection)
        second = conditional_bernoulli_log_probability(shifted, selection)

        self.assertTrue(math.isfinite(first))
        self.assertAlmostEqual(first, second, places=12)
        batch = conditional_bernoulli_log_normalizer(
            np.stack([log_weights, shifted]),
            2,
        )
        self.assertEqual(batch.shape, (2,))
        self.assertAlmostEqual(float(batch[1] - batch[0]), 2 * 723.5, places=12)

        integer_weights = np.arange(5.0)
        top_two = np.asarray([0, 0, 0, 1, 1])
        baseline = conditional_bernoulli_log_probability(integer_weights, top_two)
        huge_shift = conditional_bernoulli_log_probability(
            integer_weights + 1.0e12,
            top_two,
        )
        self.assertAlmostEqual(baseline, huge_shift, places=12)

    def test_nll_reductions_are_consistent(self) -> None:
        weights = np.asarray([[0.0, 0.2, -0.3], [0.1, -0.2, 0.4]])
        selections = np.asarray([[1, 1, 0], [0, 1, 1]])
        losses = conditional_bernoulli_nll(
            weights,
            selections,
            reduction="none",
        )

        self.assertEqual(losses.shape, (2,))
        self.assertAlmostEqual(
            conditional_bernoulli_nll(weights, selections, reduction="mean"),
            float(losses.mean()),
        )
        self.assertAlmostEqual(
            conditional_bernoulli_nll(weights, selections, reduction="sum"),
            float(losses.sum()),
        )

    def test_conditional_bernoulli_inputs_fail_explicitly(self) -> None:
        with self.assertRaisesRegex(ValueError, "finite"):
            conditional_bernoulli_log_normalizer([0.0, math.nan], 1)
        with self.assertRaisesRegex(ValueError, "pick_count"):
            conditional_bernoulli_log_normalizer([0.0, 1.0], 3)
        with self.assertRaisesRegex(ValueError, "binary"):
            conditional_bernoulli_log_probability([0.0, 1.0], [0.5, 0.5])
        with self.assertRaisesRegex(ValueError, "exactly pick_count"):
            conditional_bernoulli_log_probability(
                [0.0, 1.0, 2.0],
                [1, 0, 0],
                pick_count=2,
            )
        with self.assertRaisesRegex(ValueError, "reduction"):
            conditional_bernoulli_nll([0.0, 1.0], [1, 0], reduction="median")


class NestedRollingSelectionTests(unittest.TestCase):
    def test_every_inner_fold_precedes_untouched_outer_window(self) -> None:
        calls: list[tuple[int, np.ndarray, np.ndarray]] = []

        def evaluator(
            candidate: int,
            train_indices: np.ndarray,
            validation_indices: np.ndarray,
        ) -> float:
            self.assertFalse(train_indices.flags.writeable)
            self.assertFalse(validation_indices.flags.writeable)
            calls.append((candidate, train_indices.copy(), validation_indices.copy()))
            return float(candidate)

        result = nested_rolling_select(
            [2, 0, 1],
            24,
            evaluator,
            outer_start=12,
            min_train_size=5,
            validation_size=3,
            outer_test_size=2,
            outer_step=3,
            inner_step=2,
            max_inner_folds=2,
        )

        self.assertEqual(result.selected_candidates, (0, 0, 0, 0))
        self.assertEqual(len(calls), len(result.decisions) * 3 * 2)
        for decision in result.decisions:
            self.assertLessEqual(decision.test_end, 24)
            self.assertEqual(decision.selected_candidate_index, 1)
            for fold in decision.inner_folds:
                self.assertEqual(fold.train_start, 0)
                self.assertEqual(fold.train_end, fold.validation_start)
                self.assertLessEqual(fold.validation_end, decision.test_start)
                self.assertLess(
                    int(fold.validation_indices.max()),
                    int(decision.test_indices.min()),
                )

    def test_fixed_training_window_and_score_direction_are_supported(self) -> None:
        result = nested_rolling_select(
            ["small", "large"],
            15,
            lambda candidate, train, validation: (
                1.0 if candidate == "large" else 0.0
            ),
            outer_start=10,
            min_train_size=4,
            validation_size=2,
            train_window=4,
            max_inner_folds=1,
            higher_is_better=True,
        )

        self.assertTrue(all(item.selected_candidate == "large" for item in result.decisions))
        for decision in result.decisions:
            fold = decision.inner_folds[0]
            self.assertEqual(fold.train_end - fold.train_start, 4)

    def test_precomputed_losses_and_probabilities_use_only_past_validation_rows(self) -> None:
        losses = np.asarray(
            [
                [0.1] * 8 + [100.0] * 4,
                [0.2] * 8 + [0.0] * 4,
            ]
        )
        from_losses = nested_rolling_select(
            ["stable", "future_only"],
            12,
            candidate_losses=losses,
            outer_start=8,
            min_train_size=4,
            validation_size=2,
            outer_test_size=1,
            outer_step=4,
        )
        self.assertEqual(from_losses.decisions[0].selected_candidate, "stable")

        outcomes = np.tile(np.asarray([[1.0, 0.0]]), (12, 1))
        stable = np.tile(np.asarray([[0.8, 0.2]]), (12, 1))
        weaker = np.tile(np.asarray([[0.6, 0.4]]), (12, 1))
        probability_tensor = np.stack([stable, weaker])
        expected_losses = candidate_brier_loss_matrix(probability_tensor, outcomes)
        np.testing.assert_allclose(expected_losses[0], np.full(12, 0.04))
        np.testing.assert_allclose(expected_losses[1], np.full(12, 0.16))
        from_probabilities = nested_rolling_select(
            ["stable", "weaker"],
            12,
            candidate_probabilities=probability_tensor,
            outcomes=outcomes,
            outer_start=8,
            min_train_size=4,
            validation_size=2,
            outer_step=4,
        )
        self.assertEqual(from_probabilities.selected_candidates, ("stable",))

    def test_nested_rolling_invalid_inputs_and_scores_fail(self) -> None:
        with self.assertRaisesRegex(ValueError, "outer_start"):
            nested_rolling_select(
                [1],
                10,
                lambda candidate, train, validation: 0.0,
                outer_start=5,
                min_train_size=4,
                validation_size=2,
            )
        with self.assertRaisesRegex(ValueError, "finite"):
            nested_rolling_select(
                [1],
                10,
                lambda candidate, train, validation: math.nan,
                outer_start=6,
                min_train_size=4,
                validation_size=2,
            )
        with self.assertRaisesRegex(ValueError, "train_window"):
            nested_rolling_select(
                [1],
                10,
                lambda candidate, train, validation: 0.0,
                outer_start=6,
                min_train_size=4,
                validation_size=2,
                train_window=3,
            )
        with self.assertRaisesRegex(ValueError, "exactly one"):
            nested_rolling_select(
                [1],
                10,
                lambda candidate, train, validation: 0.0,
                candidate_losses=np.zeros((1, 10)),
                outer_start=6,
                min_train_size=4,
                validation_size=2,
            )
        with self.assertRaisesRegex(ValueError, "loss matrix shape"):
            nested_rolling_select(
                [1, 2],
                10,
                candidate_losses=np.zeros((2, 9)),
                outer_start=6,
                min_train_size=4,
                validation_size=2,
            )


class MovingBlockBootstrapTests(unittest.TestCase):
    def test_bootstrap_is_reproducible_with_fixed_seed(self) -> None:
        rng = np.random.default_rng(91)
        innovations = rng.normal(0.0, 0.05, size=80)
        differences = np.empty(80)
        differences[0] = innovations[0]
        for index in range(1, len(differences)):
            differences[index] = 0.65 * differences[index - 1] + innovations[index]

        first = moving_block_bootstrap(
            differences,
            block_length=7,
            replicates=199,
            seed=33,
        )
        second = moving_block_bootstrap(
            differences,
            block_length=7,
            replicates=199,
            seed=33,
        )

        self.assertEqual(first.to_dict(), second.to_dict())
        np.testing.assert_array_equal(first.bootstrap_means, second.bootstrap_means)
        np.testing.assert_array_equal(first.null_means, second.null_means)

    def test_probability_wrapper_reports_candidate_minus_reference_difference(self) -> None:
        outcomes = np.tile(np.asarray([[1.0, 0.0, 1.0, 0.0]]), (30, 1))
        candidate = np.where(outcomes == 1.0, 0.8, 0.2)
        reference = np.full_like(outcomes, 0.5)

        differences = per_draw_brier_difference(candidate, reference, outcomes)
        np.testing.assert_allclose(differences, np.full(30, -0.21))
        result = moving_block_bootstrap_brier_difference(
            candidate,
            reference,
            outcomes,
            block_length=4,
            replicates=99,
            seed=8,
        )

        self.assertAlmostEqual(result.mean_difference, -0.21)
        self.assertAlmostEqual(result.ci_low, -0.21)
        self.assertAlmostEqual(result.ci_high, -0.21)
        self.assertEqual(result.p_value_two_sided, 0.01)
        self.assertTrue(result.candidate_is_better)

    def test_bootstrap_inputs_fail_explicitly(self) -> None:
        with self.assertRaisesRegex(ValueError, "at least two"):
            moving_block_bootstrap([0.1])
        with self.assertRaisesRegex(ValueError, "block_length"):
            moving_block_bootstrap([0.1, 0.2], block_length=3)
        with self.assertRaisesRegex(ValueError, "replicates"):
            moving_block_bootstrap([0.1, 0.2], replicates=0)
        with self.assertRaisesRegex(ValueError, "same shape"):
            per_draw_brier_difference([0.2, 0.3], [0.2], [0, 1])
        with self.assertRaisesRegex(ValueError, r"\[0, 1\]"):
            per_draw_brier_difference([1.2, 0.3], [0.2, 0.3], [0, 1])


class CalibrationTests(unittest.TestCase):
    def test_bins_and_brier_decomposition_match_known_example(self) -> None:
        probabilities = np.asarray([0.2] * 4 + [0.8] * 4)
        outcomes = np.asarray([1, 0, 0, 0, 1, 1, 1, 0])

        calibration = calibration_bins(probabilities, outcomes, bin_count=2)
        self.assertEqual([item.count for item in calibration.bins], [4, 4])
        self.assertAlmostEqual(calibration.bins[0].mean_probability, 0.2)
        self.assertAlmostEqual(calibration.bins[0].observed_frequency, 0.25)
        self.assertAlmostEqual(calibration.bins[1].mean_probability, 0.8)
        self.assertAlmostEqual(calibration.bins[1].observed_frequency, 0.75)
        self.assertAlmostEqual(calibration.expected_calibration_error, 0.05)
        self.assertAlmostEqual(calibration.maximum_calibration_error, 0.05)

        result = brier_decomposition(probabilities, outcomes, bin_count=2)
        self.assertAlmostEqual(result.brier_score, 0.19)
        self.assertAlmostEqual(result.reliability, 0.0025)
        self.assertAlmostEqual(result.resolution, 0.0625)
        self.assertAlmostEqual(result.uncertainty, 0.25)
        self.assertAlmostEqual(result.decomposed_brier, 0.19)
        self.assertAlmostEqual(result.decomposition_residual, 0.0, places=14)

    def test_empty_calibration_bins_are_explicit(self) -> None:
        result = calibration_bins([0.05, 0.95], [0, 1], bin_count=4)

        self.assertEqual([item.count for item in result.bins], [1, 0, 0, 1])
        self.assertTrue(math.isnan(result.bins[1].mean_probability))
        self.assertTrue(math.isnan(result.bins[2].observed_frequency))

    def test_calibration_inputs_fail_explicitly(self) -> None:
        with self.assertRaisesRegex(ValueError, "same shape"):
            calibration_bins([0.1, 0.2], [0])
        with self.assertRaisesRegex(ValueError, "binary"):
            brier_decomposition([0.1, 0.2], [0, 0.5])
        with self.assertRaisesRegex(ValueError, "bin_count"):
            calibration_bins([0.1, 0.2], [0, 1], bin_count=0)


if __name__ == "__main__":
    unittest.main()
