import unittest

from web_app import (
    PRODUCTION_ALGORITHMS,
    _get_all_settled,
    app,
)


class ProductionHistoryContinuityTests(unittest.TestCase):
    def test_ssq_upgrade_preserves_v8_history_without_duplicate_issues(self):
        rows = _get_all_settled("ssq", limit=10000)
        issues = [row["issue"] for row in rows]
        self.assertGreater(len(rows), 3000)
        self.assertEqual(len(issues), len(set(issues)))
        by_issue = {row["issue"]: row for row in rows}
        if "2026081" in by_issue:
            self.assertIn(
                by_issue["2026081"]["algorithm"],
                {
                    "ssq-v8",
                    "ssq-v13-empirical-adaptive",
                    PRODUCTION_ALGORITHMS["ssq"],
                },
            )

    def test_dashboard_and_history_api_use_continuous_series(self):
        client = app.test_client()
        dashboard = client.get("/api/dashboard").get_json()["ssq"]
        history = client.get("/api/history/ssq?limit=30").get_json()
        self.assertGreater(dashboard["settled_count"], 3000)
        self.assertEqual(30, len(history))
        self.assertEqual(len(history), len({row["issue"] for row in history}))
        self.assertEqual("v15", dashboard["algorithm_version"]["label"])
        self.assertEqual(
            "current_algorithm_walk_forward",
            dashboard["statistics_scope"],
        )
        self.assertEqual(
            PRODUCTION_ALGORITHMS["ssq"],
            dashboard["statistics_algorithm"],
        )
        prediction = client.get("/api/predictions/ssq").get_json()
        self.assertEqual(PRODUCTION_ALGORITHMS["ssq"], prediction["algorithm"])

    def test_dlt_upgrade_preserves_v4_history_and_uses_v7_prediction(self):
        rows = _get_all_settled("dlt", limit=10000)
        issues = [row["issue"] for row in rows]
        self.assertGreater(len(rows), 2500)
        self.assertEqual(len(issues), len(set(issues)))

        client = app.test_client()
        dashboard = client.get("/api/dashboard").get_json()["dlt"]
        prediction = client.get("/api/predictions/dlt").get_json()
        self.assertGreater(dashboard["settled_count"], 2500)
        self.assertEqual("v7", dashboard["algorithm_version"]["label"])
        self.assertEqual(
            "current_algorithm_walk_forward",
            dashboard["statistics_scope"],
        )
        self.assertEqual(
            PRODUCTION_ALGORITHMS["dlt"],
            dashboard["statistics_algorithm"],
        )
        self.assertEqual(PRODUCTION_ALGORITHMS["dlt"], prediction["algorithm"])

    def test_recent_diagnostics_exposes_exact_back_zone_counts(self):
        client = app.test_client()
        diagnostics = client.get("/api/diagnostics/dlt?limit=30").get_json()
        history = client.get("/api/history/dlt?limit=30").get_json()
        self.assertEqual(30, diagnostics["periods"])
        self.assertEqual(
            diagnostics["periods"],
            diagnostics["win_periods"] + diagnostics["miss_periods"],
        )
        self.assertTrue(diagnostics["primary_reasons"])
        for row in history:
            self.assertIn("max_blue_hits", row["metrics"])
            self.assertIn("union_blue_hits", row["metrics"])


if __name__ == "__main__":
    unittest.main()
