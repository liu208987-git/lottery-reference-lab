"""下载并核验双色球逐期销售额/一等奖注数，解释全国投注规模效应。"""

from __future__ import annotations

import concurrent.futures
import json
import math
import statistics
import urllib.parse
import urllib.request

import ssq_db
from app_paths import DATA_ROOT


COMBINATIONS = math.comb(33, 6) * 16
PRICE_PER_BASIC_BET = 2
API = "https://jc.zhcw.com/port/client_json.php"
SOURCE_PAGE = "https://www.zhcw.com/kjxx/ssq/"


def _fetch_year(year: int) -> list[dict]:
    parameters = {
        "transactionType": "10001001",
        "lotteryId": "1",
        "issueCount": "0",
        "startIssue": f"{year}001",
        "endIssue": f"{year}200",
        "startDate": "",
        "endDate": "",
        "type": "1",
        "pageNum": "1",
        "pageSize": "250",
        "callback": "ssqSales",
    }
    request = urllib.request.Request(
        API + "?" + urllib.parse.urlencode(parameters),
        headers={"Referer": SOURCE_PAGE, "User-Agent": "Mozilla/5.0"},
    )
    payload = urllib.request.urlopen(request, timeout=30).read().decode("utf-8")
    result = json.loads(payload[payload.index("(") + 1:payload.rindex(")")])
    if result.get("resCode") != "000000":
        raise RuntimeError(f"{year}年销售数据接口失败：{result.get('resCode')}")
    return result["data"]


def _jackpot_count(row: dict) -> int:
    details = row.get("winnerDetails") or []
    if not details or not details[0].get("baseBetWinner"):
        return 0
    return int(details[0]["baseBetWinner"]["awardNum"])


def _correlation(left, right):
    left_mean, right_mean = statistics.mean(left), statistics.mean(right)
    numerator = sum((a - left_mean) * (b - right_mean) for a, b in zip(left, right))
    denominator = math.sqrt(
        sum((a - left_mean) ** 2 for a in left)
        * sum((b - right_mean) ** 2 for b in right)
    )
    return numerator / denominator


def run():
    local = ssq_db.get_all_draws("ASC")
    first_year = int(str(local[0]["issue"])[:4])
    last_year = int(str(local[-1]["issue"])[:4])
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        downloaded = sum(executor.map(_fetch_year, range(first_year, last_year + 1)), [])
    by_issue = {str(row["issue"]): row for row in downloaded}
    rows = []
    mismatches = []
    for draw in local:
        issue = str(draw["issue"])
        source = by_issue.get(issue)
        if source is None:
            mismatches.append({"issue": issue, "reason": "missing"})
            continue
        source_reds = [int(value) for value in source["frontWinningNum"].split()]
        source_blue = int(source["backWinningNum"])
        local_reds = [int(draw[f"r{index}"]) for index in range(1, 7)]
        if sorted(source_reds) != sorted(local_reds) or source_blue != int(draw["b1"]):
            mismatches.append({"issue": issue, "reason": "number_mismatch"})
            continue
        sale = int(source["saleMoney"])
        jackpot = _jackpot_count(source)
        basic_bets = sale / PRICE_PER_BASIC_BET
        expected_jackpots = basic_bets / COMBINATIONS
        independent_p_any = -math.expm1(
            basic_bets * math.log1p(-1.0 / COMBINATIONS)
        )
        rows.append({
            "issue": issue,
            "sale_money": sale,
            "equivalent_basic_bets": basic_bets,
            "jackpot_tickets": jackpot,
            "expected_jackpot_tickets": expected_jackpots,
            "independent_ticket_probability_any_jackpot": independent_p_any,
        })
    if mismatches:
        raise RuntimeError(f"销售数据与本地开奖未完全对齐：{mismatches[:5]}")

    sales = [row["sale_money"] for row in rows]
    bets = [row["equivalent_basic_bets"] for row in rows]
    jackpots = [row["jackpot_tickets"] for row in rows]
    expected = [row["expected_jackpot_tickets"] for row in rows]
    p_any = [row["independent_ticket_probability_any_jackpot"] for row in rows]
    eras = []
    for beginning, ending in ((2003, 2009), (2010, 2015), (2016, 2020), (2021, last_year)):
        selected = [row for row in rows if beginning <= int(row["issue"][:4]) <= ending]
        eras.append({
            "from": beginning,
            "to": ending,
            "periods": len(selected),
            "mean_sale_money": statistics.mean(row["sale_money"] for row in selected),
            "observed_nonzero_jackpot_periods": sum(row["jackpot_tickets"] > 0 for row in selected),
            "observed_nonzero_rate": statistics.mean(row["jackpot_tickets"] > 0 for row in selected),
            "actual_jackpot_tickets": sum(row["jackpot_tickets"] for row in selected),
            "expected_jackpot_tickets": sum(row["expected_jackpot_tickets"] for row in selected),
            "expected_zero_periods_independent_model": sum(
                1 - row["independent_ticket_probability_any_jackpot"] for row in selected
            ),
        })
    maximum = max(rows, key=lambda row: row["jackpot_tickets"])
    return {
        "source": {
            "history_page": SOURCE_PAGE,
            "api": API,
            "local_number_database": str(DATA_ROOT / "ssq.db"),
            "matched_draws": len(rows),
            "number_mismatches": 0,
        },
        "assumptions": {
            "basic_bet_price": PRICE_PER_BASIC_BET,
            "jackpot_combination_space": COMBINATIONS,
            "sales_divided_by_two_is_equivalent_basic_bets_not_distinct_people": True,
            "independent_ticket_probability_is_a_reference_model_not_an_observed_unique_coverage": True,
        },
        "summary": {
            "first_issue": rows[0]["issue"],
            "last_issue": rows[-1]["issue"],
            "periods": len(rows),
            "total_sales": sum(sales),
            "mean_sales": statistics.mean(sales),
            "median_sales": statistics.median(sales),
            "minimum_sales": min(sales),
            "maximum_sales": max(sales),
            "mean_equivalent_basic_bets": statistics.mean(bets),
            "median_equivalent_basic_bets": statistics.median(bets),
            "actual_jackpot_tickets": sum(jackpots),
            "expected_jackpot_tickets": sum(expected),
            "actual_to_expected_jackpot_ratio": sum(jackpots) / sum(expected),
            "actual_zero_jackpot_periods": sum(value == 0 for value in jackpots),
            "actual_nonzero_jackpot_periods": sum(value > 0 for value in jackpots),
            "actual_nonzero_jackpot_rate": statistics.mean(value > 0 for value in jackpots),
            "mean_independent_model_probability_any_jackpot": statistics.mean(p_any),
            "expected_zero_periods_independent_model": sum(1 - value for value in p_any),
            "jackpot_count_mean": statistics.mean(jackpots),
            "jackpot_count_variance": statistics.pvariance(jackpots),
            "sales_jackpot_count_correlation": _correlation(sales, jackpots),
            "maximum_jackpot_issue": maximum,
        },
        "eras": eras,
        "latest_10": rows[-10:],
    }


