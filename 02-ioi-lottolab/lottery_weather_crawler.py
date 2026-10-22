"""彩票开奖日天气爬取脚本

从历史天气网站爬取双色球和大乐透开奖日的天气数据。
- 双色球开奖地点：北京（每周二、四、日开奖）
- 大乐透开奖地点：北京（每周一、三、六开奖）

数据源：lishi.tianqi.com（历史天气）
保存：lottery_weather.db（独立SQLite，不修改原始数据库）

运行：python lottery_weather_crawler.py [--game ssq|dlt|all] [--limit N]
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote

import requests
from bs4 import BeautifulSoup


# ============================================================
# 配置
# ============================================================

WEATHER_DB = Path(__file__).resolve().parent / "lottery_weather.db"
CITY = "beijing"  # 开奖地点：北京
CITY_CN = "北京"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

# 数据源最早可用年份（tianqihoubao.com从2012年开始有完整数据）
MIN_YEAR = 2012

# 双色球开奖日：周二(1)、周四(3)、周日(6)
SSQ_WEEKDAYS = {1, 3, 6}
# 大乐透开奖日：周一(0)、周三(2)、周六(5)
DLT_WEEKDAYS = {0, 2, 5}


# ============================================================
# 数据库初始化
# ============================================================

def init_db():
    """初始化天气数据库。"""
    conn = sqlite3.connect(WEATHER_DB)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS lottery_weather (
            issue TEXT NOT NULL,
            game TEXT NOT NULL,          -- ssq / dlt
            draw_date TEXT NOT NULL,     -- 开奖日期 YYYY-MM-DD
            city TEXT NOT NULL,          -- 城市
            weather TEXT,                -- 天气状况（晴/多云/阴/雨/雪等）
            temp_high REAL,              -- 最高气温
            temp_low REAL,               -- 最低气温
            humidity TEXT,               -- 湿度（如有）
            wind_dir TEXT,               -- 风向
            wind_level TEXT,             -- 风力等级
            aqi TEXT,                    -- 空气质量指数（如有）
            raw_html TEXT,               -- 原始HTML片段（备用）
            crawled_at TEXT NOT NULL,    -- 爬取时间
            PRIMARY KEY (issue, game)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_draw_date ON lottery_weather(draw_date)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_game_issue ON lottery_weather(game, issue)
    """)
    conn.commit()
    conn.close()
    print(f"天气数据库: {WEATHER_DB}")


# ============================================================
# 历史天气爬取
# ============================================================

def parse_weather_page(html: str, target_date: str) -> dict | None:
    """解析历史天气页面，提取指定日期的天气数据。

    数据源：tianqihoubao.com
    页面结构：table，每行一个日期
    文本格式：2025年06月01日|阴 / 雷阵雨|26℃|/|17℃|东风 1-3级 / 东南风 1-3级

    target_date 格式：YYYY-MM-DD
    如果target_date未精确匹配，尝试前后1天的日期。
    """
    soup = BeautifulSoup(html, "html.parser")

    # 提取所有行（table tr）
    rows = soup.select("tr")

    # 构建日期→天气映射
    date_weather: dict[str, dict] = {}
    for row in rows:
        text = row.get_text(separator="|", strip=True)
        # 提取日期：支持 "2025年06月01日" 和 "2025-06-01" 两种格式
        date_match = re.search(r"(\d{4})年(\d{2})月(\d{2})日", text)
        if date_match:
            d = f"{date_match.group(1)}-{date_match.group(2)}-{date_match.group(3)}"
        else:
            date_match = re.match(r"(\d{4}-\d{2}-\d{2})", text)
            if date_match:
                d = date_match.group(1)
            else:
                continue
        date_weather[d] = _parse_entry(text)

    if not date_weather:
        return None

    # 精确匹配
    if target_date in date_weather:
        return date_weather[target_date]

    # 模糊匹配：前后1天
    try:
        target_dt = datetime.strptime(target_date, "%Y-%m-%d")
        for offset in [-1, 1, -2, 2]:
            alt_date = (target_dt + timedelta(days=offset)).strftime("%Y-%m-%d")
            if alt_date in date_weather:
                return date_weather[alt_date]
    except ValueError:
        pass

    return None


