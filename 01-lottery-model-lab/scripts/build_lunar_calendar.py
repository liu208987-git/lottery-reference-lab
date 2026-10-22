#!/usr/bin/env python3
"""Build the deterministic Chinese lunar-calendar cache used on Linux."""

from __future__ import annotations

import argparse
import csv
from datetime import date, timedelta
from pathlib import Path
from typing import Iterator

from lunar_python import Solar


LAB_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = LAB_ROOT / "model_data" / "lunar_calendar.csv"
DEFAULT_START = date(2000, 1, 1)
DEFAULT_END = date(2050, 12, 31)
FIELDNAMES = (
    "date",
    "cyclical_year",
    "month",
    "day",
    "is_leap_month",
)


def cyclical_year(lunar_year: int) -> int:
    """Return Foundation-compatible Chinese cycle year in the range 1..60."""

    return ((lunar_year - 1984) % 60) + 1


def iter_solar_dates(start: date, end: date) -> Iterator[date]:
    if start > end:
        raise ValueError("start date must not be later than end date")
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


def calendar_row(solar_date: date) -> dict[str, object]:
    lunar = Solar.fromYmd(
        solar_date.year,
        solar_date.month,
        solar_date.day,
    ).getLunar()
    raw_month = int(lunar.getMonth())
    return {
        "date": solar_date.isoformat(),
        "cyclical_year": cyclical_year(int(lunar.getYear())),
        "month": abs(raw_month),
        "day": int(lunar.getDay()),
        "is_leap_month": 1 if raw_month < 0 else 0,
    }


def build_calendar(output: Path, start: date, end: date) -> int:
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(f"{output.suffix}.tmp")
    count = 0
    with temporary.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDNAMES, lineterminator="\n")
        writer.writeheader()
        for solar_date in iter_solar_dates(start, end):
            writer.writerow(calendar_row(solar_date))
            count += 1
    temporary.replace(output)
    return count


def parse_date(raw: str) -> date:
    try:
        return date.fromisoformat(raw)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def main() -> None:
    parser = argparse.ArgumentParser(
        description="生成 Lottery Lab 固定农历缓存",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--start", type=parse_date, default=DEFAULT_START)
    parser.add_argument("--end", type=parse_date, default=DEFAULT_END)
    args = parser.parse_args()

    count = build_calendar(args.output, args.start, args.end)
    print(
        f"已生成 {count} 个日期：{args.start.isoformat()} 至 "
        f"{args.end.isoformat()} -> {args.output.resolve()}"
    )


if __name__ == "__main__":
    main()
