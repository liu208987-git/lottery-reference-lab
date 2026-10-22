import unittest

import ssq_db
from ssq_adaptive_predictor import (
    ALGORITHM_NAME,
    build_adaptive_portfolio,
    hard_shape_reasons,
    ticket_key,
)


class AdaptiveSsqPredictorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.draws = ssq_db.get_all_draws("ASC")[:500]
        cls.config = {
            "strategy": "stable_coverage_adaptive",
            "portfolio_mode": "coverage",
            "candidate_replicates": 8,
            "soft_penalty_weight": 0.75,
            "rare_rate": 0.01,
            "tail_rate": 0.01,
            "exclude_seen_red": True,
            "exclude_seen_full": True,
        }

    def test_v15_is_deterministic_and_keeps_zero_overlap_coverage(self):
        first, first_meta = build_adaptive_portfolio(
            "2099001", self.draws, self.config
        )
        second, second_meta = build_adaptive_portfolio(
            "2099001", self.draws, self.config
        )
        self.assertEqual(first, second)
        self.assertEqual(first_meta["selected_candidate"], second_meta["selected_candidate"])
        self.assertEqual(ALGORITHM_NAME, first_meta["algorithm"])
        self.assertEqual(
            len({number for reds, _ in first for number in reds}), 30
        )
        self.assertEqual(5, len({blue for _, blues in first for blue in blues}))
        self.assertEqual(0, first_meta["portfolio"]["max_red_overlap"])
        self.assertEqual("coverage", first_meta["portfolio_mode"])
        self.assertEqual(0, first_meta["historical_full_duplicates"])
        self.assertEqual(0, first_meta["historical_red_duplicates"])

    def test_locked_order_has_descending_adjusted_scores(self):
        _, metadata = build_adaptive_portfolio("2099002", self.draws, self.config)
        scores = [row["adjusted_score"] for row in metadata["ticket_scores"]]
        self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertEqual(5, len(metadata["ranking"]["priority_indices"]))
        self.assertFalse(metadata["ranking"]["index_is_probability"])

    def test_hard_filter_blocks_seen_and_zero_history_shapes(self):
        seen_red = (1, 2, 3, 4, 5, 6)
        reasons = hard_shape_reasons(
            seen_red,
            1,
            seen_reds={seen_red},
            seen_full={ticket_key(seen_red, 1)},
            exclude_seen_red=True,
            exclude_seen_full=True,
        )
        self.assertIn("历史完整组合", reasons)
        self.assertIn("历史红球组合", reasons)
        self.assertIn("跨度历史零区间", reasons)
        self.assertIn("六连号", reasons)


if __name__ == "__main__":
    unittest.main()
