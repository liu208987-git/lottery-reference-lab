# -*- coding: utf-8 -*-
"""
双色球历史数据增量抓取脚本（增强反爬版）
功能：增量获取最新数据，计算分析字段，写入 ssq_history 表
"""
import sys
import os
from pathlib import Path

# 添加项目根目录到 Python 路径
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import requests
import time
import math
import random
import pymysql
from datetime import datetime
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ==================== 从统一配置导入数据库配置 ====================
from app.core.config import settings

DB_CONFIG = {
    'host': settings.MYSQL_HOST,
    'port': settings.MYSQL_PORT,
    'user': settings.MYSQL_USER,
    'password': settings.MYSQL_PASSWORD,
    'database': settings.MYSQL_DATABASE,
    'charset': 'utf8mb4'
}

# ==================== API 配置 ====================
API_URL = "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice"
PAGE_SIZE = 30
MAX_PAGES = 70

# ==================== 创建带重试机制的 Session ====================
def create_session():
    """创建带重试机制的 requests Session"""
    session = requests.Session()
    retry_strategy = Retry(
        total=3,
        backoff_factor=2,
        status_forcelist=[403, 429, 500, 502, 503, 504],
        allowed_methods=["GET"]
    )
    adapter = HTTPAdapter(max_retries=retry_strategy, pool_connections=10, pool_maxsize=10)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


# ==================== 增强版请求头 ====================
def get_headers():
    """动态生成请求头，模拟真实浏览器"""
    user_agents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0 Safari/537.36',
    ]
    return {
        'User-Agent': random.choice(user_agents),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.cwl.gov.cn/',
        'Origin': 'https://www.cwl.gov.cn',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
    }


def get_cookies():
    """获取必要的 Cookie（模拟浏览器首次访问）"""
    return {
        'Hm_lvt_': str(int(time.time())),
        'Hm_lpvt_': str(int(time.time())),
    }


# ==================== 带重试的请求函数 ====================
def fetch_page_with_retry(page_no, max_retries=5, base_delay=3):
    """
    获取单页数据，支持指数退避重试
    """
    params = {
        "name": "ssq",
        "pageNo": page_no,
        "pageSize": PAGE_SIZE,
        "systemType": "PC"
    }

    session = create_session()

    for attempt in range(max_retries):
        try:
            headers = get_headers()
            cookies = get_cookies()
            response = session.get(
                API_URL,
                params=params,
                headers=headers,
                cookies=cookies,
                timeout=20
            )

            if response.status_code == 200:
                try:
                    data = response.json()
                    if data.get('state') == 0 and 'result' in data:
                        return data['result']
                    else:
                        print(f"  第{page_no}页返回数据格式异常: {data.get('message', '未知错误')}")
                        if attempt < max_retries - 1:
                            time.sleep(base_delay * (attempt + 1))
                        continue
                except Exception as e:
                    print(f"  第{page_no}页 JSON 解析失败: {e}")
                    if attempt < max_retries - 1:
                        time.sleep(base_delay * (attempt + 1))
                    continue

            elif response.status_code == 403:
                delay = base_delay * (2 ** attempt)  # 指数退避: 3, 6, 12, 24, 48
                print(f"  第{page_no}页被拒绝(403)，尝试 {attempt + 1}/{max_retries}，等待 {delay:.1f}s")
                time.sleep(delay)
                # 换一个 User-Agent
                continue

            elif response.status_code == 429:
                delay = base_delay * (2 ** attempt) + random.uniform(0, 2)
                print(f"  第{page_no}页触发限流(429)，等待 {delay:.1f}s")
                time.sleep(delay)
                continue

            else:
                print(f"  第{page_no}页请求失败，状态码: {response.status_code}")
                if attempt < max_retries - 1:
                    time.sleep(base_delay)
                return []

        except requests.exceptions.Timeout:
            print(f"  第{page_no}页请求超时，尝试 {attempt + 1}/{max_retries}")
            time.sleep(base_delay * (attempt + 1))
        except requests.exceptions.ConnectionError:
            print(f"  第{page_no}页连接错误，尝试 {attempt + 1}/{max_retries}")
            time.sleep(base_delay * (attempt + 1))
        except Exception as e:
            print(f"  第{page_no}页请求异常: {e}，尝试 {attempt + 1}/{max_retries}")
            time.sleep(base_delay)

    print(f"  第{page_no}页重试 {max_retries} 次后仍然失败，跳过")
    return []


# ==================== 备用数据源（当主 API 失败时使用） ====================
def fetch_from_backup(page_no):
    """
    备用数据源：使用 500.com 或其他免费接口
    注：需要根据实际情况配置
    """
    # 这里仅作示例，实际可能需要调整
    backup_urls = [
        # 可以添加其他免费数据源
    ]
    return []


