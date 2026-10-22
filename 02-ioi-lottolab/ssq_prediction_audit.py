"""双色球预测的预测前锁定、开奖后结算与公平对比。

彩票模型很容易在看到开奖结果后反向调整。这个模块把每个算法针对下一期的
完整票组先写入独立 SQLite 台账，开奖进入 ssq.db 后再结算，且默认不允许
覆盖同一期同一算法的首次预测。这样长期比较使用的是真正样本外结果。
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime
import json
from pathlib import Path
import sqlite3
from typing import Iterable

from app_paths import DATA_ROOT

AUDIT_DB_PATH = DATA_ROOT / "ssq_prediction_audit.db"

PRIZE_RANK = {
    "一等奖": 1,
    "二等奖": 2,
    "三等奖": 3,
    "四等奖": 4,
    "五等奖": 5,
    "六等奖": 6,
}


@contextmanager
def _connection(path: Path = AUDIT_DB_PATH):
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_audit_db(path: Path = AUDIT_DB_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with _connection(path) as connection:
        connection.execute("""
        CREATE TABLE IF NOT EXISTS predictions (
            issue           TEXT NOT NULL,
            algorithm       TEXT NOT NULL,
            trained_through TEXT NOT NULL,
            tickets_json    TEXT NOT NULL,
            model_json      TEXT NOT NULL,
            provenance      TEXT NOT NULL,
            generated_at    TEXT NOT NULL,
            settled_at      TEXT,
            actual_json     TEXT,
            metrics_json    TEXT,
            PRIMARY KEY (issue, algorithm)
        )
        """)


def next_issue(issue: str) -> str:
    year, sequence = int(issue[:4]), int(issue[4:])
    return f"{year}{sequence + 1:03d}"


def _normalize_tickets(tickets: Iterable) -> list[list[list[int]]]:
    normalized = []
    for reds, blues in tickets:
        reds = sorted(int(number) for number in reds)
        blues = sorted(int(number) for number in blues)
        if (len(reds) != 6 or len(set(reds)) != 6
                or not all(1 <= number <= 33 for number in reds)):
            raise ValueError(f"非法红球组合：{reds}")
        if (len(blues) != 1 or not 1 <= blues[0] <= 16):
            raise ValueError(f"非法蓝球组合：{blues}")
        normalized.append([reds, blues])
    if not normalized:
        raise ValueError("预测票组不能为空")
    return normalized


def record_prediction(
    issue: str,
    algorithm: str,
    trained_through: str,
    tickets: Iterable,
    *,
    model_info: dict | None = None,
    provenance: str = "prospective_locked",
    generated_at: str | None = None,
    path: Path = AUDIT_DB_PATH,
) -> bool:
    """锁定首次预测；已存在同一期同一算法时返回 False，绝不覆盖。"""
    init_audit_db(path)
    normalized = _normalize_tickets(tickets)
    if str(issue) <= str(trained_through):
        raise ValueError("预测期必须晚于训练数据截止期，防止把已知结果记作预测")
    with _connection(path) as connection:
        cursor = connection.execute("""
            INSERT OR IGNORE INTO predictions
            (issue,algorithm,trained_through,tickets_json,model_json,provenance,generated_at)
            VALUES (?,?,?,?,?,?,?)
        """, (
            str(issue), str(algorithm), str(trained_through),
            json.dumps(normalized, ensure_ascii=False),
            json.dumps(model_info or {}, ensure_ascii=False),
            str(provenance),
            generated_at or datetime.now().isoformat(timespec="seconds"),
        ))
        return cursor.rowcount == 1


def prize_level(red_hits: int, blue_hits: int) -> str | None:
    pair = red_hits, blue_hits
    if pair == (6, 1):
        return "一等奖"
    if pair == (6, 0):
        return "二等奖"
    if pair == (5, 1):
        return "三等奖"
    if pair in {(5, 0), (4, 1)}:
        return "四等奖"
    if pair in {(4, 0), (3, 1)}:
        return "五等奖"
    if pair in {(2, 1), (1, 1), (0, 1)}:
        return "六等奖"
    return None


def evaluate_tickets(
    tickets: Iterable,
    actual_reds: Iterable[int],
    actual_blue: int,
) -> dict:
    tickets = _normalize_tickets(tickets)
    actual_reds = set(int(number) for number in actual_reds)
    actual_blue = int(actual_blue)
    if len(actual_reds) != 6 or not all(1 <= number <= 33 for number in actual_reds):
        raise ValueError("实际红球必须是6个不同的01-33号码")
    if not 1 <= actual_blue <= 16:
        raise ValueError("实际蓝球必须是01-16号码")

    details = []
    red_union: set[int] = set()
    for index, (reds, blues) in enumerate(tickets, 1):
        red_union.update(reds)
        red_hits = len(set(reds) & actual_reds)
        blue_hits = int(actual_blue in blues)
        prize = prize_level(red_hits, blue_hits)
        details.append({
            "ticket": index,
            "reds": reds,
            "blues": blues,
            "red_hits": red_hits,
            "blue_hits": blue_hits,
            "prize": prize,
            "prize_rank": PRIZE_RANK.get(prize),
        })
    winning = [detail for detail in details if detail["prize"]]
    ranks = [detail["prize_rank"] for detail in winning]
    total_red_hits = sum(detail["red_hits"] for detail in details)
    total_blue_hits = sum(detail["blue_hits"] for detail in details)
    return {
        "ticket_count": len(details),
        "details": details,
        "total_red_hits": total_red_hits,
        "total_blue_hits": total_blue_hits,
        "average_red_hits": total_red_hits / len(details),
        "max_red_hits": max(detail["red_hits"] for detail in details),
        "max_blue_hits": max(detail["blue_hits"] for detail in details),
        "union_red_hits": len(red_union & actual_reds),
        "union_blue_hits": int(total_blue_hits > 0),
        "blue_covered": any(detail["blue_hits"] for detail in details),
        "winning_tickets": len(winning),
        "best_prize": min(ranks) if ranks else None,
        "best_prize_name": (
            next(name for name, rank in PRIZE_RANK.items() if rank == min(ranks))
            if ranks else None
        ),
    }


def settle_issue(
    issue: str,
    actual_reds: Iterable[int],
    actual_blue: int,
    *,
    path: Path = AUDIT_DB_PATH,
) -> int:
    init_audit_db(path)
    actual = {"reds": sorted(int(number) for number in actual_reds),
              "blue": int(actual_blue)}
    settled = 0
    with _connection(path) as connection:
        rows = connection.execute(
            "SELECT * FROM predictions WHERE issue=? AND settled_at IS NULL",
            (str(issue),),
        ).fetchall()
        for row in rows:
            tickets = json.loads(row["tickets_json"])
            metrics = evaluate_tickets(tickets, actual["reds"], actual["blue"])
            connection.execute("""
                UPDATE predictions
                SET settled_at=?, actual_json=?, metrics_json=?
                WHERE issue=? AND algorithm=?
            """, (
                datetime.now().isoformat(timespec="seconds"),
                json.dumps(actual, ensure_ascii=False),
                json.dumps(metrics, ensure_ascii=False),
                str(issue), row["algorithm"],
            ))
            settled += 1
    return settled


def settle_available(draws: Iterable[dict], *, path: Path = AUDIT_DB_PATH) -> int:
    init_audit_db(path)
    draws_by_issue = {str(row["issue"]): row for row in draws}
    with _connection(path) as connection:
        issues = [row["issue"] for row in connection.execute(
            "SELECT DISTINCT issue FROM predictions WHERE settled_at IS NULL"
        ).fetchall()]
    total = 0
    for issue in issues:
        if issue not in draws_by_issue:
            continue
        row = draws_by_issue[issue]
        total += settle_issue(
            issue,
            [row[f"r{index}"] for index in range(1, 7)],
            row["b1"],
            path=path,
        )
    return total


def issue_report(issue: str, *, path: Path = AUDIT_DB_PATH) -> list[dict]:
    init_audit_db(path)
    with _connection(path) as connection:
        rows = connection.execute(
            "SELECT * FROM predictions WHERE issue=? ORDER BY algorithm",
            (str(issue),),
        ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["tickets"] = json.loads(item.pop("tickets_json"))
        item["model"] = json.loads(item.pop("model_json"))
        item["actual"] = json.loads(item.pop("actual_json")) if item["actual_json"] else None
        item["metrics"] = json.loads(item.pop("metrics_json")) if item["metrics_json"] else None
        result.append(item)
    return result


def scoreboard(*, path: Path = AUDIT_DB_PATH) -> list[dict]:
    """只比较所有算法都已结算的共同期号，避免样本区间不公平。"""
    init_audit_db(path)
    with _connection(path) as connection:
        rows = connection.execute(
            "SELECT algorithm,issue,metrics_json FROM predictions "
            "WHERE metrics_json IS NOT NULL ORDER BY issue,algorithm"
        ).fetchall()
    by_algorithm: dict[str, dict[str, dict]] = {}
    for row in rows:
        by_algorithm.setdefault(row["algorithm"], {})[row["issue"]] = json.loads(
            row["metrics_json"])
    if not by_algorithm:
        return []
    common_issues = set.intersection(
        *(set(values) for values in by_algorithm.values()))
    result = []
    for algorithm, by_issue in sorted(by_algorithm.items()):
        metrics = [by_issue[issue] for issue in sorted(common_issues)]
        if not metrics:
            continue
        ticket_count = sum(item["ticket_count"] for item in metrics)
        result.append({
            "algorithm": algorithm,
            "common_periods": len(metrics),
            "tickets": ticket_count,
            "average_red_hits": (
                sum(item["total_red_hits"] for item in metrics) / ticket_count),
            "blue_coverage_rate": (
                sum(item["blue_covered"] for item in metrics) / len(metrics)),
            "prize_period_rate": (
                sum(item["winning_tickets"] > 0 for item in metrics) / len(metrics)),
            "winning_tickets": sum(item["winning_tickets"] for item in metrics),
            "average_max_red_hits": (
                sum(item["max_red_hits"] for item in metrics) / len(metrics)),
        })
    return result
