import unittest

import dlt_db
import ssq_db
from dlt_analyzer import Analyzer as DltAnalyzer
from ssq_analyzer import Analyzer as SsqAnalyzer


class PredictionTests(unittest.TestCase):
    def _check(self, analyzer, red_pool, red_pick, blue_pool, blue_pick, total):
        prediction = analyzer.predict()
        self.assertEqual(prediction["model"], "quant-gated-coverage-v3")
        self.assertEqual(prediction["jackpot_total_combinations"], total)
        self.assertEqual(len(prediction["tickets"]), 5)
        full_tickets = set()
        for reds, blues in prediction["tickets"]:
            self.assertEqual(len(reds), red_pick)
            self.assertEqual(len(set(reds)), red_pick)
            self.assertTrue(all(1 <= x <= red_pool for x in reds))
            self.assertEqual(len(blues), blue_pick)
            self.assertEqual(len(set(blues)), blue_pick)
            self.assertTrue(all(1 <= x <= blue_pool for x in blues))
            full_tickets.add((tuple(reds), tuple(blues)))
        self.assertEqual(len(full_tickets), 5)
        self.assertEqual(prediction, analyzer.predict())
        self.assertIn("quant_diagnostics", prediction)

    def test_dlt(self):
        self._check(DltAnalyzer(dlt_db.get_all_draws()), 35, 5, 12, 2,
                    21_425_712)

    def test_ssq(self):
        self._check(SsqAnalyzer(ssq_db.get_all_draws()), 33, 6, 16, 1,
                    17_721_088)


if __name__ == "__main__":
    unittest.main()
