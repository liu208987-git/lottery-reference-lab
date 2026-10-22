import pymysql
from itertools import combinations

# 数据库连接
conn = pymysql.connect(
    host='192.168.2.10',
    user='root',
    password='123456',
    database='open-lottery',
    charset='utf8mb4'
)
cursor = conn.cursor()

# 清空表
cursor.execute("TRUNCATE TABLE ssq_all")

# 生成所有组合
red_balls = list(range(1, 34))
blue_balls = list(range(1, 17))

batch = []
batch_size = 10000
total = 0

# 遍历所有红球组合
for red_combo in combinations(red_balls, 6):
    red1, red2, red3, red4, red5, red6 = red_combo
    # 为每个红球组合生成16个蓝球
    for blue in blue_balls:
        batch.append((red1, red2, red3, red4, red5, red6, blue))
        total += 1

        # 批量插入
        if len(batch) >= batch_size:
            cursor.executemany(
                "INSERT INTO ssq (red_one, red_two, red_three, red_four, red_five, red_six, blue_one) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                batch
            )
            conn.commit()
            print(f"已插入 {total} 条记录")
            batch = []

# 插入剩余数据
if batch:
    cursor.executemany(
        "INSERT INTO ssq (red_one, red_two, red_three, red_four, red_five, red_six, blue_one) VALUES (%s, %s, %s, %s, %s, %s, %s)",
        batch
    )
    conn.commit()

print(f"完成！共插入 {total} 条记录")
cursor.close()
conn.close()