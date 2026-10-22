import unittest

import numpy as np

import ssq_db
from ssq_exogenous_model import (
    BLUE_PICK,
    BLUE_POOL,
    RED_PICK,
    RED_POOL,
    build_feature_dataset,
    run_research,
)


class SsqExogenousTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = ssq_db.get_all_draws("ASC")

    def test_feature_generation_has_no_future_dependency(self):
        full = build_feature_dataset(
            self.rows, pool_size=RED_POOL, pick_count=RED_PICK, prefix="r")
        truncated = build_feature_dataset(
            self.rows[:500], pool_size=RED_POOL, pick_count=RED_PICK, prefix="r")
        np.testing.assert_allclose(full.x[:350], truncated.x)
        np.testing.assert_allclose(full.y[:350], truncated.y)

    def test_research_probabilities_and_tickets(self):
        result = run_research(self.rows, ticket_count=5)
        self.assertAlmostEqual(
            sum(result["red"]["next_probabilities"].values()), RED_PICK)
        self.assertAlmostEqual(
            sum(result["blue"]["next_probabilities"].values()), BLUE_PICK)
        self.assertEqual(len(result["tickets"]), 5)
        for reds, blues in result["tickets"]:
            self.assertEqual(len(set(reds)), RED_PICK)
            self.assertEqual(len(set(blues)), BLUE_PICK)
            self.assertTrue(all(1 <= number <= RED_POOL for number in reds))
            self.assertTrue(all(1 <= number <= BLUE_POOL for number in blues))


if __name__ == "__main__":
    unittest.main()

