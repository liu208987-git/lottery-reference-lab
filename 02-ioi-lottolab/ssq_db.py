# -*- coding: utf-8 -*-
"""福彩双色球 本地数据库层（SQLite）

规则：前区(红球)6个号码01-33，后区(蓝球)1个号码01-16。

表结构：draws
    issue      期号（主键，如 2026029）
    r1..r6     前区(红球)6个号码，升序
    b1         后区(蓝球)1个号码
    red_sum    前区和值
    red_span   前区跨度(最大-最小)
    zone_ratio 区间比 一区(01-11):二区(12-22):三区(23-33)
    odd_even   奇偶比 奇:偶 （和为6）
    updated_at 更新时间
"""
import sqlite3
from contextlib import contextmanager
from datetime import datetime

from app_paths import DATA_ROOT

DB_PATH = DATA_ROOT / "ssq.db"


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_conn() as c:
        c.execute("""
        CREATE TABLE IF NOT EXISTS draws (
            issue       TEXT PRIMARY KEY,
            r1 INTEGER, r2 INTEGER, r3 INTEGER, r4 INTEGER, r5 INTEGER, r6 INTEGER,
            b1 INTEGER,
            red_sum     INTEGER,
            red_span    INTEGER,
            zone_ratio  TEXT,
            odd_even    TEXT,
            updated_at  TEXT
        )
        """)


def _features(reds):
    """根据前区6个号码计算和值/跨度/区间比/奇偶比。"""
    reds = sorted(reds)
    red_sum = sum(reds)
    red_span = reds[-1] - reds[0]
    zone = [0, 0, 0]
    for r in reds:
        if r <= 11:
            zone[0] += 1
        elif r <= 22:
            zone[1] += 1
        else:
            zone[2] += 1
    zone_ratio = f"{zone[0]}:{zone[1]}:{zone[2]}"
    odd = sum(1 for r in reds if r % 2 == 1)
    odd_even = f"{odd}:{6 - odd}"
    return red_sum, red_span, zone_ratio, odd_even


def upsert_draw(issue, reds, blues):
    """插入或更新一期。reds:6个int, blues:1个int或单元素列表。"""
    values = _validated_values(issue, reds, blues)
    with get_conn() as c:
        c.execute("""
        INSERT OR REPLACE INTO draws
        (issue,r1,r2,r3,r4,r5,r6,b1,red_sum,red_span,zone_ratio,odd_even,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, values)


def _validated_values(issue, reds, blues):
    reds = sorted(int(x) for x in reds)
    if isinstance(blues, (list, tuple)):
        blues = blues[0]
    blue = int(blues)
    if (len(reds) != 6 or len(set(reds)) != 6
            or not all(1 <= x <= 33 for x in reds)):
        raise ValueError("前区需6个不重复的1-33号码")
    if not (1 <= blue <= 16):
        raise ValueError("后区需为01-16的号码")
    red_sum, red_span, zone_ratio, odd_even = _features(reds)
    return (str(issue), *reds, blue, red_sum, red_span, zone_ratio, odd_even,
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"))


def upsert_many(rows):
    """批量写入。rows: iterable of (issue, reds, blues)。"""
    n = 0
    with get_conn() as c:
        for issue, reds, blues in rows:
            try:
                c.execute("""
                INSERT OR REPLACE INTO draws
                (issue,r1,r2,r3,r4,r5,r6,b1,red_sum,red_span,zone_ratio,odd_even,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, _validated_values(issue, reds, blues))
                n += 1
            except (TypeError, ValueError):
                continue
    return n


def get_latest_issue():
    with get_conn() as c:
        row = c.execute("SELECT MAX(issue) AS m FROM draws").fetchone()
        return row["m"] if row else None


def get_all_draws(order="ASC"):
    order = str(order).upper()
    if order not in {"ASC", "DESC"}:
        raise ValueError("order must be ASC or DESC")
    with get_conn() as c:
        return [dict(r) for r in c.execute(
            f"SELECT * FROM draws ORDER BY issue {order}").fetchall()]


def get_count():
    with get_conn() as c:
        return c.execute("SELECT COUNT(*) AS n FROM draws").fetchone()["n"]


def get_issue_range():
    with get_conn() as c:
        row = c.execute(
            "SELECT MIN(issue) AS lo, MAX(issue) AS hi FROM draws").fetchone()
        return row["lo"], row["hi"]


def has_issue(issue):
    with get_conn() as c:
        return c.execute("SELECT 1 FROM draws WHERE issue=?", (str(issue),)).fetchone() is not None