# ==================== 获取数据库中最大期号 ====================
def get_max_issue_from_db():
    """查询数据库中已有的最大期号"""
    connection = pymysql.connect(**DB_CONFIG)
    cursor = connection.cursor()
    cursor.execute("SELECT MAX(issue_num) FROM ssq_history")
    row = cursor.fetchone()
    cursor.close()
    connection.close()
    if row and row[0]:
        return row[0]
    return None


# ==================== 增量获取缺失数据 ====================
def fetch_missing_data(use_backup=False):
    """
    只获取数据库中缺失的最新数据
    """
    max_issue = get_max_issue_from_db()
    print(f"数据库中最大期号: {max_issue}")

    all_new_records = []
    page = 1
    consecutive_empty = 0
    consecutive_403 = 0

    while page <= MAX_PAGES:
        print(f"正在获取第 {page} 页...")

        # 尝试主数据源
        results = fetch_page_with_retry(page)

        # 如果主数据源失败且 use_backup 为 True，尝试备用
        if not results and use_backup:
            print(f"  尝试备用数据源...")
            results = fetch_from_backup(page)

        if not results:
            consecutive_empty += 1
            if consecutive_empty >= 5:
                print("连续5页无数据，获取完成！")
                break
            # 如果连续出现 403，降低请求频率
            if consecutive_403 >= 3:
                print("连续多次被拒绝，暂停 30 秒...")
                time.sleep(30)
                consecutive_403 = 0
            page += 1
            time.sleep(random.uniform(2, 5))
            continue

        consecutive_empty = 0
        consecutive_403 = 0

        # 筛选出期号大于 max_issue 的记录
        page_new_records = []
        for item in results:
            issue = item['code']
            if max_issue is None or issue > max_issue:
                page_new_records.append(item)

        if page_new_records:
            all_new_records.extend(page_new_records)
            print(f"  第{page}页获取到 {len(page_new_records)} 条新数据")

        # 如果当前页最小的期号已经 <= max_issue，说明后续页更早，可以提前退出
        if max_issue is not None and results:
            min_issue_in_page = min([r['code'] for r in results])
            if min_issue_in_page <= max_issue:
                print(f"  已到达数据库中已存在的期号，停止获取。")
                break

        page += 1
        # 随机延迟，避免被反爬
        delay = random.uniform(1.5, 4.0)
        time.sleep(delay)

    # 按期号升序排序（从旧到新，便于计算重复号）
    all_new_records.sort(key=lambda x: x['code'])
    return all_new_records


# ==================== 辅助函数（分析指标计算） ====================
def is_prime(num):
    """判断是否为质数"""
    if num < 2:
        return False
    for i in range(2, int(num ** 0.5) + 1):
        if num % i == 0:
            return False
    return True


def get_zone(num):
    """获取红球分区：1-11为1区，12-22为2区，23-33为3区"""
    if 1 <= num <= 11:
        return 1
    elif 12 <= num <= 22:
        return 2
    else:
        return 3


def is_small_red(num):
    """红球：1-16为小"""
    return num <= 16


def is_small_blue(num):
    """蓝球：1-8为小"""
    return num <= 8


def calculate_consecutive_groups(reds):
    """计算连号组数和最大连号长度"""
    reds_sorted = sorted(reds)
    groups = 0
    max_len = 0
    current_len = 1

    for i in range(1, len(reds_sorted)):
        if reds_sorted[i] == reds_sorted[i - 1] + 1:
            current_len += 1
        else:
            if current_len > 1:
                groups += 1
                max_len = max(max_len, current_len)
            current_len = 1

    if current_len > 1:
        groups += 1
        max_len = max(max_len, current_len)

    return groups, max_len


def calculate_ac_value(reds):
    """计算AC值（算术复杂性）"""
    reds_sorted = sorted(reds)
    differences = set()
    for i in range(len(reds_sorted)):
        for j in range(i + 1, len(reds_sorted)):
            differences.add(reds_sorted[j] - reds_sorted[i])
    return len(differences) - (6 - 1)


def calculate_std_dev(numbers):
    """计算标准差"""
    if not numbers:
        return 0
    mean = sum(numbers) / len(numbers)
    variance = sum((x - mean) ** 2 for x in numbers) / len(numbers)
    return math.sqrt(variance)


