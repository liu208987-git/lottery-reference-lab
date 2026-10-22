#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
从 500.com 抓取双色球最近 N 期开奖，合并进 data/draws.json。

用法:
  python tools/update_ssq.py [--count 30] [--data data/draws.json]
  python tools/update_ssq.py --fixture tools/fixtures/500_history.html  # 离线测试

数据源:
  https://datachart.500.com/ssq/history/newinc/history.php?start=XXXXX&end=XXXXX

设计要点:
  - 纯标准库 (urllib + re + json)，跨平台
  - 去重合并: 以 issue 为主键，同 issue 取抓取值覆盖
  - 幂等: 无新增不写文件
  - 原子写入: 先 .tmp 再替换
  - 严格校验: red 6 个互不重复 1-33, blue 1-16, issue 7 位数字
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

FIVE_HUNDRED_URL = (
    "https://datachart.500.com/ssq/history/newinc/history.php?start={start}&end={end}"
)
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

_ROW_RE = re.compile(
    r"""<tr\s+class="t_tr1">.*?
        <td>(?P<issue>\d{5})</td>
        (?:\s*<td[^>]*>(?P<r1>\d{2})</td>)
        (?:\s*<td[^>]*>(?P<r2>\d{2})</td>)
        (?:\s*<td[^>]*>(?P<r3>\d{2})</td>)
        (?:\s*<td[^>]*>(?P<r4>\d{2})</td>)
        (?:\s*<td[^>]*>(?P<r5>\d{2})</td>)
        (?:\s*<td[^>]*>(?P<r6>\d{2})</td>)
        (?:\s*<td[^>]*>(?P<blue>\d{2})</td>)
        .*?
        <td>(?P<date>\d{4}-\d{2}-\d{2})</td>
    """,
    re.DOTALL | re.VERBOSE,
)


def normalise_issue(short: str) -> str:
    """500.com 用 5 位 (26053)，站点用 7 位 (2026053)。"""
    short = short.strip()
    if len(short) != 5 or not short.isdigit():
        raise ValueError(f"bad short issue: {short!r}")
    yy = int(short[:2])
    year = 2000 + yy if yy < 80 else 1900 + yy
    return f"{year}{short[2:]}"


def validate_draw(d: dict) -> None:
    if not re.fullmatch(r"\d{7}", d["issue"]):
        raise ValueError(f"bad issue: {d['issue']}")
    reds = d["reds"]
    if len(reds) != 6 or len(set(reds)) != 6:
        raise ValueError(f"bad reds: {reds}")
    if any(r < 1 or r > 33 for r in reds):
        raise ValueError(f"red out of range: {reds}")
    if not (1 <= d["blue"] <= 16):
        raise ValueError(f"blue out of range: {d['blue']}")


def parse_500_html(html: str) -> list[dict]:
    draws = []
    for m in _ROW_RE.finditer(html):
        short_issue = m.group("issue")
        reds = sorted(int(m.group(f"r{i}")) for i in range(1, 7))
        draw = {
            "issue": normalise_issue(short_issue),
            "year": int(normalise_issue(short_issue)[:4]),
            "date": m.group("date"),
            "reds": reds,
            "blue": int(m.group("blue")),
        }
        validate_draw(draw)
        draws.append(draw)
    return draws


def fetch_500(count: int, timeout: float = 20.0) -> str:
    """抓最近 count 期。用 end=99999 表示抓到最新，start 由服务器兜底。"""
    url = FIVE_HUNDRED_URL.format(start=max(1, count), end=99999)
    # 更稳的做法：直接用 limit 查询（500.com 的 getChartdata 就是这样干的），
    # 但 history.php 接受任意范围并返回命中结果，这里用较宽的区间兜底。
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Referer": "https://datachart.500.com/ssq/history/",
            "Accept-Language": "zh-CN,zh;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    for enc in ("utf-8", "gbk", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def load_json(path: Path) -> dict:
    if not path.exists():
        return {"meta": {}, "draws": []}
    text = path.read_text(encoding="utf-8").lstrip("﻿")
    doc = json.loads(text)
    doc.setdefault("meta", {})
    doc.setdefault("draws", [])
    return doc


def merge_draws(
    existing: list[dict], fresh: Iterable[dict]
) -> tuple[list[dict], list[str]]:
    by_issue = {d["issue"]: d for d in existing}
    added = []
    for d in fresh:
        validate_draw(d)
        if d["issue"] not in by_issue:
            added.append(d["issue"])
        by_issue[d["issue"]] = d
    merged = sorted(by_issue.values(), key=lambda x: x["issue"])
    return merged, sorted(added)


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        delete=False,
        dir=str(path.parent),
        prefix=path.name + ".",
        suffix=".tmp",
    ) as tmp:
        tmp.write(content)
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)


def write_outputs(data_json: Path, doc: dict, source_label: str) -> None:
    doc["meta"]["count"] = len(doc["draws"])
    doc["meta"]["generatedAt"] = datetime.now(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    doc["meta"]["source"] = source_label
    compact = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    _atomic_write(data_json, compact)
    _atomic_write(data_json.with_name("draws.js"), "window.__SSQ_DATA__=" + compact)


def run(count: int, data_path: Path, fixture: Path | None) -> int:
    if fixture:
        html = fixture.read_text(encoding="utf-8")
        source_label = f"fixture:{fixture.name}"
    else:
        try:
            html = fetch_500(count)
        except urllib.error.URLError as e:
            print(f"fetch_failed: {e}", file=sys.stderr)
            return 2
        source_label = "500.com"

    fresh = parse_500_html(html)
    if not fresh:
        print("parse_empty: 0 rows matched", file=sys.stderr)
        return 3

    fresh = fresh[:count] if count > 0 else fresh

    doc = load_json(data_path)
    merged, added = merge_draws(doc["draws"], fresh)

    if not added:
        print(
            f"no_update (current latest={doc['draws'][-1]['issue'] if doc['draws'] else 'empty'}, "
            f"fetched {len(fresh)} rows, all already known)"
        )
        return 0

    doc["draws"] = merged
    write_outputs(data_path, doc, source_label)
    print(f"updated: added {len(added)} draws -> {', '.join(added)}")
    print(f"total: {len(merged)}")
    return 0


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--count", type=int, default=30, help="抓取最近多少期 (默认 30)")
    p.add_argument(
        "--data", type=Path, default=Path("data/draws.json"), help="draws.json 路径"
    )
    p.add_argument(
        "--fixture",
        type=Path,
        default=None,
        help="使用本地 HTML 文件代替网络抓取 (用于测试)",
    )
    args = p.parse_args(argv)
    return run(args.count, args.data, args.fixture)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