def render(result):
    summary = result["summary"]
    lines = [
        "# 双色球销售规模与一等奖注数实证分析",
        "",
        f"数据范围：{summary['first_issue']}～{summary['last_issue']}，共{summary['periods']}期。中彩网销售/奖级记录与本地开奖号码逐期匹配，号码不一致0期。",
        "",
        "## 全历史统计",
        "",
        f"- 双色球一等奖号码空间：{result['assumptions']['jackpot_combination_space']:,}种。",
        f"- 平均销售额：{summary['mean_sales']:,.0f}元，相当于{summary['mean_equivalent_basic_bets']:,.0f}个2元基本投注。",
        f"- 实际一等奖共{summary['actual_jackpot_tickets']:,}注；按销售量和均匀开奖计算的期望为{summary['expected_jackpot_tickets']:,.1f}注，实际/期望={summary['actual_to_expected_jackpot_ratio']:.3f}。",
        f"- 实际0注一等奖{summary['actual_zero_jackpot_periods']}期，非0注{summary['actual_nonzero_jackpot_periods']}期，非0比例{summary['actual_nonzero_jackpot_rate']:.3%}。",
        f"- 若把每个等效投注近似为独立随机选号，模型期望0注期数仅{summary['expected_zero_periods_independent_model']:.1f}期；实际更多，说明重复号码、多倍投注和选号集中使独立假设偏乐观。",
        f"- 一等奖注数均值{summary['jackpot_count_mean']:.3f}、方差{summary['jackpot_count_variance']:.3f}，明显过度离散；中奖彩票注数不能直接当作独立中奖人数。",
        "",
        "## 分阶段",
        "",
        "| 年份 | 期数 | 平均销售额 | 有一等奖期数 | 有一等奖比例 | 实际一等奖注数 | 理论期望注数 | 独立模型期望0注期数 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for era in result["eras"]:
        lines.append(
            f"| {era['from']}～{era['to']} | {era['periods']} | "
            f"{era['mean_sale_money']:,.0f}元 | {era['observed_nonzero_jackpot_periods']} | "
            f"{era['observed_nonzero_rate']:.3%} | {era['actual_jackpot_tickets']} | "
            f"{era['expected_jackpot_tickets']:.1f} | {era['expected_zero_periods_independent_model']:.2f} |"
        )
    lines.extend([
        "",
        "## 最近10期",
        "",
        "| 期号 | 销售额 | 等效2元投注 | 实际一等奖 | 理论期望注数 | 独立模型至少1注概率 |",
        "|---|---:|---:|---:|---:|---:|",
    ])
    for row in result["latest_10"]:
        lines.append(
            f"| {row['issue']} | {row['sale_money']:,}元 | "
            f"{row['equivalent_basic_bets']:,.0f} | {row['jackpot_tickets']} | "
            f"{row['expected_jackpot_tickets']:.3f} | "
            f"{row['independent_ticket_probability_any_jackpot']:.5%} |"
        )
    lines.extend([
        "",
        "注意：销售额只能换算成等效基本投注次数，不能得到去重后的号码组合数或独立购彩人数；复式、胆拖和多倍投注按其包含的基本注计入。",
        "",
    ])
    return "\n".join(lines)


if __name__ == "__main__":
    result = run()
    (DATA_ROOT / "ssq_sales_analysis.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (DATA_ROOT / "ssq_sales_analysis.md").write_text(
        render(result), encoding="utf-8"
    )
    print("双色球销售规模分析完成")