def calculate_analysis_fields(reds, blue, prev_reds=None, prev_blue=None):
    """计算所有分析字段"""
    # 基础统计
    red_max = max(reds)
    red_min = min(reds)
    red_span = red_max - red_min
    red_summation = sum(reds)
    red_summation_tail = red_summation % 10

    # 奇偶、大小统计
    red_odd_count = sum(1 for x in reds if x % 2 == 1)
    red_even_count = 6 - red_odd_count
    red_small_count = sum(1 for x in reds if is_small_red(x))
    red_big_count = 6 - red_small_count

    # 质合统计
    red_prime_count = sum(1 for x in reds if is_prime(x))
    red_composite_count = 6 - red_prime_count

    # 除3余数统计
    mod0 = sum(1 for x in reds if x % 3 == 0)
    mod1 = sum(1 for x in reds if x % 3 == 1)
    mod2 = sum(1 for x in reds if x % 3 == 2)

    # 分区统计
    zone1 = sum(1 for x in reds if get_zone(x) == 1)
    zone2 = sum(1 for x in reds if get_zone(x) == 2)
    zone3 = sum(1 for x in reds if get_zone(x) == 3)

    # 连号分析
    consecutive_groups, consecutive_max_len = calculate_consecutive_groups(reds)

    # 与上期重复个数
    repeat_count = 0
    if prev_reds:
        repeat_count = len(set(reds) & set(prev_reds))

    # AC值、首尾和、均值、标准差
    ac_value = calculate_ac_value(reds)
    first_last_sum = red_min + red_max
    middle_avg = round(red_summation / 6, 2)
    std_dev = round(calculate_std_dev(reds), 4)

    # 蓝球分析
    blue_odd_even = 'odd' if blue % 2 == 1 else 'even'
    blue_size = 'small' if is_small_blue(blue) else 'big'
    blue_mod3 = blue % 3
    blue_mod4 = blue % 4

    # 蓝球是否与上期重复
    blue_repeat = 0
    if prev_blue is not None and prev_blue == blue:
        blue_repeat = 1

    # 整体分析
    total_sum = red_summation + blue
    total_odd_count = red_odd_count + (1 if blue % 2 == 1 else 0)
    total_even_count = 7 - total_odd_count
    total_small_count = red_small_count + (1 if is_small_blue(blue) else 0)
    total_big_count = 7 - total_small_count

    # 特殊形态判断
    special_pattern = None
    if red_odd_count == 6:
        special_pattern = '全奇'
    elif red_even_count == 6:
        special_pattern = '全偶'
    elif red_small_count == 6:
        special_pattern = '全小'
    elif red_big_count == 6:
        special_pattern = '全大'
    elif zone1 == 0:
        special_pattern = '断一区'
    elif zone2 == 0:
        special_pattern = '断二区'
    elif zone3 == 0:
        special_pattern = '断三区'

    return {
        'red_max': red_max, 'red_min': red_min, 'red_span': red_span,
        'red_summation': red_summation, 'red_summation_tail': red_summation_tail,
        'red_odd_count': red_odd_count, 'red_even_count': red_even_count,
        'red_small_count': red_small_count, 'red_big_count': red_big_count,
        'red_prime_count': red_prime_count, 'red_composite_count': red_composite_count,
        'red_mod0_count': mod0, 'red_mod1_count': mod1, 'red_mod2_count': mod2,
        'red_zone1_count': zone1, 'red_zone2_count': zone2, 'red_zone3_count': zone3,
        'red_consecutive_groups': consecutive_groups, 'red_consecutive_max_len': consecutive_max_len,
        'red_repeat_count': repeat_count,
        'red_ac_value': ac_value, 'red_first_last_sum': first_last_sum,
        'red_middle_avg': middle_avg, 'red_std_dev': std_dev,
        'blue_odd_even': blue_odd_even, 'blue_size': blue_size,
        'blue_mod3': blue_mod3, 'blue_mod4': blue_mod4,
        'blue_repeat_flag': blue_repeat,
        'total_sum': total_sum, 'total_odd_count': total_odd_count,
        'total_even_count': total_even_count, 'total_small_count': total_small_count,
        'total_big_count': total_big_count,
        'special_pattern': special_pattern
    }


# ==================== 解析并处理数据 ====================
def process_records(records):
    """处理原始记录，计算分析字段"""
    processed_data = []
    prev_reds = None
    prev_blue = None

    for item in records:
        try:
            # 解析基本信息
            issue_num = item['code']
            date_str = item['date'].split('(')[0]
            draw_date = datetime.strptime(date_str, '%Y-%m-%d').date()
            weekday = str(draw_date.weekday() + 1)
            year = draw_date.year
            month = draw_date.month
            quarter = (month - 1) // 3 + 1

            # 解析红球和蓝球
            reds = [int(x) for x in item['red'].split(',')]
            blue = int(item['blue'])

            # 验证数据有效性
            if len(reds) != 6:
                print(f"警告: {issue_num} 红球数量不正确: {len(reds)}个，跳过")
                continue
            if not (1 <= blue <= 16):
                print(f"警告: {issue_num} 蓝球值 {blue} 超出范围，跳过")
                continue

            # 计算分析字段
            analysis = calculate_analysis_fields(reds, blue, prev_reds, prev_blue)

            row = {
                'issue_num': issue_num,
                'draw_date': draw_date,
                'weekday': weekday,
                'year': year,
                'month': month,
                'quarter': quarter,
                'red_one': reds[0], 'red_two': reds[1], 'red_three': reds[2],
                'red_four': reds[3], 'red_five': reds[4], 'red_six': reds[5],
                'blue_one': blue,
                **analysis
            }

            processed_data.append(row)
            prev_reds = reds
            prev_blue = blue

        except Exception as e:
            print(f"处理期号 {item.get('code', 'unknown')} 时出错: {e}")
            continue

    return processed_data