def _parse_entry(text: str) -> dict:
    """解析单条天气记录文本。

    典型格式（tianqihoubao.com）：
    "2025年06月01日|阴 /  雷阵雨|26℃|/|17℃|东风 1-3级 / 东南风 1-3级"

    字段顺序：日期 | 天气状况(白天/夜间) | 最高气温 | 分隔符 | 最低气温 | 风向风力(白天/夜间)
    """
    result = {
        "weather": None,
        "temp_high": None,
        "temp_low": None,
        "humidity": None,
        "wind_dir": None,
        "wind_level": None,
    }

    # 天气状况
    weather_patterns = [
        "暴雪", "大雨", "大雪", "小雨", "中雨", "中雪", "阵雨", "雷阵雨",
        "小雪", "雨夹雪", "冻雨", "雾", "霾", "浮尘", "扬沙", "沙尘暴",
        "多云", "阴", "晴", "大雨到暴雨",
    ]
    for w in weather_patterns:
        if w in text:
            result["weather"] = w
            break

    # 气温（支持 ℃ 和度，支持 X℃/Y℃ 或 X℃ Y℃ 格式）
    temps = re.findall(r"(-?\d+(?:\.\d+)?)\s*[℃°]", text)
    if len(temps) >= 2:
        result["temp_high"] = float(temps[0])
        result["temp_low"] = float(temps[1])
    elif len(temps) == 1:
        result["temp_high"] = float(temps[0])

    # 风向
    wind_patterns = [
        "东北风", "东南风", "西北风", "西南风",
        "东风", "南风", "西风", "北风", "无持续风向",
    ]
    for w in wind_patterns:
        if w in text:
            result["wind_dir"] = w
            break

    # 风力等级
    wind_match = re.search(r"(\d+[-~]\d+级|\d+级)", text)
    if wind_match:
        result["wind_level"] = wind_match.group(1)

    # 湿度（页面有时提供）
    humidity_match = re.search(r"湿度[:\s]*(\d+%)", text)
    if humidity_match:
        result["humidity"] = humidity_match.group(1)

    return result


def fetch_month_weather(year: int, month: int, city: str = CITY) -> str | None:
    """获取指定月份的历史天气页面HTML。

    数据源：tianqihoubao.com
    URL格式: https://www.tianqihoubao.com/lishi/{city}/month/{YYYYMM}.html
    带重试机制。
    """
    url = f"https://www.tianqihoubao.com/lishi/{city}/month/{year}{month:02d}.html"
    max_retries = 3
    for attempt in range(max_retries):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=30)
            if resp.status_code == 200:
                resp.encoding = "utf-8"
                return resp.text
            elif resp.status_code == 404:
                return None
            else:
                print(f"  HTTP {resp.status_code} - {url} (attempt {attempt+1})")
        except Exception as e:
            print(f"  请求失败 {url} (attempt {attempt+1}): {e}")
        if attempt < max_retries - 1:
            time.sleep(3)
    return None


# ============================================================
# 主爬取逻辑
# ============================================================

def get_draw_dates_from_db(game: str) -> list[tuple[str, str]]:
    """从开奖数据库获取期号和开奖日期列表。

    Returns:
        [(issue, draw_date), ...]  draw_date 格式 YYYY-MM-DD
    """
    if game == "ssq":
        import ssq_db as db
    else:
        import dlt_db as db
    db.init_db()
    rows = db.get_all_draws("ASC")
    result = []
    for row in rows:
        issue = row["issue"]
        # 从 issue 解析日期（如 2024015 → 2024-01-05 附近）
        # 或直接从数据库date字段（如有）
        date_str = _resolve_draw_date(issue, game)
        if date_str:
            result.append((issue, date_str))
    return result


