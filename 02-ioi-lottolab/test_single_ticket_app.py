import unittest

from web_app import app


class SingleTicketApiTests(unittest.TestCase):
    def setUp(self):
        app.config.update(TESTING=True)
        self.client = app.test_client()

    def test_ssq_uses_supported_aggregate_ticket(self):
        response = self.client.get("/api/single-ticket/ssq")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()

        self.assertEqual(data["strategy"], "aggregate")
        self.assertEqual(data["recommended_ticket"]["reds"], data["compressed_ticket"]["reds"])
        self.assertEqual(data["recommended_ticket"]["blues"], data["compressed_ticket"]["blues"])
        self.assertEqual(len(data["recommended_ticket"]["reds"]), 6)
        self.assertEqual(len(data["recommended_ticket"]["blues"]), 1)
        self.assertGreater(
            data["backtest"]["comparison"]["all_history_current_rules"]["absolute_change"],
            0,
        )
        self.assertEqual(
            set(data["backtest"]["aggregate"]["current_rule_prizes"]),
            {"一等奖", "二等奖", "三等奖", "四等奖", "五等奖", "六等奖"},
        )

    def test_dlt_keeps_production_first_ticket_when_aggregate_underperforms(self):
        response = self.client.get("/api/single-ticket/dlt")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()

        self.assertEqual(data["strategy"], "baseline_first_ticket")
        self.assertEqual(data["recommended_ticket"]["reds"], data["source_first_ticket"]["reds"])
        self.assertEqual(data["recommended_ticket"]["blues"], data["source_first_ticket"]["blues"])
        self.assertNotEqual(data["recommended_ticket"], data["compressed_ticket"])
        self.assertEqual(len(data["recommended_ticket"]["reds"]), 5)
        self.assertEqual(len(data["recommended_ticket"]["blues"]), 2)
        self.assertLess(
            data["backtest"]["comparison"]["last_30_percent_current_rules"][
                "absolute_change"
            ],
            0,
        )
        self.assertEqual(
            set(data["backtest"]["aggregate"]["current_rule_prizes"]),
            {"一等奖", "二等奖", "三等奖", "四等奖", "五等奖", "六等奖", "七等奖"},
        )

    def test_unknown_game_is_rejected(self):
        response = self.client.get("/api/single-ticket/not-a-game")
        self.assertEqual(response.status_code, 400)

    def test_dlt_prediction_probabilities_use_current_seven_levels(self):
        response = self.client.get("/api/predictions/dlt")
        self.assertEqual(response.status_code, 200)
        analysis = response.get_json()["ticket_analysis"]
        self.assertTrue(analysis)

        expected_prefixes = {"一等奖", "二等奖", "三等奖", "四等奖", "五等奖", "六等奖", "七等奖"}
        for ticket in analysis:
            labels = ticket["p_prizes"]
            self.assertEqual(len(labels), 7)
            self.assertEqual(
                {next(prefix for prefix in expected_prefixes if label.startswith(prefix)) for label in labels},
                expected_prefixes,
            )


if __name__ == "__main__":
    unittest.main()
