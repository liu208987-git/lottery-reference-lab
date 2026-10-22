# -*- coding: utf-8 -*-
"""
大乐透历史数据抓取脚本（使用官方接口 webapi.sporttery.cn）
功能：获取全部历史数据，计算分析字段，写入 dlt_history 表
"""
import sys
import os
from pathlib import Path

# 添加项目根目录到 Python 路径，以便导入 config
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import requests
import pymysql
import time
import random
import math
from datetime import datetime

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
API_URL = "https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry"
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.lottery.gov.cn/',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
}
PARAMS_TEMPLATE = {
    'gameNo': '85',  # 大乐透的游戏编号固定为 85
    'provinceId': '0',
    'pageSize': '30',
    'isVerify': '1',
    'pageNo': 1
}


# ==================== 辅助函数（分析指标计算） ====================
def is_prime(num):
    if num < 2:
        return False
    for i in range(2, int(num ** 0.5) + 1):
        if num % i == 0:
            return False
    return True


def get_front_zone(num):
    """前区三区：1-12, 13-24, 25-35"""
    if num <= 12:
        return 1
    elif num <= 24:
        return 2
    else:
        return 3


def is_small_front(num):
    """前区：1-17为小，18-35为大"""
    return num <= 17


def is_small_back(num):
    """后区：1-6为小，7-12为大"""
    return num <= 6


def calc_consecutive_groups(nums):
    """连号组数和最大连号长度"""
    if len(nums) <= 1:
        return 0, 0
    nums = sorted(nums)
    groups = 0
    max_len = 1
    cur_len = 1
    for i in range(1, len(nums)):
        if nums[i] == nums[i - 1] + 1:
            cur_len += 1
        else:
            if cur_len > 1:
                groups += 1
                max_len = max(max_len, cur_len)
            cur_len = 1
    if cur_len > 1:
        groups += 1
        max_len = max(max_len, cur_len)
    return groups, max_len


def calc_ac_value(nums):
    """AC值（算术复杂性）"""
    n = len(nums)
    if n < 2:
        return 0
    nums = sorted(nums)
    diffs = set()
    for i in range(n):
        for j in range(i + 1, n):
            diffs.add(nums[j] - nums[i])
    return len(diffs) - (n - 1)


def calc_std_dev(nums):
    if len(nums) == 0:
        return 0
    mean = sum(nums) / len(nums)
    var = sum((x - mean) ** 2 for x in nums) / len(nums)
    return math.sqrt(var)


