#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""tests for tools/update_dlt.py and tools/parse_dlt.py."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tools import update_dlt as udlt  # noqa: E402
from tools import parse_dlt as pdlt  # noqa: E402

FIXTURE = ROOT / "tools" / "fixtures" / "dlt_500_history.html"


class TestParse500Html(unittest.TestCase):
    def setUp(self):
        self.html = FIXTURE.read_text(encoding="utf-8")
        self.draws = udlt.parse_500_html(self.html)

    def test_parses_all_rows(self):
        self.assertEqual(len(self.draws), 5)

    def test_first_draw_is_26050(self):
        d = self.draws[0]
        self.assertEqual(d["issue"], "26050")
        self.assertEqual(d["year"], 2026)
        self.assertEqual(d["date"], "2026-05-12")
        self.assertEqual(d["front"], [3, 11, 15, 22, 30])
        self.assertEqual(d["back"], [4, 9])

    def test_last_draw_is_26054(self):
        d = self.draws[-1]
        self.assertEqual(d["issue"], "26054")
        self.assertEqual(d["front"], [6, 10, 16, 23, 35])
        self.assertEqual(d["back"], [1, 7])

    def test_front_back_sorted(self):
        for d in self.draws:
            self.assertEqual(d["front"], sorted(d["front"]))
            self.assertEqual(d["back"], sorted(d["back"]))

    def test_validate_each_draw(self):
        for d in self.draws:
            udlt.validate_draw(d)


class TestValidateDraw(unittest.TestCase):
    def test_rejects_bad_issue(self):
        with self.assertRaises(ValueError):
            udlt.validate_draw({"issue": "12345abc", "front": [1, 2, 3, 4, 5], "back": [1, 2]})

    def test_rejects_dup_front(self):
        with self.assertRaises(ValueError):
            udlt.validate_draw({"issue": "26054", "front": [1, 1, 2, 3, 4], "back": [1, 2]})

    def test_rejects_oob_front(self):
        with self.assertRaises(ValueError):
            udlt.validate_draw({"issue": "26054", "front": [1, 2, 3, 4, 36], "back": [1, 2]})

    def test_rejects_oob_back(self):
        with self.assertRaises(ValueError):
            udlt.validate_draw({"issue": "26054", "front": [1, 2, 3, 4, 5], "back": [1, 13]})

    def test_rejects_dup_back(self):
        with self.assertRaises(ValueError):
            udlt.validate_draw({"issue": "26054", "front": [1, 2, 3, 4, 5], "back": [1, 1]})


class TestMergeDraws(unittest.TestCase):
    def test_dedup_by_issue(self):
        existing = [
            {"issue": "26050", "year": 2026, "date": "2026-05-12",
             "front": [3, 11, 15, 22, 30], "back": [4, 9]},
        ]
        fresh = [
            {"issue": "26050", "year": 2026, "date": "2026-05-12",
             "front": [3, 11, 15, 22, 30], "back": [4, 9]},
            {"issue": "26051", "year": 2026, "date": "2026-05-14",
             "front": [2, 7, 19, 25, 33], "back": [5, 11]},
        ]
        merged, added = udlt.merge_draws(existing, fresh)
        self.assertEqual(len(merged), 2)
        self.assertEqual(added, ["26051"])

    def test_sorted_by_issue(self):
        existing = []
        fresh = [
            {"issue": "26054", "year": 2026, "date": "2026-05-21",
             "front": [6, 10, 16, 23, 35], "back": [1, 7]},
            {"issue": "26050", "year": 2026, "date": "2026-05-12",
             "front": [3, 11, 15, 22, 30], "back": [4, 9]},
        ]
        merged, _ = udlt.merge_draws(existing, fresh)
        self.assertEqual([d["issue"] for d in merged], ["26050", "26054"])

    def test_overwrite_same_issue(self):
        existing = [
            {"issue": "26050", "year": 2026, "date": "2026-05-12",
             "front": [1, 2, 3, 4, 5], "back": [1, 2]},
        ]
        fresh = [
            {"issue": "26050", "year": 2026, "date": "2026-05-12",
             "front": [3, 11, 15, 22, 30], "back": [4, 9]},
        ]
        merged, added = udlt.merge_draws(existing, fresh)
        self.assertEqual(merged[0]["front"], [3, 11, 15, 22, 30])
        self.assertEqual(added, [])


class TestRunWithFixture(unittest.TestCase):
    def test_run_creates_json_and_js(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "dlt-draws.json"
            rc = udlt.run(count=30, data_path=target, fixture=FIXTURE)
            self.assertEqual(rc, 0)
            self.assertTrue(target.exists())
            doc = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(doc["meta"]["count"], 5)
            self.assertEqual(doc["meta"]["source"], f"fixture:{FIXTURE.name}")
            self.assertEqual(len(doc["draws"]), 5)
            js = target.with_name("dlt-draws.js").read_text(encoding="utf-8")
            self.assertTrue(js.startswith("window.__DLT_DATA__="))

    def test_run_idempotent_on_no_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "dlt-draws.json"
            udlt.run(count=30, data_path=target, fixture=FIXTURE)
            mtime1 = target.stat().st_mtime_ns
            # 第二次跑应该是 no_update
            rc2 = udlt.run(count=30, data_path=target, fixture=FIXTURE)
            self.assertEqual(rc2, 0)
            mtime2 = target.stat().st_mtime_ns
            self.assertEqual(mtime1, mtime2, "no-update should not rewrite file")


class TestParseTextFile(unittest.TestCase):
    def test_parses_text_format(self):
        lines = [
            "# 注释行",
            "26050 2026-05-12 03 11 15 22 30 04 09",
            "26051 2026-05-14 02 07 19 25 33 05 11",
        ]
        draws = pdlt.parse_text_lines(lines)
        self.assertEqual(len(draws), 2)
        self.assertEqual(draws[0]["issue"], "26050")
        self.assertEqual(draws[0]["front"], [3, 11, 15, 22, 30])
        self.assertEqual(draws[0]["back"], [4, 9])
        self.assertEqual(draws[1]["date"], "2026-05-14")

    def test_parses_without_date(self):
        lines = ["26050 03 11 15 22 30 04 09"]
        draws = pdlt.parse_text_lines(lines)
        self.assertEqual(len(draws), 1)
        self.assertIsNone(draws[0]["date"])
        self.assertEqual(draws[0]["front"], [3, 11, 15, 22, 30])

    def test_skips_invalid_lines(self):
        lines = ["", "garbage", "12 too short"]
        self.assertEqual(pdlt.parse_text_lines(lines), [])


if __name__ == "__main__":
    unittest.main()