def _resolve_draw_date(issue: str, game: str) -> str | None:
    """根据期号精确推算开奖日期。

    双色球：周二、四、日开奖（每周3期）
    大乐透：周一、三、六开奖（每周3期）

    推算方法：
    1. 找到当年1月1日后的第一个开奖日 = 期号1
    2. 生成开奖日序列（按开奖日顺序排列）
    3. 期号N = 序列第N项

    期号格式：YYYYNNN（如2024001）
    """
    if len(issue) < 7:
        return None
    year = int(issue[:4])
    seq = int(issue[4:])

    weekdays = SSQ_WEEKDAYS if game == "ssq" else DLT_WEEKDAYS

    # 1月1日
    jan1 = datetime(year, 1, 1)

    # 找到1月1日后的第一个开奖日
    # 如果1月1日本身就是开奖日，那就是期号1
    first_draw = jan1
    while first_draw.weekday() not in weekdays:
        first_draw += timedelta(days=1)

    # 生成开奖日序列的周期模式
    # 一周内开奖日按升序排列：如SSQ=[周二(1), 周四(3), 周日(6)]
    sorted_weekdays = sorted(weekdays)

    # 期号1的weekday在sorted_weekdays中的位置
    first_wd_pos = sorted_weekdays.index(first_draw.weekday())

    # 计算期号seq对应的开奖日
    # 每3期一个完整周期（7天）
    cycle_idx = (seq - 1) // 3  # 第几个完整周期
    pos_in_cycle = (seq - 1) % 3  # 周期内位置

    # 周期内偏移天数
    # 第一期偏移=0
    # 后续期偏移 = 当前weekday到下一个开奖weekday的天数
    offsets = [0]  # 第一期偏移0
    for i in range(2):  # 计算下两期的偏移
        curr_pos = (first_wd_pos + i) % len(sorted_weekdays)
        next_pos = (first_wd_pos + i + 1) % len(sorted_weekdays)
        if next_pos > curr_pos:
            offset = sorted_weekdays[next_pos] - sorted_weekdays[curr_pos]
        else:
            # 跨周
            offset = 7 - sorted_weekdays[curr_pos] + sorted_weekdays[next_pos]
        offsets.append(offsets[-1] + offset)

    draw_day = first_draw + timedelta(
        days=cycle_idx * 7 + offsets[pos_in_cycle]
    )
    return draw_day.strftime("%Y-%m-%d")


def crawl_weather_for_game(game: str, limit: int | None = None, resume: bool = True):
    """爬取指定彩种的天气数据。"""
    print(f"\n{'='*60}")
    print(f"开始爬取 {game.upper()} 开奖日天气")
    print(f"{'='*60}")

    draw_dates = get_draw_dates_from_db(game)
    print(f"从数据库获取 {len(draw_dates)} 期开奖数据")

    if limit:
        draw_dates = draw_dates[-limit:]
        print(f"限制爬取最近 {limit} 期")

    # 已爬取的期号（用于断点续传）
    crawled_issues = set()
    if resume:
        conn = sqlite3.connect(WEATHER_DB)
        rows = conn.execute(
            "SELECT issue FROM lottery_weather WHERE game = ?", (game,)
        ).fetchall()
        crawled_issues = {r[0] for r in rows}
        conn.close()
        if crawled_issues:
            print(f"已爬取 {len(crawled_issues)} 期，跳过")

    # 按 (year, month) 分组，减少请求次数
    month_groups: dict[tuple[int, int], list[tuple[str, str]]] = {}
    for issue, draw_date in draw_dates:
        if issue in crawled_issues:
            continue
        try:
            dt = datetime.strptime(draw_date, "%Y-%m-%d")
        except ValueError:
            continue
        # 跳过数据源不可用的年份
        if dt.year < MIN_YEAR:
            continue
        key = (dt.year, dt.month)
        if key not in month_groups:
            month_groups[key] = []
        month_groups[key].append((issue, draw_date))

    print(f"需要爬取 {sum(len(v) for v in month_groups.values())} 期，"
          f"分布在 {len(month_groups)} 个月份")

    # 按月爬取
    total_inserted = 0
    for (year, month), items in sorted(month_groups.items()):
        # 跳过未来月份
        now = datetime.now()
        if year > now.year or (year == now.year and month > now.month):
            continue

        print(f"\n  爬取 {year}-{month:02d}（{len(items)}期）")
        html = fetch_month_weather(year, month, CITY)
        if html is None:
            print(f"    未能获取 {year}-{month:02d} 的天气页面")
            continue

        # 解析每一期
        batch = []
        for issue, draw_date in items:
            weather = parse_weather_page(html, draw_date)
            if weather is None:
                print(f"    {issue} ({draw_date}): 未找到天气数据")
                # 尝试前一天（开奖日推算可能差一天）
                try:
                    dt = datetime.strptime(draw_date, "%Y-%m-%d")
                    prev_date = (dt - timedelta(days=1)).strftime("%Y-%m-%d")
                    weather = parse_weather_page(html, prev_date)
                    if weather:
                        print(f"    {issue}: 用前一日数据替代")
                except Exception:
                    pass

            if weather:
                batch.append({
                    "issue": issue,
                    "game": game,
                    "draw_date": draw_date,
                    "city": CITY_CN,
                    "weather": weather.get("weather"),
                    "temp_high": weather.get("temp_high"),
                    "temp_low": weather.get("temp_low"),
                    "humidity": weather.get("humidity"),
                    "wind_dir": weather.get("wind_dir"),
                    "wind_level": weather.get("wind_level"),
                    "aqi": None,
                    "raw_html": None,
                    "crawled_at": datetime.now().isoformat(timespec="seconds"),
                })

        if batch:
            _batch_insert(batch)
            total_inserted += len(batch)
            print(f"    插入 {len(batch)}/{len(items)} 期天气数据")

        # 礼貌延时
        time.sleep(1.5)

    print(f"\n{game.upper()} 天气爬取完成：新增 {total_inserted} 期")
    return total_inserted