def calculate_all_fields(front, back, prev_front=None, prev_back=None):
    """计算所有分析字段"""
    front_sorted = sorted(front)
    back_sorted = sorted(back)

    # ========== 前区统计 ==========
    front_max = max(front_sorted)
    front_min = min(front_sorted)
    front_span = front_max - front_min
    front_summation = sum(front_sorted)
    front_summation_tail = front_summation % 10
    front_odd_cnt = sum(1 for x in front_sorted if x % 2 == 1)
    front_even_cnt = 5 - front_odd_cnt
    front_small_cnt = sum(1 for x in front_sorted if is_small_front(x))
    front_big_cnt = 5 - front_small_cnt
    front_prime_cnt = sum(1 for x in front_sorted if is_prime(x))
    front_composite_cnt = 5 - front_prime_cnt

    # 除3余数
    mod0 = sum(1 for x in front_sorted if x % 3 == 0)
    mod1 = sum(1 for x in front_sorted if x % 3 == 1)
    mod2 = sum(1 for x in front_sorted if x % 3 == 2)

    # 三区分布
    zone1 = sum(1 for x in front_sorted if get_front_zone(x) == 1)
    zone2 = sum(1 for x in front_sorted if get_front_zone(x) == 2)
    zone3 = sum(1 for x in front_sorted if get_front_zone(x) == 3)

    # 连号
    cons_groups, cons_max_len = calc_consecutive_groups(front_sorted)

    # 与上期重复个数
    front_repeat = 0
    if prev_front:
        front_repeat = len(set(front_sorted) & set(prev_front))

    ac = calc_ac_value(front_sorted)
    first_last_sum = front_min + front_max
    middle_avg = round(front_summation / 5, 2)
    std_dev = round(calc_std_dev(front_sorted), 4)

    # ========== 后区统计 ==========
    back_odd_cnt = sum(1 for x in back_sorted if x % 2 == 1)
    back_even_cnt = 2 - back_odd_cnt
    back_span = back_sorted[1] - back_sorted[0]
    back_summation = sum(back_sorted)
    back_summation_tail = back_summation % 10
    back_small_cnt = sum(1 for x in back_sorted if is_small_back(x))
    back_big_cnt = 2 - back_small_cnt
    back_repeat = 0
    if prev_back:
        back_repeat = len(set(back_sorted) & set(prev_back))
    back_repeat_front = 1 if (back_sorted[0] in front_sorted or back_sorted[1] in front_sorted) else 0

    # ========== 整体统计 ==========
    total_sum = front_summation + back_summation
    total_odd = front_odd_cnt + back_odd_cnt
    total_even = 7 - total_odd

    # 特殊形态
    special = None
    if front_odd_cnt == 5:
        special = '前区全奇'
    elif front_odd_cnt == 0:
        special = '前区全偶'
    elif front_small_cnt == 5:
        special = '前区全小'
    elif front_big_cnt == 5:
        special = '前区全大'
    elif zone1 == 0:
        special = '断一区'
    elif zone2 == 0:
        special = '断二区'
    elif zone3 == 0:
        special = '断三区'

    return {
        'front_max': front_max, 'front_min': front_min, 'front_span': front_span,
        'front_summation': front_summation, 'front_summation_tail': front_summation_tail,
        'front_odd_count': front_odd_cnt, 'front_even_count': front_even_cnt,
        'front_small_count': front_small_cnt, 'front_big_count': front_big_cnt,
        'front_prime_count': front_prime_cnt, 'front_composite_count': front_composite_cnt,
        'front_mod0_count': mod0, 'front_mod1_count': mod1, 'front_mod2_count': mod2,
        'front_zone1_count': zone1, 'front_zone2_count': zone2, 'front_zone3_count': zone3,
        'front_consecutive_groups': cons_groups, 'front_consecutive_max_len': cons_max_len,
        'front_repeat_count': front_repeat,
        'front_ac_value': ac, 'front_first_last_sum': first_last_sum,
        'front_middle_avg': middle_avg, 'front_std_dev': std_dev,
        'back_odd_count': back_odd_cnt, 'back_even_count': back_even_cnt,
        'back_span': back_span, 'back_summation': back_summation,
        'back_summation_tail': back_summation_tail,
        'back_small_count': back_small_cnt, 'back_big_count': back_big_cnt,
        'back_repeat_count': back_repeat, 'back_repeat_flag_front': back_repeat_front,
        'total_summation': total_sum, 'total_odd_count': total_odd,
        'total_even_count': total_even, 'special_pattern': special
    }


# ==================== 数据库操作 ====================
def get_max_issue():
    conn = pymysql.connect(**DB_CONFIG)
    cursor = conn.cursor()
    cursor.execute("SELECT MAX(issue_num) FROM dlt_history")
    row = cursor.fetchone()
    cursor.close()
    conn.close()
    return row[0] if row and row[0] else None


def insert_batch(records):
    """批量插入记录，records 为列表，每个元素是包含所有字段的字典"""
    if not records:
        return
    conn = pymysql.connect(**DB_CONFIG)
    cursor = conn.cursor()
    sql = """
          INSERT INTO dlt_history (issue_num, draw_date, weekday, year, month, quarter, \
                                   front_one, front_two, front_three, front_four, front_five, \
                                   back_one, back_two, \
                                   front_max, front_min, front_span, front_summation, front_summation_tail, \
                                   front_odd_count, front_even_count, front_small_count, front_big_count, \
                                   front_prime_count, front_composite_count, \
                                   front_mod0_count, front_mod1_count, front_mod2_count, \
                                   front_zone1_count, front_zone2_count, front_zone3_count, \
                                   front_consecutive_groups, front_consecutive_max_len, front_repeat_count, \
                                   front_ac_value, front_first_last_sum, front_middle_avg, front_std_dev, \
                                   back_odd_count, back_even_count, back_span, back_summation, back_summation_tail, \
                                   back_small_count, back_big_count, back_repeat_count, back_repeat_flag_front, \
                                   total_summation, total_odd_count, total_even_count, special_pattern) \
          VALUES (%(issue_num)s, %(draw_date)s, %(weekday)s, %(year)s, %(month)s, %(quarter)s, \
                  %(front_one)s, %(front_two)s, %(front_three)s, %(front_four)s, %(front_five)s, \
                  %(back_one)s, %(back_two)s, \
                  %(front_max)s, %(front_min)s, %(front_span)s, %(front_summation)s, %(front_summation_tail)s, \
                  %(front_odd_count)s, %(front_even_count)s, %(front_small_count)s, %(front_big_count)s, \
                  %(front_prime_count)s, %(front_composite_count)s, \
                  %(front_mod0_count)s, %(front_mod1_count)s, %(front_mod2_count)s, \
                  %(front_zone1_count)s, %(front_zone2_count)s, %(front_zone3_count)s, \
                  %(front_consecutive_groups)s, %(front_consecutive_max_len)s, %(front_repeat_count)s, \
                  %(front_ac_value)s, %(front_first_last_sum)s, %(front_middle_avg)s, %(front_std_dev)s, \
                  %(back_odd_count)s, %(back_even_count)s, %(back_span)s, %(back_summation)s, %(back_summation_tail)s, \
                  %(back_small_count)s, %(back_big_count)s, %(back_repeat_count)s, %(back_repeat_flag_front)s, \
                  %(total_summation)s, %(total_odd_count)s, %(total_even_count)s, %(special_pattern)s) \
          """
    for rec in records:
        cursor.execute(sql, rec)
    conn.commit()
    cursor.close()
    conn.close()
    print(f"成功插入 {len(records)} 条记录")


