import unittest

import dlt_db
import ssq_db
from ticket_ranking import rank_tickets, ranking_metadata
from web_app import _compute_ticket_analysis, app


class TicketRankingTests(unittest.TestCase):
    def test_priority_ranking_is_a_stable_permutation(self):
        draws = ssq_db.get_all_draws("ASC")
        tickets = [
            ([8, 13, 18, 22, 26, 33], [4]),
            ([7, 11, 19, 21, 24, 30], [5]),
            ([3, 12, 16, 25, 27, 28], [2]),
            ([5, 10, 17, 23, 29, 32], [1]),
            ([1, 2, 14, 15, 20, 31], [7]),
        ]
        ranking = rank_tickets(tickets, draws, "ssq")
        self.assertEqual(sorted(item["index"] for item in ranking), list(range(5)))
        self.assertEqual([item["rank"] for item in ranking], [1, 2, 3, 4, 5])
        self.assertEqual(
            [item["raw_score"] for item in ranking],
            sorted((item["raw_score"] for item in ranking), reverse=True),
        )

    def test_api_keeps_theoretical_odds_equal_across_ranks(self):
        client = app.test_client()
        for game, database in (("ssq", ssq_db), ("dlt", dlt_db)):
            self.assertGreater(database.get_count(), 0)
            response = client.get(f"/api/predictions/{game}")
            self.assertEqual(response.status_code, 200)
            data = response.get_json()
            analysis = data["ticket_analysis"]
            self.assertEqual([item["rank"] for item in analysis], [1, 2, 3, 4, 5])
            self.assertEqual(len({item["p_jackpot"] for item in analysis}), 1)
            self.assertTrue(all(item["theoretical_equal_probability"] for item in analysis))
            self.assertFalse(data["ranking_validation"]["statistically_significant"])

    def test_validation_metadata_labels_index_as_non_probability(self):
        for game in ("ssq", "dlt"):
            metadata = ranking_metadata(game)
            self.assertFalse(metadata["index_is_probability"])
            self.assertGreater(metadata["holdout_records"], 700)
            self.assertFalse(metadata["prefix_order_validated"])

    def test_frozen_order_is_not_re_ranked(self):
        draws = ssq_db.get_all_draws("ASC")
        tickets = [
            ([8, 13, 18, 22, 26, 33], [4]),
            ([7, 11, 19, 21, 24, 30], [5]),
            ([3, 12, 16, 25, 27, 28], [2]),
            ([5, 10, 17, 23, 29, 32], [1]),
            ([1, 2, 14, 15, 20, 31], [7]),
        ]
        frozen = [91.0, 73.0, 50.0, 27.0, 9.0]
        analysis = _compute_ticket_analysis(
            tickets, draws, "ssq", frozen_priority_indices=frozen)
        self.assertEqual([item["index"] for item in analysis], list(range(5)))
        self.assertEqual([item["rank"] for item in analysis], [1, 2, 3, 4, 5])
        self.assertEqual([item["priority_index"] for item in analysis], frozen)


if __name__ == "__main__":
    unittest.main()