# ==================== 插入数据库 ====================
def insert_to_database(records):
    """将数据批量插入数据库"""
    if not records:
        print("没有数据可插入")
        return

    connection = None
    try:
        connection = pymysql.connect(**DB_CONFIG)
        cursor = connection.cursor()

        # 确保 blue_size 字段长度足够
        cursor.execute("SHOW COLUMNS FROM ssq_history LIKE 'blue_size'")
        col_info = cursor.fetchone()
        if col_info:
            col_type = col_info[1]
            if 'varchar' in col_type:
                import re
                match = re.search(r'varchar\((\d+)\)', col_type)
                if match and int(match.group(1)) < 10:
                    cursor.execute("ALTER TABLE ssq_history MODIFY COLUMN blue_size varchar(10)")
                    print("已扩展 blue_size 字段长度")

        insert_sql = """
            INSERT INTO ssq_history (
                issue_num, draw_date, weekday, year, month, quarter,
                red_one, red_two, red_three, red_four, red_five, red_six, blue_one,
                red_max, red_min, red_span, red_summation, red_summation_tail,
                red_odd_count, red_even_count, red_small_count, red_big_count,
                red_prime_count, red_composite_count,
                red_mod0_count, red_mod1_count, red_mod2_count,
                red_zone1_count, red_zone2_count, red_zone3_count,
                red_consecutive_groups, red_consecutive_max_len, red_repeat_count,
                red_ac_value, red_first_last_sum, red_middle_avg, red_std_dev,
                blue_odd_even, blue_size, blue_mod3, blue_mod4, blue_repeat_flag,
                total_sum, total_odd_count, total_even_count,
                total_small_count, total_big_count, special_pattern
            ) VALUES (
                %(issue_num)s, %(draw_date)s, %(weekday)s, %(year)s, %(month)s, %(quarter)s,
                %(red_one)s, %(red_two)s, %(red_three)s, %(red_four)s, %(red_five)s, %(red_six)s, %(blue_one)s,
                %(red_max)s, %(red_min)s, %(red_span)s, %(red_summation)s, %(red_summation_tail)s,
                %(red_odd_count)s, %(red_even_count)s, %(red_small_count)s, %(red_big_count)s,
                %(red_prime_count)s, %(red_composite_count)s,
                %(red_mod0_count)s, %(red_mod1_count)s, %(red_mod2_count)s,
                %(red_zone1_count)s, %(red_zone2_count)s, %(red_zone3_count)s,
                %(red_consecutive_groups)s, %(red_consecutive_max_len)s, %(red_repeat_count)s,
                %(red_ac_value)s, %(red_first_last_sum)s, %(red_middle_avg)s, %(red_std_dev)s,
                %(blue_odd_even)s, %(blue_size)s, %(blue_mod3)s, %(blue_mod4)s, %(blue_repeat_flag)s,
                %(total_sum)s, %(total_odd_count)s, %(total_even_count)s,
                %(total_small_count)s, %(total_big_count)s, %(special_pattern)s
            )
        """

        batch_size = 100
        total = len(records)

        for i in range(0, total, batch_size):
            batch = records[i:i + batch_size]
            cursor.executemany(insert_sql, batch)
            connection.commit()
            print(f"已插入 {min(i + batch_size, total)} / {total} 条记录")

        print(f"✅ 成功插入 {total} 条历史记录！")

    except Exception as e:
        print(f"❌ 数据库操作失败: {e}")
        if connection:
            connection.rollback()
    finally:
        if connection:
            connection.close()


# ==================== 主程序（增量更新） ====================
def main():
    print("=" * 60)
    print("双色球历史数据增量更新工具（增强反爬版）")
    print("=" * 60)

    # 获取缺失的数据
    raw_data = fetch_missing_data(use_backup=False)

    if not raw_data:
        print("没有需要更新的新数据，数据库已是最新。")
        return

    print(f"发现 {len(raw_data)} 期新数据，开始处理...")

    # 处理数据（计算分析字段）
    processed_data = process_records(raw_data)

    # 插入数据库
    insert_to_database(processed_data)

    print("\n" + "=" * 60)
    print("✅ 增量更新完成！")
    print("=" * 60)


if __name__ == "__main__":
    main()