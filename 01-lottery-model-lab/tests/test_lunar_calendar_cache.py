from __future__ import annotations

import csv
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path


LAB_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB_ROOT / "src"))
sys.path.insert(0, str(LAB_ROOT / "scripts"))

from build_lunar_calendar import (  # noqa: E402
    DEFAULT_END,
    DEFAULT_START,
    build_calendar,
)
from lottery_lab import LunarDate, load_lunar_dates  # noqa: E402


CACHE_PATH = LAB_ROOT / "model_data" / "lunar_calendar.csv"
SWIFT_HELPER = LAB_ROOT / "scripts" / "chinese_calendar.swift"


class LunarCalendarCacheTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with CACHE_PATH.open("r", encoding="utf-8-sig", newline="") as handle:
            cls.rows = list(csv.DictReader(handle))
        cls.rows_by_date = {row["date"]: row for row in cls.rows}

    def test_cache_covers_every_date_in_the_registered_range(self) -> None:
        expected_count = (DEFAULT_END - DEFAULT_START).days + 1
        self.assertEqual(len(self.rows), expected_count)
        self.assertEqual(len(self.rows_by_date), expected_count)
        self.assertEqual(self.rows[0]["date"], DEFAULT_START.isoformat())
        self.assertEqual(self.rows[-1]["date"], DEFAULT_END.isoformat())

    def test_known_dates_match_foundation_calendar_values(self) -> None:
        expected = {
            date(2000, 1, 1): LunarDate(16, 11, 25, False),
            date(2024, 2, 10): LunarDate(41, 1, 1, False),
            date(2026, 7, 21): LunarDate(43, 6, 8, False),
            date(2050, 12, 31): LunarDate(7, 11, 18, False),
        }
        actual, source = load_lunar_dates(
            expected,
            SWIFT_HELPER,
            calendar_table_path=CACHE_PATH,
        )
        self.assertEqual(actual, expected)
        self.assertEqual(source, "Cached Chinese lunar calendar (Asia/Shanghai)")

    def test_leap_months_are_preserved(self) -> None:
        expected = {
            date(2012, 5, 21): LunarDate(29, 4, 1, True),
            date(2023, 3, 22): LunarDate(40, 2, 1, True),
        }
        actual, _ = load_lunar_dates(
            expected,
            SWIFT_HELPER,
            calendar_table_path=CACHE_PATH,
        )
        self.assertEqual(actual, expected)

    def test_missing_date_fails_closed_without_calendar_fallback(self) -> None:
        with self.assertRaisesRegex(ValueError, "农历缓存缺少 1 个日期"):
            load_lunar_dates(
                [date(1999, 12, 31)],
                SWIFT_HELPER,
                calendar_table_path=CACHE_PATH,
            )

    def test_committed_cache_is_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            regenerated = Path(temporary_directory) / "lunar_calendar.csv"
            count = build_calendar(regenerated, DEFAULT_START, DEFAULT_END)
            self.assertEqual(count, len(self.rows))
            self.assertEqual(regenerated.read_bytes(), CACHE_PATH.read_bytes())


if __name__ == "__main__":
    unittest.main()
