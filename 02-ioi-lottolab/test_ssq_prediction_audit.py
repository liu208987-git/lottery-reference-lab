from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from ssq_prediction_audit import (
    evaluate_tickets,
    issue_report,
    record_prediction,
    scoreboard,
    settle_issue,
)


EXTERNAL = [
    ([12, 18, 22, 24, 25, 29], [12]),
    ([1, 3, 4, 8, 11, 30], [14]),
    ([2, 9, 16, 17, 23, 28], [15]),
    ([7, 10, 19, 20, 31, 33], [4]),
    ([5, 6, 13, 14, 26, 32], [8]),
]
CURRENT = [
    ([11, 13, 19, 22, 24, 25], [7]),
    ([1, 3, 7, 8, 26, 33], [8]),
    ([2, 6, 12, 18, 21, 30], [1]),
    ([9, 10, 16, 23, 27, 32], [3]),
    ([5, 14, 15, 17, 20, 29], [14]),
]


class PredictionAuditTests(unittest.TestCase):
    def test_known_2026079_scores(self):
        external = evaluate_tickets(EXTERNAL, [1, 11, 17, 22, 24, 29], 4)
        current = evaluate_tickets(CURRENT, [1, 11, 17, 22, 24, 29], 4)
        self.assertEqual(external["total_red_hits"], 6)
        self.assertEqual(current["total_red_hits"], 6)
        self.assertEqual(external["max_red_hits"], 3)
        self.assertEqual(current["max_red_hits"], 3)
        self.assertEqual(external["winning_tickets"], 1)
        self.assertEqual(external["best_prize_name"], "六等奖")
        self.assertEqual(current["winning_tickets"], 0)

    def test_first_prediction_is_locked_and_common_scoreboard(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "audit.db"
            self.assertTrue(record_prediction(
                "2026079", "external", "2026078", EXTERNAL, path=path))
            self.assertFalse(record_prediction(
                "2026079", "external", "2026078", CURRENT, path=path))
            self.assertTrue(record_prediction(
                "2026079", "current", "2026078", CURRENT, path=path))
            self.assertEqual(settle_issue(
                "2026079", [1, 11, 17, 22, 24, 29], 4, path=path), 2)
            self.assertEqual(len(issue_report("2026079", path=path)), 2)
            board = scoreboard(path=path)
            self.assertEqual(len(board), 2)
            self.assertTrue(all(row["common_periods"] == 1 for row in board))


if __name__ == "__main__":
    unittest.main()

