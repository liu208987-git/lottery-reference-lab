# -*- coding: utf-8 -*-
"""体彩大乐透 历史数据爬虫（新浪走势图）

数据源：https://lotto.sina.cn/trend/qxc_qlc_proxy.d.html
    lottoType=dlt & actionType=chzs & type=500

走势图 HTML 结构（已验证）：
    <tbody id="cpdata">
      <tr>
        <td>2026076</td>              <- 期号
        <td class="br01"></td>        <- 区间边框分隔(忽略)
        <td class="yl02">7</td>       <- 遗漏期数(忽略)
        <td class="chartball20">09</td> <- 中奖号码单元格(class 含 chartball)
        ...
      </tr>
每行恰好 7 个 chartball 单元格：前 5 个为前区(红球)，后 2 个为后区(蓝球)。
"""
import requests
from bs4 import BeautifulSoup

URL = "https://lotto.sina.cn/trend/qxc_qlc_proxy.d.html"
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/120.0 Safari/537.36"),
    "Referer": "https://lotto.sina.cn/",
}


def fetch_html(count=500, timeout=30):
    params = {"lottoType": "dlt", "actionType": "chzs", "type": str(count)}
    r = requests.get(URL, params=params, headers=HEADERS, timeout=timeout)
    r.encoding = r.apparent_encoding or "utf-8"
    r.raise_for_status()
    return r.text


def parse(html):
    """解析走势图 HTML，返回 [(issue, [r1..r5], [b1,b2]), ...]，按期号升序。"""
    soup = BeautifulSoup(html, "html.parser")
    tbody = soup.find("tbody", id="cpdata") or soup.find("tbody")
    if tbody is None:
        raise RuntimeError("未找到数据表格 tbody#cpdata")

    results = []
    for tr in tbody.find_all("tr"):
        tds = tr.find_all("td")
        if not tds:
            continue
        issue = tds[0].get_text(strip=True)
        if not (issue.isdigit() and len(issue) == 7):
            continue

        balls = []
        for td in tds[1:]:
            classes = td.get("class") or []
            if any(str(c).startswith("chartball") for c in classes):
                txt = td.get_text(strip=True)
                if txt.isdigit():
                    balls.append(int(txt))
        if len(balls) < 7:
            continue

        reds = sorted(balls[:5])
        blues = sorted(balls[5:7])
        # 合法性校验
        if not (1 <= reds[0] and reds[-1] <= 35 and len(set(reds)) == 5):
            continue
        if not (1 <= blues[0] and blues[-1] <= 12 and len(set(blues)) == 2):
            continue
        results.append((issue, reds, blues))

    results.sort(key=lambda x: x[0])
    return results


def scrape(count=500):
    """抓取并解析，返回 [(issue, reds, blues), ...]。"""
    return parse(fetch_html(count))


if __name__ == "__main__":
    data = scrape(50)
    print(f"抓取 {len(data)} 期")
    for issue, reds, blues in data[-3:]:
        print(issue, reds, blues)
