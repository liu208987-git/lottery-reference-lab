from __future__ import annotations

import sys
import unittest
from pathlib import Path


LAB_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB_ROOT / "scripts"))

from audit_dlt_sources import build_crosscheck_rows, build_summary  # noqa: E402


class SourceAuditTests(unittest.TestCase):
    def test_crosscheck_distinguishes_date_and_number_matches(self) -> None:
        official = [
            {
                "lotteryDrawNum": "14001",
                "lotteryDrawTime": "2014-01-01",
                "lotteryDrawResult": "01 02 03 04 05 06 07",
                "lotteryEquipmentCount": 2,
                "drawPdfUrl": "https://example.test/14001.pdf",
            }
        ]
        local = {
            "14001": {
                "draw_date": "2014-01-02",
                "numbers": "01 02 03 04 05 06 07",
            }
        }
        rows = build_crosscheck_rows(official, local)
        self.assertFalse(rows[0]["date_match"])
        self.assertEqual(rows[0]["official_draw_date"], "2014-01-01")
        self.assertEqual(rows[0]["local_draw_date"], "2014-01-02")
        self.assertTrue(rows[0]["numbers_match"])
        self.assertFalse(rows[0]["source_match"])
        self.assertEqual(rows[0]["equipment_set_reported"], 2)
        summary = build_summary(rows)
        self.assertEqual(summary["mismatch_count"], 1)
        self.assertEqual(summary["number_mismatch_count"], 0)
        self.assertEqual(summary["numbers_matched_rows"], 1)
        self.assertEqual(summary["date_matched_rows"], 0)
        self.assertEqual(summary["date_conflict_count"], 1)
        self.assertEqual(summary["date_conflict_issues"], ["14001"])
        self.assertEqual(
            summary["date_conflicts"],
            [
                {
                    "issue": "14001",
                    "official_draw_date": "2014-01-01",
                    "local_draw_date": "2014-01-02",
                }
            ],
        )
        self.assertEqual(summary["equipment_set_distribution"], {"2": 1})


if __name__ == "__main__":
    unittest.main()
