# -*- coding: utf-8 -*-
"""福彩双色球 历史数据爬虫（新浪走势图）

数据源：https://lotto.sina.cn/trend/qxc_qlc_proxy.d.html
    lottoType=ssq & actionType=chzs & type=500

走势图 HTML 结构（与大乐透一致，已验证）：
    <tbody id="cpdata">
      <tr>
        <td>2026029</td>                 <- 期号
        <td class="br01"></td>           <- 区间边框分隔(忽略)
        <td class="yl02">5</td>          <- 遗漏期数(忽略)
        <td class="chartball01">06</td>  <- 中奖号码单元格(class 含 chartball)
        ...
        <td class="chartball02">05</td>  <- 后区(蓝球)
每行恰好 7 个 chartball 单元格：前 6 个为前区(红球01-33)，第 7 个为后区(蓝球01-16)。
"""
import time
import requests
from bs4 import BeautifulSoup

URL = "https://lotto.sina.cn/trend/qxc_qlc_proxy.d.html"
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/120.0.0.0 Safari/537.36"),
    "Accept": ("text/html,application/xhtml+xml,application/xml;q=0.9,"
               "image/avif,image/webp,*/*;q=0.8"),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://lotto.sina.cn/",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

_session = requests.Session()
_session.headers.update(HEADERS)


def fetch_html(count=500, timeout=30, retries=3):
    """抓取走势图 HTML。新浪对非浏览器请求会返回精简页，故加完整头与重试。"""
    params = {"lottoType": "ssq", "actionType": "chzs", "type": str(count)}
    last = None
    for i in range(retries):
        try:
            r = _session.get(URL, params=params, timeout=timeout)
            r.raise_for_status()
            r.encoding = r.apparent_encoding or "utf-8"
            if "cpdata" in r.text:
                return r.text
            last = f"第{i+1}次响应未含数据表"
        except Exception as e:
            last = str(e)
        time.sleep(1.0 * (i + 1))
    raise RuntimeError(f"抓取失败：{last}")


def parse(html):
    """解析走势图 HTML，返回 [(issue, [r1..r6], [b1]), ...]，按期号升序。"""
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

        reds = sorted(balls[:6])
        blues = [balls[6]]
        # 合法性校验：红球01-33不重复，蓝球01-16
        if not (1 <= reds[0] and reds[-1] <= 33 and len(set(reds)) == 6):
            continue
        if not (1 <= blues[0] <= 16):
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
