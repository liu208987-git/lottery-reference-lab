import unittest

from v10_predictor import (
    FAVORABLE_OUTCOMES_PER_TICKET,
    build_v10_high_prize,
    high_prize_favorable_outcomes,
    v10_rng,
)


class V10PredictorTests(unittest.TestCase):
    def test_ten_ticket_portfolio_reaches_high_prize_union_upper_bound(self):
        tickets, metadata = build_v10_high_prize(
            v10_rng("2026080"), return_metadata=True)
        self.assertEqual(len(tickets), 10)
        self.assertEqual(metadata["blue_coverage"], 10)
        self.assertLessEqual(metadata["max_red_overlap"], 3)
        self.assertEqual(
            high_prize_favorable_outcomes(tickets),
            10 * FAVORABLE_OUTCOMES_PER_TICKET,
        )
        self.assertTrue(metadata["upper_bound_achieved"])

    def test_v10_is_reproducible(self):
        left = build_v10_high_prize(v10_rng("2026080"))
        right = build_v10_high_prize(v10_rng("2026080"))
        self.assertEqual(left, right)


if __name__ == "__main__":
    unittest.main()
