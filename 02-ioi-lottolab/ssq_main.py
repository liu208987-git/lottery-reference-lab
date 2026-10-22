# -*- coding: utf-8 -*-
"""福彩双色球 历史分析与预测 - 启动入口

运行：python ssq_main.py
功能：
  1. 初始化本地 SQLite 数据库（ssq.db）
  2. 启动 GUI（窗口启动后自动从新浪爬取并补全遗漏期数）
  3. 基于历史和值/跨度/区间比/奇偶比等走势给出本期号码预测与推理
"""
import ssq_db as db
from ssq_gui import launch


def main():
    db.init_db()
    launch()


if __name__ == "__main__":
    main()
