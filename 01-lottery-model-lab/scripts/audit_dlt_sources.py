#!/usr/bin/env python3
"""Cross-check local DLT history against the official Sport Lottery API.

The official response exposes ``lotteryEquipmentCount``.  Current official
draw PDFs use the same value in wording such as ``本期使用第3套摇奖球``.  We
therefore report it conservatively as a ball/equipment set number; zero is
treated as unavailable metadata.
"""

from __future__ import annotations

import argparse
import csv
import json
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen


API_URL = (
    "https://webapi.sporttery.cn/gateway/lottery/"
    "getHistoryPageListV1.qry"
)
PAGE_SIZE = 100
HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.lottery.gov.cn",
    "Referer": "https://www.lottery.gov.cn/kj/kjlb.html?dlt",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 Chrome/138 Safari/537.36"
    ),
}


def fetch_page(page_number: int) -> dict[str, Any]:
    query = urlencode(
        {
            "gameNo": "85",
            "provinceId": "0",
            "pageSize": str(PAGE_SIZE),
            "isVerify": "1",
            "pageNo": str(page_number),
            "termLimits": "0",
        }
    )
    request = Request(f"{API_URL}?{query}", headers=HEADERS)
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            with urlopen(request, timeout=60) as response:
                payload = json.load(response)
            if not payload.get("success") or payload.get("errorCode") != "0":
                raise ValueError(
                    f"官方接口错误: {payload.get('errorCode')} "
                    f"{payload.get('errorMessage')}"
                )
            return payload["value"]
        except Exception as error:  # network/WAF retries
            last_error = error
            if attempt < 3:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"官方大乐透第 {page_number} 页抓取失败") from last_error


def fetch_all(workers: int) -> list[dict[str, Any]]:
    first = fetch_page(1)
    total = int(first["total"])
    pages = int(first["pages"])
    page_numbers = list(range(2, pages + 1))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        remaining = list(executor.map(fetch_page, page_numbers))
    rows = list(first["list"])
    for page in remaining:
        if int(page["total"]) != total or int(page["pages"]) != pages:
            raise ValueError("官方接口分页期间总数发生变化")
        rows.extend(page["list"])
    if len(rows) != total:
        raise ValueError(f"官方接口应有 {total} 条，实际抓取 {len(rows)} 条")
    issues = [str(row["lotteryDrawNum"]) for row in rows]
    if len(set(issues)) != len(issues):
        raise ValueError("官方接口返回重复期号")
    return rows


def normalize_result(value: object) -> str:
    return " ".join(f"{int(number):02d}" for number in str(value).split())


