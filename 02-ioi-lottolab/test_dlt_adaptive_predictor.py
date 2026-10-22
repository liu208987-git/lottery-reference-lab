import unittest

import dlt_db
from dlt_adaptive_predictor import (
    ALGORITHM_NAME,
    build_adaptive_portfolio,
    hard_reasons,
    ticket_key,
)


class AdaptiveDltPredictorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.draws = dlt_db.get_all_draws("ASC")[:500]
        cls.config = {
            "strategy": "ssq_transfer_coverage",
            "portfolio_mode": "coverage",
            "blue_mode": "coverage",
            "train_window": 50,
            "candidate_count": 200,
            "candidate_replicates": 4,
            "soft_penalty_weight": 0.0,
            "exclude_seen_red": False,
            "exclude_seen_full": True,
        }

    def test_v7_is_deterministic_and_transfers_zero_overlap_coverage(self):
        first, first_meta = build_adaptive_portfolio(
            "2099001", self.draws, self.config
        )
        second, second_meta = build_adaptive_portfolio(
            "2099001", self.draws, self.config
        )
        self.assertEqual(first, second)
        self.assertEqual(ALGORITHM_NAME, first_meta["algorithm"])
        self.assertEqual(first_meta["ticket_scores"], second_meta["ticket_scores"])
        self.assertEqual(5, len(first))
        self.assertEqual(25, first_meta["portfolio"]["red_coverage"])
        self.assertEqual(10, first_meta["portfolio"]["blue_coverage"])
        self.assertEqual(0, first_meta["portfolio"]["max_red_overlap"])
        self.assertEqual(0, first_meta["portfolio"]["max_blue_overlap"])
        self.assertEqual("coverage", first_meta["blue_mode"])
        self.assertEqual(0, first_meta["historical_full_duplicates"])

    def test_priority_order_is_frozen_and_descending(self):
        _, metadata = build_adaptive_portfolio("2099002", self.draws, self.config)
        scores = [row["adjusted_score"] for row in metadata["ticket_scores"]]
        self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertEqual(5, len(metadata["ranking"]["priority_indices"]))
        self.assertFalse(metadata["ranking"]["index_is_probability"])

    def test_hard_filter_blocks_seen_full_and_zero_history_shape(self):
        reds = (1, 2, 3, 4, 5)
        blues = (1, 2)
        reasons = hard_reasons(
            reds,
            blues,
            seen_reds={reds},
            seen_full={ticket_key(reds, blues)},
            exclude_seen_red=False,
            exclude_seen_full=True,
        )
        self.assertIn("历史完整组合", reasons)
        self.assertNotIn("历史前区组合", reasons)
        self.assertIn("和值历史零区间", reasons)
        self.assertIn("跨度历史零区间", reasons)
        self.assertIn("五连号", reasons)


if __name__ == "__main__":
    unittest.main()
