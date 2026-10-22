import requests, re
from bs4 import BeautifulSoup

# 测试不同年份的数据可用性
test_months = [
    (2007, 1), (2008, 1), (2010, 1), (2012, 1), (2015, 1), (2018, 1), (2020, 1), (2023, 1), (2024, 1), (2025, 1)
]
for year, month in test_months:
    url = f'https://www.tianqihoubao.com/lishi/beijing/month/{year}{month:02d}.html'
    try:
        r = requests.get(url, headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}, timeout=20)
        if r.status_code == 200:
            r.encoding = 'utf-8'
            soup = BeautifulSoup(r.text, 'html.parser')
            rows = soup.select('tr')
            # 计算有日期的行数
            date_rows = 0
            for row in rows:
                text = row.get_text()
                if re.search(r'\d{4}年\d{2}月\d{2}日', text):
                    date_rows += 1
            print(f'{year}-{month:02d}: {date_rows} 天数据')
        else:
            print(f'{year}-{month:02d}: HTTP {r.status_code}')
    except Exception as e:
        print(f'{year}-{month:02d}: {e}')