def load_local(path: Path) -> dict[str, dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return {
            str(row["issue"]): {
                "draw_date": row["draw_date"],
                "numbers": f"{row['front_numbers']} {row['back_numbers']}",
            }
            for row in csv.DictReader(handle)
        }


def era_for(draw_date: str) -> str:
    return "pre_2014" if draw_date < "2014-01-01" else "2014_and_later"


def build_crosscheck_rows(
    official_rows: list[dict[str, Any]],
    local_rows: dict[str, dict[str, str]],
) -> list[dict[str, object]]:
    output: list[dict[str, object]] = []
    official_issues: set[str] = set()
    for raw in official_rows:
        issue = str(raw["lotteryDrawNum"])
        official_issues.add(issue)
        official_date = str(raw["lotteryDrawTime"])
        official_numbers = normalize_result(raw["lotteryDrawResult"])
        local = local_rows.get(issue)
        equipment_set = int(raw.get("lotteryEquipmentCount") or 0)
        output.append(
            {
                "issue": issue,
                "draw_date": official_date,
                "official_draw_date": official_date,
                "local_draw_date": local["draw_date"] if local else "",
                "year": int(official_date[:4]),
                "era": era_for(official_date),
                "official_numbers": official_numbers,
                "local_numbers": local["numbers"] if local else "",
                "date_match": bool(local and local["draw_date"] == official_date),
                "numbers_match": bool(
                    local and local["numbers"] == official_numbers
                ),
                "source_match": bool(
                    local
                    and local["draw_date"] == official_date
                    and local["numbers"] == official_numbers
                ),
                "equipment_set_reported": equipment_set,
                "equipment_metadata_status": (
                    "unavailable"
                    if equipment_set == 0
                    else f"reported_set_{equipment_set}"
                ),
                "official_pdf_url": str(raw.get("drawPdfUrl") or ""),
            }
        )
    for issue, local in local_rows.items():
        if issue not in official_issues:
            output.append(
                {
                    "issue": issue,
                    "draw_date": local["draw_date"],
                    "official_draw_date": "",
                    "local_draw_date": local["draw_date"],
                    "year": int(local["draw_date"][:4]),
                    "era": era_for(local["draw_date"]),
                    "official_numbers": "",
                    "local_numbers": local["numbers"],
                    "date_match": False,
                    "numbers_match": False,
                    "source_match": False,
                    "equipment_set_reported": 0,
                    "equipment_metadata_status": "missing_official_issue",
                    "official_pdf_url": "",
                }
            )
    output.sort(key=lambda row: (str(row["draw_date"]), str(row["issue"])))
    return output


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    temporary.replace(path)


def build_summary(rows: list[dict[str, object]]) -> dict[str, object]:
    equipment_sets = Counter(
        int(row["equipment_set_reported"]) for row in rows
    )
    by_year: dict[int, Counter[int]] = defaultdict(Counter)
    for row in rows:
        by_year[int(row["year"])][int(row["equipment_set_reported"])] += 1
    mismatches = [row for row in rows if not bool(row["source_match"])]
    number_mismatches = [
        row
        for row in rows
        if row["official_numbers"]
        and row["local_numbers"]
        and not bool(row["numbers_match"])
    ]
    date_conflicts = [
        row
        for row in rows
        if row["official_numbers"]
        and row["local_numbers"]
        and not bool(row["date_match"])
    ]
    return {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "official_api": API_URL,
        "local_rows": len(rows),
        "official_rows": sum(bool(row["official_numbers"]) for row in rows),
        "numbers_matched_rows": sum(bool(row["numbers_match"]) for row in rows),
        "date_matched_rows": sum(bool(row["date_match"]) for row in rows),
        "matched_rows": len(rows) - len(mismatches),
        "mismatch_count": len(mismatches),
        "mismatch_issues": [str(row["issue"]) for row in mismatches],
        "number_mismatch_count": len(number_mismatches),
        "number_mismatch_issues": [
            str(row["issue"]) for row in number_mismatches
        ],
        "date_conflict_count": len(date_conflicts),
        "date_conflict_issues": [
            str(row["issue"]) for row in date_conflicts
        ],
        "date_conflicts": [
            {
                "issue": str(row["issue"]),
                "official_draw_date": str(row["official_draw_date"]),
                "local_draw_date": str(row["local_draw_date"]),
            }
            for row in date_conflicts
        ],
        "equipment_field_note": (
            "lotteryEquipmentCount aligns with the official PDF's numbered "
            "draw-ball set wording for current draws; zero is unavailable metadata"
        ),
        "equipment_set_distribution": {
            str(key): value for key, value in sorted(equipment_sets.items())
        },
        "equipment_set_by_year": {
            str(year): {
                str(key): value for key, value in sorted(counts.items())
            }
            for year, counts in sorted(by_year.items())
        },
    }


def main() -> None:
    lab_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="复核大乐透两套官方来源")
    parser.add_argument(
        "--local-csv",
        type=Path,
        default=lab_root.parent / "dlt_history.csv",
    )
    parser.add_argument(
        "--output-csv",
        type=Path,
        default=lab_root / "results" / "dlt_source_crosscheck.csv",
    )
    parser.add_argument(
        "--summary-json",
        type=Path,
        default=lab_root / "results" / "dlt_source_crosscheck.json",
    )
    parser.add_argument("--workers", type=int, default=3)
    args = parser.parse_args()
    if not 1 <= args.workers <= 6:
        raise ValueError("workers 必须在 1 到 6 之间")

    official = fetch_all(args.workers)
    local = load_local(args.local_csv)
    rows = build_crosscheck_rows(official, local)
    write_csv(args.output_csv, rows)
    summary = build_summary(rows)
    args.summary_json.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.summary_json.with_name(args.summary_json.name + ".tmp")
    temporary.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(args.summary_json)
    print(
        f"官方 {len(official)} 期，本地 {len(local)} 期，"
        f"不一致 {summary['mismatch_count']} 期"
    )
    print(f"结果: {args.output_csv.resolve()}")


if __name__ == "__main__":
    main()
