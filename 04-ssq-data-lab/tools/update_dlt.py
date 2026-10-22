#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
从 500.com 抓取大乐透最近 N 期开奖，合并进 data/dlt-draws.json。

用法:
  python tools/update_dlt.py [--count 30] [--data data/dlt-draws.json]
  python tools/update_dlt.py --fixture tools/fixtures/dlt_500_history.html  # 离线测试

数据源:
  https://datachart.500.com/dlt/history/newinc/history.php?start=XXXXX&end=XXXXX

设计要点 (与 update_ssq.py 同构):
  - 纯标准库 (urllib + re + json), 跨平台
  - 去重合并: issue 为主键, 同 issue 取抓取值覆盖
  - 幂等: 无新增不写文件
  - 原子写入: .tmp 再替换, 同步生成 dlt-draws.js (file:// 兜底)
  - 严格校验: front 5 个互不重复 1-35, back 2 个互不重复 1-12, issue 5 位

页面结构:
  <tr class="t_tr1">[注释]<td class="t_tr1">26054</td>
    <td class="cfont2">02</td>...<td class="cfont2">24</td>
    <td class="cfont4">08</td><td class="cfont4">11</td>
    ...更多 td...<td class="t_tr1">2026-05-18</td></tr>
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
    "https://datachart.500.com/dlt/history/newinc/history.php?start={start}&end={end}"
)
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# 大乐透行：先剪出整行（行首 t_tr1，行内有 5 个 cfont2 + 2 个 cfont4），再单独抽各字段。
_ROW_RE = re.compile(
    r'<tr\s+class="t_tr1">.*?</tr>',
    re.DOTALL,
)
_ISSUE_RE = re.compile(r'<td[^>]*class="t_tr1"[^>]*>\s*(\d{5})\s*</td>')
_FRONT_RE = re.compile(r'<td[^>]*class="[^"]*cfont2[^"]*"[^>]*>\s*(\d{2})\s*</td>')
_BACK_RE = re.compile(r'<td[^>]*class="[^"]*cfont4[^"]*"[^>]*>\s*(\d{2})\s*</td>')
_DATE_RE = re.compile(r'(\d{4}-\d{2}-\d{2})')


def issue_year(short: str) -> int:
    """5 位期号取年份 (大乐透 2007 年开售)。"""
    yy = int(short[:2])
    return 2000 + yy if yy < 80 else 1900 + yy


def validate_draw(d: dict) -> None:
    if not re.fullmatch(r"\d{5}", d["issue"]):
        raise ValueError(f"bad issue: {d['issue']}")
    front = d["front"]
    if len(front) != 5 or len(set(front)) != 5:
        raise ValueError(f"bad front: {front}")
    if any(r < 1 or r > 35 for r in front):
        raise ValueError(f"front out of range: {front}")
    back = d["back"]
    if len(back) != 2 or len(set(back)) != 2:
        raise ValueError(f"bad back: {back}")
    if any(r < 1 or r > 12 for r in back):
        raise ValueError(f"back out of range: {back}")


_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)


def parse_500_html(html: str) -> list[dict]:
    # 先剥离 HTML 注释 (500.com 真实页面里有 <!--<td>2</td>--> 这种序号注释干扰正则)。
    html = _COMMENT_RE.sub("", html)
    draws = []
    for row_match in _ROW_RE.finditer(html):
        row = row_match.group(0)
        # 行首第一个 issue
        issue_m = _ISSUE_RE.search(row)
        if not issue_m:
            continue
        issue = issue_m.group(1)
        # 5 个前区
        front_matches = _FRONT_RE.findall(row)
        if len(front_matches) < 5:
            continue
        front = sorted(int(x) for x in front_matches[:5])
        # 2 个后区
        back_matches = _BACK_RE.findall(row)
        if len(back_matches) < 2:
            continue
        back = sorted(int(x) for x in back_matches[:2])
        # 日期：取行内最后一个 yyyy-mm-dd
        date_matches = _DATE_RE.findall(row)
        date = date_matches[-1] if date_matches else None
        draw = {
            "issue": issue,
            "year": issue_year(issue),
            "date": date,
            "front": front,
            "back": back,
        }
        try:
            validate_draw(draw)
        except ValueError:
            continue
        draws.append(draw)
    return draws


def fetch_500(count: int, timeout: float = 20.0) -> str:
    """抓最近 count 期。end=99999 让服务器返回最新。"""
    url = FIVE_HUNDRED_URL.format(start=max(1, count), end=99999)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Referer": "https://datachart.500.com/dlt/history/",
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
    text = path.read_text(encoding="utf-8").lstrip("")
    if not text.strip():
        return {"meta": {}, "draws": []}
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
    _atomic_write(data_json.with_name("dlt-draws.js"), "window.__DLT_DATA__=" + compact)


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
    print(f"updated: added {len(added)} draws -> {', '.join(added[:5])}{('...' if len(added) > 5 else '')}")
    print(f"total: {len(merged)}")
    return 0


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--count", type=int, default=30, help="抓取最近多少期 (默认 30)")
    p.add_argument(
        "--data", type=Path, default=Path("data/dlt-draws.json"), help="dlt-draws.json 路径"
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
