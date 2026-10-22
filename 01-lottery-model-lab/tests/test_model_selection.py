from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np


LAB_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB_ROOT / "src"))

from model_selection import (  # noqa: E402
    P1_PARAMETER_GRIDS,
    select_p1_hyperparameters,
    tunable_probability_candidates,
)


class ModelSelectionTests(unittest.TestCase):
    def setUp(self) -> None:
        rng = np.random.default_rng(82)
        self.actual = np.zeros((80, 14), dtype=float)
        for row in self.actual:
            row[rng.choice(14, size=3, replace=False)] = 1.0

    def test_candidate_probabilities_are_walk_forward_and_sum_to_pick_count(self) -> None:
        for model_name, grid in P1_PARAMETER_GRIDS.items():
            probabilities = tunable_probability_candidates(
                self.actual,
                3,
                model_name,
                grid,
            )
            self.assertEqual(
                probabilities.shape,
                (len(grid), len(self.actual), self.actual.shape[1]),
            )
            np.testing.assert_allclose(probabilities.sum(axis=2), 3.0, atol=1e-10)

            changed = self.actual.copy()
            changed[41:] = np.roll(changed[41:], 1, axis=1)
            changed_probabilities = tunable_probability_candidates(
                changed,
                3,
                model_name,
                grid,
            )
            np.testing.assert_allclose(
                probabilities[:, 41],
                changed_probabilities[:, 41],
                atol=1e-12,
                rtol=0.0,
            )

    def test_selection_ignores_outer_validation_and_holdout_rows(self) -> None:
        first = select_p1_hyperparameters(self.actual, 3, 48)
        changed = self.actual.copy()
        changed[48:] = np.roll(changed[48:], 2, axis=1)
        second = select_p1_hyperparameters(changed, 3, 48)
        self.assertEqual(first.parameters, second.parameters)
        self.assertEqual(first.audit_rows, second.audit_rows)
        self.assertTrue(all(row["inner_fold_count"] <= 5 for row in first.audit_rows))


if __name__ == "__main__":
    unittest.main()
