from __future__ import annotations

import json
import sys
import unittest
from collections import Counter
from pathlib import Path

import numpy as np


LAB_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB_ROOT / "src"))

from null_audit import (  # noqa: E402
    AuditConfig,
    benjamini_hochberg,
    cusum_change_point_test,
    order_statistic_q_audit,
    pair_cooccurrence_audit,
    run_null_audit,
    shuffle_whole_draws,
    whole_draw_shuffle_test,
)


def make_random_matrix(
    draw_count: int, pool_size: int, pick_count: int, seed: int
) -> np.ndarray:
    rng = np.random.default_rng(seed)
    matrix = np.zeros((draw_count, pool_size), dtype=np.float64)
    for row in range(draw_count):
        matrix[row, rng.choice(pool_size, size=pick_count, replace=False)] = 1.0
    return matrix


class NullAuditTests(unittest.TestCase):
    def test_fixed_seed_makes_full_audit_reproducible(self) -> None:
        matrix = make_random_matrix(36, 10, 3, seed=7)
        config = AuditConfig(
            permutations=23,
            seed=41,
            batch_size=5,
            min_segment=5,
        )

        first = run_null_audit(matrix, config=config)
        second = run_null_audit(matrix, config=config)

        self.assertEqual(first.to_dict(), second.to_dict())
        json.dumps(first.to_dict())

    def test_whole_draw_shuffle_preserves_complete_rows(self) -> None:
        matrix = np.asarray(
            [
                [1, 1, 0, 0, 0, 0],
                [0, 1, 1, 0, 0, 0],
                [0, 0, 1, 1, 0, 0],
                [0, 0, 0, 1, 1, 0],
                [0, 0, 0, 0, 1, 1],
            ],
            dtype=np.float64,
        )
        shuffled = shuffle_whole_draws(matrix, rng=np.random.default_rng(9))

        self.assertEqual(
            Counter(map(tuple, matrix)),
            Counter(map(tuple, shuffled)),
        )
        np.testing.assert_array_equal(shuffled.sum(axis=1), np.full(5, 2.0))

        statistic = lambda values: float(np.sum(values[:-1] * values[1:]))
        first = whole_draw_shuffle_test(
            matrix, statistic, permutations=31, seed=17
        )
        second = whole_draw_shuffle_test(
            matrix, statistic, permutations=31, seed=17
        )
        self.assertEqual(first.p_value, second.p_value)
        np.testing.assert_array_equal(
            first.null_distribution, second.null_distribution
        )

    def test_benjamini_hochberg_q_values_are_valid_and_monotone(self) -> None:
        p_values = np.asarray([0.01, 0.04, 0.03, 0.002, 0.8])
        q_values, rejected = benjamini_hochberg(p_values, alpha=0.05)

        self.assertTrue(np.all((0.0 <= q_values) & (q_values <= 1.0)))
        order = np.argsort(p_values)
        self.assertTrue(np.all(np.diff(q_values[order]) >= -1e-15))
        np.testing.assert_allclose(q_values, [0.025, 0.05, 0.05, 0.01, 0.8])
        np.testing.assert_array_equal(rejected, q_values <= 0.05)

    def test_planted_pair_is_detected_by_bh_and_max_t(self) -> None:
        rng = np.random.default_rng(12)
        matrix = np.zeros((160, 12), dtype=np.float64)
        for row in range(matrix.shape[0]):
            matrix[row, :2] = 1.0
            matrix[row, rng.choice(np.arange(2, 12), size=2, replace=False)] = 1.0

        result = pair_cooccurrence_audit(
            matrix,
            permutations=99,
            seed=5,
            batch_size=11,
        )
        pair_index = int(
            np.flatnonzero(np.all(result.pairs == np.asarray([1, 2]), axis=1))[0]
        )

        self.assertTrue(result.bh_rejected[pair_index])
        self.assertTrue(result.max_t_rejected[pair_index])
        self.assertLessEqual(result.max_t_p_values[pair_index], 0.05)
        self.assertGreater(result.observed_counts[pair_index], result.expected_count)

    def test_single_pick_pair_audit_is_well_defined(self) -> None:
        matrix = make_random_matrix(30, 6, 1, seed=4)
        result = pair_cooccurrence_audit(
            matrix, permutations=19, seed=2, batch_size=7
        )

        np.testing.assert_array_equal(result.z_scores, np.zeros(15))
        np.testing.assert_array_equal(result.raw_p_values, np.ones(15))
        np.testing.assert_array_equal(result.max_t_p_values, np.ones(15))

    def test_extreme_order_statistics_produce_large_q(self) -> None:
        matrix = np.zeros((80, 12), dtype=np.float64)
        matrix[:, :3] = 1.0

        result = order_statistic_q_audit(
            matrix,
            permutations=99,
            seed=23,
            batch_size=10,
        )

        np.testing.assert_array_equal(result.sample_means, [1.0, 2.0, 3.0])
        np.testing.assert_allclose(result.theoretical_means, [3.25, 6.5, 9.75])
        self.assertGreater(result.q_statistic, 100.0)
        self.assertEqual(result.p_value, 0.01)

    def test_cusum_finds_planted_change_point(self) -> None:
        values = np.concatenate((np.zeros(60), np.ones(60)))

        result = cusum_change_point_test(
            values,
            permutations=199,
            seed=29,
            min_segment=15,
        )

        self.assertEqual(result.change_point, 60)
        self.assertEqual(result.feature_index, 0)
        self.assertLessEqual(result.p_value, 0.01)

    def test_invalid_inputs_fail_explicitly(self) -> None:
        valid = make_random_matrix(20, 8, 2, seed=3)
        non_binary = valid.copy()
        non_binary[0, 0] = 0.5
        inconsistent = valid.copy()
        inconsistent[0] = 0.0

        with self.assertRaisesRegex(ValueError, "binary"):
            pair_cooccurrence_audit(non_binary, permutations=9)
        with self.assertRaisesRegex(ValueError, "same number"):
            order_statistic_q_audit(inconsistent, permutations=9)
        with self.assertRaisesRegex(ValueError, "permutations"):
            whole_draw_shuffle_test(valid, np.sum, permutations=0)
        with self.assertRaisesRegex(ValueError, "does not match"):
            pair_cooccurrence_audit(valid, pool_size=9, permutations=9)
        with self.assertRaisesRegex(ValueError, r"2 \* min_segment"):
            cusum_change_point_test(np.arange(10), permutations=9, min_segment=6)
        with self.assertRaisesRegex(ValueError, "fdr_alpha"):
            pair_cooccurrence_audit(valid, permutations=9, fdr_alpha=0.0)
        with self.assertRaisesRegex(ValueError, "p_values"):
            benjamini_hochberg([0.2, 1.1])


if __name__ == "__main__":
    unittest.main()
