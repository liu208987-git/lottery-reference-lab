from __future__ import annotations

import json
import sys
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse


LAB_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB_ROOT / "src"))

from data_sync import (  # noqa: E402
    DataSyncError,
    HttpResponse,
    TrustedTime,
    fetch_missing_draws,
    get_trusted_utc_now,
    scan_missing_draws,
)
from lottery_lab import Draw  # noqa: E402


def jsonp(
    records: list[dict[str, object]],
    *,
    total: int | None = None,
    pages: int = 1,
    res_code: str = "000000",
) -> bytes:
    payload = {
        "resCode": res_code,
        "message": "ok" if res_code == "000000" else "failed",
        "total": len(records) if total is None else total,
        "pages": pages,
        "data": records,
    }
    return f"lottery_lab_sync({json.dumps(payload)})".encode()


def ssq_record(
    issue: str,
    draw_date: str,
    front: str = "01 02 03 04 05 06",
    back: str = "01",
) -> dict[str, object]:
    return {
        "issue": issue,
        "openTime": draw_date,
        "frontWinningNum": front,
        "backWinningNum": back,
    }


def dlt_record(
    issue: str,
    draw_date: str,
    front: str = "01 02 03 04 05",
    back: str = "01 02",
) -> dict[str, object]:
    return {
        "issue": issue,
        "openTime": draw_date,
        "frontWinningNum": front,
        "backWinningNum": back,
    }


class DataSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.trusted_time = TrustedTime(
            datetime(2026, 7, 24, 4, 0, tzinfo=timezone.utc),
            "network_date_header",
            ("https://clock.test/",),
        )

    def test_trusted_time_uses_median_of_network_date_headers(self) -> None:
        dates = {
            "https://one.test/": "Tue, 21 Jul 2026 04:00:00 GMT",
            "https://two.test/": "Tue, 21 Jul 2026 04:00:04 GMT",
            "https://three.test/": "Tue, 21 Jul 2026 04:00:02 GMT",
        }

        def transport(request, timeout):
            self.assertEqual(request.get_method(), "HEAD")
            self.assertEqual(timeout, 2.0)
            return HttpResponse(200, {"date": dates[request.full_url]})

        result = get_trusted_utc_now(
            transport=transport,
            source_urls=tuple(dates),
            timeout=2.0,
        )

        self.assertEqual(
            result.now_utc,
            datetime(2026, 7, 21, 4, 0, 2, tzinfo=timezone.utc),
        )
        self.assertEqual(result.current_date, date(2026, 7, 21))
        self.assertTrue(result.uses_network_time)
        self.assertEqual(result.errors, ())

    def test_trusted_time_marks_local_fallback_when_all_sources_fail(self) -> None:
        fallback = datetime(2026, 7, 21, 8, 30, tzinfo=timezone.utc)

        def transport(request, timeout):
            raise OSError("offline")

        result = get_trusted_utc_now(
            transport=transport,
            source_urls=("https://one.test/", "https://two.test/"),
            local_now=lambda: fallback,
        )

        self.assertEqual(result.now_utc, fallback)
        self.assertEqual(result.source, "local_clock_fallback")
        self.assertFalse(result.uses_network_time)
        self.assertEqual(len(result.errors), 2)

    def test_fetch_returns_only_missing_sorted_non_future_draws(self) -> None:
        existing = Draw(
            "2026082",
            date(2026, 7, 19),
            (5, 7, 10, 14, 21, 28),
            (4,),
        )
        records = [
            ssq_record("2026084", "2026-07-23", "01 07 11 19 22 30", "08"),
            ssq_record("2026083", "2026-07-21", "02 09 14 18 25 31", "12"),
            ssq_record("2026082", "2026-07-19", "05 07 10 14 21 28", "04"),
            ssq_record("2026083", "2026-07-21", "02 09 14 18 25 31", "12"),
            ssq_record("2026085", "2026-07-26", "03 08 16 20 26 33", "06"),
        ]
        seen_query: dict[str, list[str]] = {}

        def transport(request, timeout):
            seen_query.update(parse_qs(urlparse(request.full_url).query))
            return HttpResponse(200, {}, jsonp(records))

        result = fetch_missing_draws(
            "ssq", [existing], self.trusted_time, transport=transport, attempts=1
        )

        self.assertEqual([draw.issue for draw in result.candidates], ["2026083", "2026084"])
        self.assertEqual(result.source_duplicate_count, 1)
        self.assertEqual(result.already_present_count, 1)
        self.assertEqual(result.ignored_future_count, 1)
        self.assertEqual(seen_query["startDate"], ["2026-06-04"])
        self.assertEqual(seen_query["endDate"], ["2026-07-24"])
        self.assertEqual(result.status, "updates_available")

    def test_no_new_records_reports_up_to_date(self) -> None:
        existing = Draw(
            "26081", date(2026, 7, 20), (8, 16, 18, 24, 34), (9, 12)
        )

        def transport(request, timeout):
            return HttpResponse(
                200,
                {},
                jsonp(
                    [
                        dlt_record(
                            "26081", "2026-07-20", "08 16 18 24 34", "09 12"
                        )
                    ]
                ),
            )

        result = fetch_missing_draws(
            "dlt", [existing], self.trusted_time, transport=transport, attempts=1
        )

        self.assertEqual(result.candidates, ())
        self.assertEqual(result.already_present_count, 1)
        self.assertEqual(result.status, "up_to_date")

    def test_forward_gap_is_rejected_instead_of_advancing_scan_boundary(self) -> None:
        existing = Draw(
            "2026082",
            date(2026, 7, 19),
            (5, 7, 10, 14, 21, 28),
            (4,),
        )

        def transport(request, timeout):
            return HttpResponse(
                200,
                {},
                jsonp(
                    [
                        ssq_record(
                            "2026084",
                            "2026-07-23",
                            "01 07 11 19 22 30",
                            "08",
                        )
                    ]
                ),
            )

        with self.assertRaisesRegex(DataSyncError, "缺少连续期号 2026083"):
            fetch_missing_draws(
                "ssq",
                [existing],
                self.trusted_time,
                transport=transport,
                attempts=1,
            )

    def test_conflicting_duplicate_issue_is_rejected(self) -> None:
        records = [
            ssq_record("2026083", "2026-07-21"),
            ssq_record("2026083", "2026-07-21", "01 02 03 04 05 07"),
        ]

        def transport(request, timeout):
            return HttpResponse(200, {}, jsonp(records))

        with self.assertRaisesRegex(DataSyncError, "冲突接口数据"):
            fetch_missing_draws(
                "ssq", [], self.trusted_time, transport=transport, attempts=1
            )

    def test_remote_conflict_with_existing_draw_is_rejected(self) -> None:
        existing = Draw(
            "2026082",
            date(2026, 7, 19),
            (5, 7, 10, 14, 21, 28),
            (4,),
        )

        def transport(request, timeout):
            return HttpResponse(
                200,
                {},
                jsonp(
                    [
                        ssq_record(
                            "2026082", "2026-07-19", "05 07 10 14 21 29", "04"
                        )
                    ]
                ),
            )

        with self.assertRaisesRegex(DataSyncError, "接口与本地数据冲突"):
            fetch_missing_draws(
                "ssq", [existing], self.trusted_time, transport=transport, attempts=1
            )

    def test_scan_isolates_one_lottery_api_failure(self) -> None:
        existing = {
            "ssq": [
                Draw(
                    "2026082",
                    date(2026, 7, 19),
                    (5, 7, 10, 14, 21, 28),
                    (4,),
                )
            ],
            "dlt": [
                Draw(
                    "26081",
                    date(2026, 7, 20),
                    (8, 16, 18, 24, 34),
                    (9, 12),
                )
            ],
        }

        def transport(request, timeout):
            if request.get_method() == "HEAD":
                return HttpResponse(
                    200, {"Date": "Fri, 24 Jul 2026 04:00:00 GMT"}
                )
            lottery_id = parse_qs(urlparse(request.full_url).query)["lotteryId"][0]
            if lottery_id == "281":
                raise OSError("DLT API unavailable")
            return HttpResponse(200, {}, jsonp([]))

        result = scan_missing_draws(
            existing,
            transport=transport,
            time_source_urls=("https://clock.test/",),
            api_attempts=1,
        )

        self.assertEqual(result.games["ssq"].status, "up_to_date")
        self.assertEqual(result.games["dlt"].status, "error")
        self.assertIn("DLT API unavailable", result.games["dlt"].error or "")

    def test_bad_api_result_and_incomplete_pagination_are_reported(self) -> None:
        responses = iter(
            [
                HttpResponse(200, {}, jsonp([], res_code="999999")),
                HttpResponse(200, {}, jsonp([], total=1)),
            ]
        )

        def transport(request, timeout):
            return next(responses)

        with self.assertRaisesRegex(DataSyncError, "接口请求失败"):
            fetch_missing_draws(
                "ssq", [], self.trusted_time, transport=transport, attempts=1
            )
        with self.assertRaisesRegex(DataSyncError, "记录数不完整"):
            fetch_missing_draws(
                "ssq", [], self.trusted_time, transport=transport, attempts=1
            )


if __name__ == "__main__":
    unittest.main()