def _batch_insert(records: list[dict]):
    """批量插入天气数据。"""
    conn = sqlite3.connect(WEATHER_DB)
    for r in records:
        conn.execute("""
            INSERT OR REPLACE INTO lottery_weather
            (issue, game, draw_date, city, weather, temp_high, temp_low,
             humidity, wind_dir, wind_level, aqi, raw_html, crawled_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            r["issue"], r["game"], r["draw_date"], r["city"],
            r["weather"], r["temp_high"], r["temp_low"],
            r["humidity"], r["wind_dir"], r["wind_level"],
            r["aqi"], r["raw_html"], r["crawled_at"],
        ))
    conn.commit()
    conn.close()


# ============================================================
# 统计报告
# ============================================================

def print_summary(game: str):
    """打印已爬取数据的统计摘要。"""
    conn = sqlite3.connect(WEATHER_DB)
    rows = conn.execute("""
        SELECT game, COUNT(*) as total,
               COUNT(weather) as has_weather,
               COUNT(temp_high) as has_temp,
               COUNT(wind_dir) as has_wind,
               MIN(draw_date) as earliest,
               MAX(draw_date) as latest
        FROM lottery_weather WHERE game = ?
    """, (game,)).fetchone()
    conn.close()

    if rows and rows[1] > 0:
        print(f"\n{game.upper()} 天气数据统计：")
        print(f"  总期数: {rows[1]}")
        print(f"  有天气状况: {rows[2]} ({rows[2]/rows[1]*100:.1f}%)")
        print(f"  有气温: {rows[3]} ({rows[3]/rows[1]*100:.1f}%)")
        print(f"  有风向: {rows[4]} ({rows[4]/rows[1]*100:.1f}%)")
        print(f"  日期范围: {rows[5]} ~ {rows[6]}")
    else:
        print(f"\n{game.upper()} 无天气数据")


# ============================================================
# 主入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="彩票开奖日天气爬取")
    parser.add_argument("--game", choices=["ssq", "dlt", "all"], default="all",
                        help="爬取哪个彩种（默认all）")
    parser.add_argument("--limit", type=int, default=None,
                        help="限制爬取期数（从最近开始算）")
    parser.add_argument("--summary-only", action="store_true",
                        help="只打印统计摘要，不爬取")
    args = parser.parse_args()

    init_db()

    if args.summary_only:
        for g in ("ssq", "dlt"):
            print_summary(g)
        return

    games = ["ssq", "dlt"] if args.game == "all" else [args.game]
    for game in games:
        try:
            crawl_weather_for_game(game, limit=args.limit)
            print_summary(game)
        except Exception as e:
            print(f"\n{game.upper()} 爬取失败：{e}")
            import traceback
            traceback.print_exc()

    print("\n爬取完成。")


if __name__ == "__main__":
    main()