from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np


LAB_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB_ROOT / "src"))

from p0_reporting import (  # noqa: E402
    max_abs_lag1_correlation,
    mean_adjacent_overlap,
    run_p0_period_audit,
)


class P0ReportingTests(unittest.TestCase):
    def test_temporal_statistics_and_suite_are_reproducible(self) -> None:
        rng = np.random.default_rng(5)
        values = np.zeros((60, 10), dtype=float)
        for row in range(len(values)):
            values[row, rng.choice(10, 3, replace=False)] = 1.0
        self.assertGreaterEqual(mean_adjacent_overlap(values), 0.0)
        self.assertGreaterEqual(max_abs_lag1_correlation(values), 0.0)
        first = run_p0_period_audit(values, permutations=19, seed=11)
        second = run_p0_period_audit(values, permutations=19, seed=11)
        self.assertEqual(
            first.adjacent_overlap.p_value,
            second.adjacent_overlap.p_value,
        )
        np.testing.assert_array_equal(
            first.pair_cooccurrence.max_t_p_values,
            second.pair_cooccurrence.max_t_p_values,
        )


if __name__ == "__main__":
    unittest.main()
