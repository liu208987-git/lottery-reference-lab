import unittest

import dlt_db
import ssq_db
from dlt_analyzer import Analyzer as DltAnalyzer
from quant_models import MODEL_NAMES, model_probabilities, research_gate
from ssq_analyzer import Analyzer as SsqAnalyzer


class QuantModelTests(unittest.TestCase):
    def _probability_checks(self, seq, pool, pick):
        for model in ("uniform", *MODEL_NAMES):
            probabilities = model_probabilities(seq, pool, pick, model)
            self.assertEqual(set(probabilities), set(range(1, pool + 1)))
            self.assertAlmostEqual(sum(probabilities.values()), pick, places=8)
            self.assertTrue(all(0 < p < 1 for p in probabilities.values()))

    def test_probability_invariants(self):
        dlt = DltAnalyzer(dlt_db.get_all_draws())
        ssq = SsqAnalyzer(ssq_db.get_all_draws())
        self._probability_checks(dlt.reds_seq, 35, 5)
        self._probability_checks(dlt.blues_seq, 12, 2)
        self._probability_checks(ssq.reds_seq, 33, 6)
        self._probability_checks(ssq.blues_seq, 16, 1)

    def test_gate_is_conservative_on_current_data(self):
        dlt = DltAnalyzer(dlt_db.get_all_draws())
        result = research_gate(dlt.reds_seq, 35, 5)
        self.assertEqual(result["selected_model"], "uniform")
        self.assertFalse(result["gate_passed"])


if __name__ == "__main__":
    unittest.main()
