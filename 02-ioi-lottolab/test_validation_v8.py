from __future__ import annotations

import random
import unittest

from validation_v8 import build_v8_balanced, portfolio_diagnostics


class ValidationV8Tests(unittest.TestCase):
    def test_ssq_is_zero_overlap_and_reproducible(self):
        args = ([], 33, 6, 16, 1, 5)
        first = build_v8_balanced(random.Random(7), *args)
        second = build_v8_balanced(random.Random(7), *args)
        self.assertEqual(first, second)
        self.assertEqual(
            portfolio_diagnostics(first),
            {
                "red_coverage": 30,
                "blue_coverage": 5,
                "max_red_overlap": 0,
                "max_blue_overlap": 0,
            },
        )

    def test_dlt_is_zero_overlap(self):
        tickets = build_v8_balanced(
            random.Random(11), [], 35, 5, 12, 2, 5)
        self.assertEqual(
            portfolio_diagnostics(tickets),
            {
                "red_coverage": 25,
                "blue_coverage": 10,
                "max_red_overlap": 0,
                "max_blue_overlap": 0,
            },
        )
        self.assertEqual(len({tuple(blues) for _, blues in tickets}), 5)

    def test_rejects_impossible_zero_overlap_request(self):
        with self.assertRaises(ValueError):
            build_v8_balanced(random.Random(1), [], 20, 6, 16, 1, 5)


if __name__ == "__main__":
    unittest.main()
