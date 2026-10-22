import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "tools" / "update_ssq.py"

spec = importlib.util.spec_from_file_location("update_ssq", SCRIPT)
update_ssq = importlib.util.module_from_spec(spec)
sys.modules["update_ssq"] = update_ssq
spec.loader.exec_module(update_ssq)


FIXTURE = ROOT / "tools" / "fixtures" / "500_history.html"


class NormaliseIssue(unittest.TestCase):
    def test_20xx_years(self):
        self.assertEqual(update_ssq.normalise_issue("26053"), "2026053")
        self.assertEqual(update_ssq.normalise_issue("03001"), "2003001")

    def test_rejects_bad_input(self):
        with self.assertRaises(ValueError):
            update_ssq.normalise_issue("2026053")
        with self.assertRaises(ValueError):
            update_ssq.normalise_issue("abc01")


class ValidateDraw(unittest.TestCase):
    def _good(self):
        return {
            "issue": "2026053",
            "year": 2026,
            "date": "2026-05-12",
            "reds": [1, 2, 3, 8, 13, 14],
            "blue": 2,
        }

    def test_ok(self):
        update_ssq.validate_draw(self._good())

    def test_reds_must_be_unique_six(self):
        d = self._good()
        d["reds"] = [1, 1, 2, 3, 4, 5]
        with self.assertRaises(ValueError):
            update_ssq.validate_draw(d)
        d["reds"] = [1, 2, 3, 4, 5]
        with self.assertRaises(ValueError):
            update_ssq.validate_draw(d)

    def test_red_range(self):
        d = self._good()
        d["reds"] = [0, 2, 3, 4, 5, 6]
        with self.assertRaises(ValueError):
            update_ssq.validate_draw(d)
        d["reds"] = [1, 2, 3, 4, 5, 34]
        with self.assertRaises(ValueError):
            update_ssq.validate_draw(d)

    def test_blue_range(self):
        d = self._good()
        d["blue"] = 0
        with self.assertRaises(ValueError):
            update_ssq.validate_draw(d)
        d["blue"] = 17
        with self.assertRaises(ValueError):
            update_ssq.validate_draw(d)

    def test_issue_format(self):
        d = self._good()
        d["issue"] = "26053"
        with self.assertRaises(ValueError):
            update_ssq.validate_draw(d)


class Parse500Html(unittest.TestCase):
    def setUp(self):
        self.html = FIXTURE.read_text(encoding="utf-8")

    def test_fixture_has_expected_rows(self):
        draws = update_ssq.parse_500_html(self.html)
        self.assertGreaterEqual(len(draws), 8)
        issues = [d["issue"] for d in draws]
        for expected in [
            "2026053",
            "2026052",
            "2026051",
            "2026050",
            "2026049",
            "2026048",
            "2026047",
            "2026046",
        ]:
            self.assertIn(expected, issues)

    def test_latest_row_values(self):
        draws = update_ssq.parse_500_html(self.html)
        by_issue = {d["issue"]: d for d in draws}
        latest = by_issue["2026053"]
        self.assertEqual(latest["date"], "2026-05-12")
        self.assertEqual(latest["reds"], [1, 2, 3, 8, 13, 14])
        self.assertEqual(latest["blue"], 2)
        self.assertEqual(latest["year"], 2026)

    def test_reds_sorted_ascending(self):
        for d in update_ssq.parse_500_html(self.html):
            self.assertEqual(d["reds"], sorted(d["reds"]))


class MergeDraws(unittest.TestCase):
    def test_adds_new_issues(self):
        existing = [
            {
                "issue": "2026046",
                "year": 2026,
                "date": "2026-04-26",
                "reds": [2, 9, 10, 24, 31, 33],
                "blue": 16,
            }
        ]
        fresh = [
            {
                "issue": "2026047",
                "year": 2026,
                "date": "2026-04-28",
                "reds": [7, 16, 21, 24, 27, 30],
                "blue": 7,
            }
        ]
        merged, added = update_ssq.merge_draws(existing, fresh)
        self.assertEqual(added, ["2026047"])
        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[-1]["issue"], "2026047")

    def test_overwrites_same_issue(self):
        existing = [
            {
                "issue": "2026046",
                "year": 2026,
                "date": "2026-04-26",
                "reds": [1, 2, 3, 4, 5, 6],
                "blue": 1,
            }
        ]
        corrected = [
            {
                "issue": "2026046",
                "year": 2026,
                "date": "2026-04-26",
                "reds": [2, 9, 10, 24, 31, 33],
                "blue": 16,
            }
        ]
        merged, added = update_ssq.merge_draws(existing, corrected)
        self.assertEqual(added, [])
        self.assertEqual(merged[0]["reds"], [2, 9, 10, 24, 31, 33])

    def test_sorts_by_issue_ascending(self):
        existing = [
            {
                "issue": "2026050",
                "year": 2026,
                "date": "2026-05-05",
                "reds": [6, 9, 25, 27, 28, 30],
                "blue": 3,
            }
        ]
        fresh = [
            {
                "issue": "2026048",
                "year": 2026,
                "date": "2026-04-30",
                "reds": [9, 15, 18, 24, 28, 33],
                "blue": 1,
            }
        ]
        merged, _ = update_ssq.merge_draws(existing, fresh)
        self.assertEqual([d["issue"] for d in merged], ["2026048", "2026050"])


class RunWithFixture(unittest.TestCase):
    def test_end_to_end_via_fixture(self):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            data_path = Path(td) / "draws.json"
            data_path.write_text(
                json.dumps(
                    {
                        "meta": {"count": 1},
                        "draws": [
                            {
                                "issue": "2026046",
                                "year": 2026,
                                "date": "2026-04-26",
                                "reds": [2, 9, 10, 24, 31, 33],
                                "blue": 16,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            rc = update_ssq.run(count=30, data_path=data_path, fixture=FIXTURE)
            self.assertEqual(rc, 0)

            doc = json.loads(data_path.read_text(encoding="utf-8"))
            issues = [d["issue"] for d in doc["draws"]]
            self.assertIn("2026053", issues)
            self.assertIn("2026047", issues)
            self.assertTrue(doc["meta"]["generatedAt"].endswith("Z"))
            self.assertEqual(doc["meta"]["count"], len(doc["draws"]))

            # draws.js sibling is also generated
            js_path = data_path.with_name("draws.js")
            self.assertTrue(js_path.exists())
            self.assertTrue(
                js_path.read_text(encoding="utf-8").startswith("window.__SSQ_DATA__=")
            )

    def test_idempotent_second_run(self):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            data_path = Path(td) / "draws.json"
            data_path.write_text(
                json.dumps({"meta": {}, "draws": []}), encoding="utf-8"
            )
            update_ssq.run(count=30, data_path=data_path, fixture=FIXTURE)
            first_mtime = data_path.stat().st_mtime_ns
            first_content = data_path.read_text(encoding="utf-8")

            rc = update_ssq.run(count=30, data_path=data_path, fixture=FIXTURE)
            self.assertEqual(rc, 0)
            # content must not change (idempotent -> no write)
            self.assertEqual(data_path.read_text(encoding="utf-8"), first_content)
            self.assertEqual(data_path.stat().st_mtime_ns, first_mtime)


if __name__ == "__main__":
    unittest.main()