# ==================== 主程序 ====================
def main():
    max_issue = get_max_issue()
    print(f"当前数据库最大期号: {max_issue if max_issue else '空'}")

    page = 1
    page_size = 30
    total_pages = None  # 将从第一次请求获取
    all_new_records = []
    prev_front = None
    prev_back = None
    stop_flag = False

    while True:
        params = PARAMS_TEMPLATE.copy()
        params['pageNo'] = page
        print(f"正在获取第 {page} 页...")
        try:
            resp = requests.get(API_URL, params=params, headers=HEADERS, timeout=10)
            if resp.status_code != 200:
                print(f"请求失败，状态码 {resp.status_code}，退出")
                break
            data = resp.json()
            if not data.get('success') or 'value' not in data:
                print("返回数据格式异常，退出")
                break

            value = data['value']
            if total_pages is None:
                total_pages = value.get('pages', 0)
                print(f"总页数: {total_pages}")

            items = value.get('list', [])
            if not items:
                print("本页无数据，结束")
                break

            for item in items:
                issue = item['lotteryDrawNum']
                # 增量更新：如果已存在该期号，则停止后续所有页
                if max_issue and issue <= max_issue:
                    print(f"遇到已存在期号 {issue}，停止获取")
                    stop_flag = True
                    break

                draw_date_str = item['lotteryDrawTime']
                draw_date = datetime.strptime(draw_date_str, '%Y-%m-%d').date()
                weekday = str(draw_date.weekday() + 1)
                year = draw_date.year
                month = draw_date.month
                quarter = (month - 1) // 3 + 1

                # 解析号码
                result_str = item['lotteryDrawResult']
                parts = result_str.split()
                if len(parts) != 7:
                    print(f"期号 {issue} 号码格式错误: {result_str}，跳过")
                    continue
                front = sorted([int(p) for p in parts[:5]])
                back = sorted([int(p) for p in parts[5:7]])

                # 计算分析字段
                analysis = calculate_all_fields(front, back, prev_front, prev_back)

                record = {
                    'issue_num': issue,
                    'draw_date': draw_date,
                    'weekday': weekday,
                    'year': year,
                    'month': month,
                    'quarter': quarter,
                    'front_one': front[0], 'front_two': front[1], 'front_three': front[2],
                    'front_four': front[3], 'front_five': front[4],
                    'back_one': back[0], 'back_two': back[1],
                    **analysis
                }
                all_new_records.append(record)
                prev_front = front
                prev_back = back

            if stop_flag:
                break

            page += 1
            if page > total_pages:
                break
            time.sleep(random.uniform(0.3, 0.8))  # 礼貌延时

        except Exception as e:
            print(f"请求异常: {e}")
            break

    if all_new_records:
        # 按期号升序排序（从旧到新），保持与数据库中顺序一致
        all_new_records.sort(key=lambda x: x['issue_num'])
        insert_batch(all_new_records)
    else:
        print("没有新数据需要插入")


if __name__ == "__main__":
    main()