import unittest

import ssq_db
from v9_predictor import (
    build_v9_filtered,
    full_ticket_key,
    historical_full_ticket_keys,
    red_filter_reasons,
    v9_rng,
)


class V9PredictorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.draws = ssq_db.get_all_draws("ASC")

    def test_v9_enforces_all_fixed_filters_and_zero_overlap(self):
        seen = historical_full_ticket_keys(self.draws)
        tickets, metadata = build_v9_filtered(
            v9_rng("2026080"), self.draws, return_metadata=True)
        self.assertEqual(metadata["red_coverage"], 30)
        self.assertEqual(metadata["blue_coverage"], 5)
        self.assertEqual(metadata["max_red_overlap"], 0)
        self.assertEqual(metadata["max_blue_overlap"], 0)
        previous_blue = self.draws[-1]["b1"]
        for reds, blues in tickets:
            self.assertEqual(red_filter_reasons(reds), [])
            self.assertNotEqual(blues[0], previous_blue)
            self.assertNotIn(full_ticket_key(reds, blues[0]), seen)

    def test_v9_is_reproducible(self):
        left = build_v9_filtered(v9_rng("2026080"), self.draws)
        right = build_v9_filtered(v9_rng("2026080"), self.draws)
        self.assertEqual(left, right)

    def test_known_extreme_red_structures_are_rejected(self):
        self.assertIn(
            "four_or_more_consecutive_reds",
            red_filter_reasons([1, 2, 3, 4, 18, 30]),
        )
        self.assertIn(
            "all_odd_or_all_even",
            red_filter_reasons([2, 6, 10, 18, 24, 32]),
        )


if __name__ == "__main__":
    unittest.main()
