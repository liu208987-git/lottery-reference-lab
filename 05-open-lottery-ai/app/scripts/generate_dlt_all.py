import pymysql
from itertools import combinations

DB_CONFIG = {
    'host': '192.168.2.100',
    'user': 'root',
    'password': '123456',
    'database': 'open-lottery',
    'charset': 'utf8mb4'
}


def generate_all_combinations():
    conn = pymysql.connect(**DB_CONFIG)
    cursor = conn.cursor()

    # 创建表
    cursor.execute("""
                   CREATE TABLE IF NOT EXISTS `dlt_all`
                   (
                       `id`
                       bigint
                       NOT
                       NULL
                       AUTO_INCREMENT,
                       `front_one`
                       int
                       NOT
                       NULL,
                       `front_two`
                       int
                       NOT
                       NULL,
                       `front_three`
                       int
                       NOT
                       NULL,
                       `front_four`
                       int
                       NOT
                       NULL,
                       `front_five`
                       int
                       NOT
                       NULL,
                       `back_one`
                       int
                       NOT
                       NULL,
                       `back_two`
                       int
                       NOT
                       NULL,
                       PRIMARY
                       KEY
                   (
                       `id`
                   ),
                       INDEX `idx_front`
                   (
                       `front_one`,
                       `front_two`,
                       `front_three`,
                       `front_four`,
                       `front_five`
                   ),
                       INDEX `idx_back`
                   (
                       `back_one`,
                       `back_two`
                   )
                       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                   """)

    fronts = list(range(1, 36))
    backs = list(range(1, 13))

    batch = []
    batch_size = 10000
    total = 0

    for front_combo in combinations(fronts, 5):
        f1, f2, f3, f4, f5 = sorted(front_combo)
        for back_combo in combinations(backs, 2):
            b1, b2 = sorted(back_combo)
            batch.append((f1, f2, f3, f4, f5, b1, b2))
            total += 1
            if len(batch) >= batch_size:
                cursor.executemany(
                    "INSERT INTO dlt_all (front_one, front_two, front_three, front_four, front_five, back_one, back_two) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    batch
                )
                conn.commit()
                print(f"已插入 {total:,} 条记录")
                batch = []

    if batch:
        cursor.executemany(
            "INSERT INTO dlt_all (front_one, front_two, front_three, front_four, front_five, back_one, back_two) VALUES (%s, %s, %s, %s, %s, %s, %s)",
            batch
        )
        conn.commit()

    print(f"完成！共插入 {total:,} 条记录（C(35,5)×C(12,2) = {total:,}）")
    cursor.close()
    conn.close()


if __name__ == "__main__":
    generate_all_combinations()