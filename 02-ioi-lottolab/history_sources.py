"""Full-history and incremental data synchronization from verified sources."""

from __future__ import annotations

from datetime import datetime

import requests
from bs4 import BeautifulSoup


CWL_API = (
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/"
    "kjxx/findDrawNotice"
)
URL_500 = "https://datachart.500.com/{game}/history/newinc/history.php"
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 Chrome/125.0 Safari/537.36"),
}


def _canonical_500_issue(issue):
    issue = str(issue).strip()
    if len(issue) == 5 and issue.isdigit():
        return "20" + issue
    if len(issue) == 7 and issue.isdigit():
        return issue
    raise ValueError(f"无效期号: {issue!r}")


def _validate(row, game):
    issue, reds, blues = row
    red_pick, red_pool, blue_pick, blue_pool = (
        (6, 33, 1, 16) if game == "ssq" else (5, 35, 2, 12)
    )
    if len(issue) != 7 or not issue.isdigit():
        raise ValueError(f"{game} 无效期号 {issue}")
    if (len(reds) != red_pick or len(set(reds)) != red_pick
            or not all(1 <= x <= red_pool for x in reds)):
        raise ValueError(f"{game} {issue} 前区号码非法: {reds}")
    if (len(blues) != blue_pick or len(set(blues)) != blue_pick
            or not all(1 <= x <= blue_pool for x in blues)):
        raise ValueError(f"{game} {issue} 后区号码非法: {blues}")
    return issue, sorted(reds), sorted(blues)


def fetch_500(game, start, end, timeout=120):
    response = requests.get(
        URL_500.format(game=game),
        params={"start": start, "end": end},
        headers={**HEADERS,
                 "Referer": f"https://datachart.500.com/{game}/history/history.shtml"},
        timeout=timeout,
    )
    response.raise_for_status()
    response.encoding = "utf-8"
    soup = BeautifulSoup(response.text, "html.parser")
    html_rows = soup.select("#tdata tr") or soup.select("tr.t_tr1")
    result = []
    red_pick = 6 if game == "ssq" else 5
    blue_pick = 1 if game == "ssq" else 2
    for html_row in html_rows:
        cells = [td.get_text(strip=True) for td in html_row.find_all("td")]
        if len(cells) < 1 + red_pick + blue_pick:
            continue
        try:
            issue = _canonical_500_issue(cells[0])
            reds = [int(x) for x in cells[1:1 + red_pick]]
            blues = [int(x) for x in cells[1 + red_pick:1 + red_pick + blue_pick]]
            result.append(_validate((issue, reds, blues), game))
        except (TypeError, ValueError):
            continue
    if not result:
        raise RuntimeError(f"500彩票网未返回可解析的{game}数据")
    return sorted(result, key=lambda row: row[0])


def fetch_cwl_ssq(start="2013001", end=None, timeout=120):
    end = end or f"{datetime.now().year}999"
    params = {
        "name": "ssq", "issueStart": start, "issueEnd": end,
        "pageNo": 1, "pageSize": 5000, "systemType": "PC",
    }
    response = requests.get(
        CWL_API, params=params,
        headers={**HEADERS, "Referer": "https://www.cwl.gov.cn/ygkj/wqkjgg/"},
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("message") != "查询成功":
        raise RuntimeError(f"中福彩查询失败: {payload.get('message', '未知错误')}")
    result = []
    for item in payload.get("result", []):
        try:
            row = (str(item["code"]),
                   [int(x) for x in item["red"].split(",")],
                   [int(x) for x in item["blue"].split(",")])
            result.append(_validate(row, "ssq"))
        except (KeyError, TypeError, ValueError):
            continue
    if not result:
        raise RuntimeError("中福彩未返回可解析的双色球数据")
    return sorted(result, key=lambda row: row[0])


def _merge_sources(named_sources, priority):
    by_source = {name: {row[0]: row for row in rows}
                 for name, rows in named_sources.items()}
    issues = sorted(set().union(*(rows.keys() for rows in by_source.values())))
    merged = []
    conflicts = []
    for issue in issues:
        available = [(name, by_source[name][issue]) for name in priority
                     if issue in by_source.get(name, {})]
        chosen_name, chosen = available[0]
        signatures = {(tuple(row[1]), tuple(row[2])) for _, row in available}
        if len(signatures) > 1:
            conflicts.append({"issue": issue, "chosen": chosen_name,
                              "sources": [name for name, _ in available]})
        merged.append(chosen)
    return merged, conflicts


def sync_ssq(db, full=False):
    before = db.get_count()
    lo, hi = db.get_issue_range()
    # 双色球2003年2月16日首发，全量同步从2003001开始
    full = full or before < 1500 or not lo or lo > "2003001"
    end7 = f"{datetime.now().year}999"
    # CWL API 仅支持2013年起的数据
    start7 = "2013001" if full else (hi or "2013001")
    # 500.com 支持从2003年开始的全量数据（5位期号格式）
    start5 = "03001" if full else start7[2:]
    official = fetch_cwl_ssq(start7, end7)
    secondary = fetch_500("ssq", start5, end7[2:])
    rows, conflicts = _merge_sources(
        {"cwl": official, "500": secondary}, ["cwl", "500"])
    db.upsert_many(rows)
    return {
        "game": "ssq", "mode": "full" if full else "incremental",
        "fetched": {"cwl": len(official), "500": len(secondary)},
        "merged": len(rows), "conflicts": conflicts,
        "added": db.get_count() - before, "total": db.get_count(),
        "range": db.get_issue_range(),
    }


def sync_dlt(db, full=False):
    before = db.get_count()
    lo, hi = db.get_issue_range()
    full = full or before < 2500 or not lo or lo > "2007001"
    end5 = f"{datetime.now().year % 100:02d}999"
    start5 = "07001" if full else (hi or "2007001")[2:]
    rows = fetch_500("dlt", start5, end5)
    db.upsert_many(rows)
    return {
        "game": "dlt", "mode": "full" if full else "incremental",
        "fetched": {"500": len(rows)}, "merged": len(rows), "conflicts": [],
        "added": db.get_count() - before, "total": db.get_count(),
        "range": db.get_issue_range(),
    }


def sync_game(game, db, full=False):
    if game == "ssq":
        return sync_ssq(db, full=full)
    if game == "dlt":
        return sync_dlt(db, full=full)
    raise ValueError(f"未知彩票类型: {game}")
