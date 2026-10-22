import math
import unittest

from v12_predictor import (
    V12OnlineForecaster,
    build_v12_portfolio,
    v12_rng,
)


def draw(issue, reds, blue):
    row = {"issue": issue, "b1": blue}
    row.update({f"r{index}": value for index, value in enumerate(reds, 1)})
    return row


class V12PredictorTests(unittest.TestCase):
    def test_probabilities_are_normalized_and_history_is_ordered(self):
        model = V12OnlineForecaster()
        model.observe(draw("2003001", [1, 2, 3, 4, 5, 6], 1))
        model.observe(draw("2003002", [7, 8, 9, 10, 11, 12], 2))
        red, blue, metadata = model.probabilities()
        self.assertTrue(math.isclose(sum(red), 6.0, abs_tol=1e-10))
        self.assertTrue(math.isclose(sum(blue), 1.0, abs_tol=1e-10))
        self.assertEqual(metadata["history_size"], 2)
        with self.assertRaises(ValueError):
            model.observe(draw("2003002", [1, 2, 3, 4, 5, 6], 1))

    def test_portfolio_is_reproducible_and_keeps_high_prize_coverage(self):
        red = [6 / 33] * 33
        blue = [1 / 16] * 16
        left, metadata = build_v12_portfolio(
            v12_rng("2026080"), red, blue, return_metadata=True)
        right = build_v12_portfolio(v12_rng("2026080"), red, blue)
        self.assertEqual(left, right)
        self.assertEqual(len(left), 5)
        self.assertEqual(metadata["blue_coverage"], 5)
        self.assertLessEqual(metadata["max_red_overlap"], 3)
        for reds, blues in left:
            self.assertEqual(len(set(reds)), 6)
            self.assertEqual(len(blues), 1)


if __name__ == "__main__":
    unittest.main()
