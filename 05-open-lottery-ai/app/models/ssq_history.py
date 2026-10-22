# -*- coding: utf-8 -*-
"""
双色球历史开奖结果表 (ssq_history) 的 ORM 模型。
"""
from sqlalchemy import Column, BigInteger, String, Date, Integer, DECIMAL, DateTime, func
from app.core.database import Base

class SSQHistory(Base):
    __tablename__ = "ssq_history"

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment="主键ID")
    issue_num = Column(String(20), nullable=False, unique=True, index=True, comment="期号")
    draw_date = Column(Date, nullable=False, index=True, comment="开奖日期")
    weekday = Column(String(10), comment="星期几")
    year = Column(Integer, comment="年份")
    month = Column(Integer, comment="月份")
    quarter = Column(Integer, comment="季度")

    red_one = Column(Integer, nullable=False, comment="红球1")
    red_two = Column(Integer, nullable=False, comment="红球2")
    red_three = Column(Integer, nullable=False, comment="红球3")
    red_four = Column(Integer, nullable=False, comment="红球4")
    red_five = Column(Integer, nullable=False, comment="红球5")
    red_six = Column(Integer, nullable=False, comment="红球6")
    blue_one = Column(Integer, nullable=False, comment="蓝球")

    red_max = Column(Integer, comment="红球最大值")
    red_min = Column(Integer, comment="红球最小值")
    red_span = Column(Integer, comment="红球跨度")
    red_summation = Column(Integer, comment="红球和值")
    red_summation_tail = Column(Integer, comment="和值尾数")
    red_odd_count = Column(Integer, comment="红球奇数个数")
    red_even_count = Column(Integer, comment="红球偶数个数")
    red_small_count = Column(Integer, comment="红球小数个数(1-16为小)")
    red_big_count = Column(Integer, comment="红球大数个数(17-33为大)")
    red_prime_count = Column(Integer, comment="红球质数个数")
    red_composite_count = Column(Integer, comment="红球合数个数")
    red_mod0_count = Column(Integer, comment="除3余0个数")
    red_mod1_count = Column(Integer, comment="除3余1个数")
    red_mod2_count = Column(Integer, comment="除3余2个数")
    red_zone1_count = Column(Integer, comment="一区个数(1-11)")
    red_zone2_count = Column(Integer, comment="二区个数(12-22)")
    red_zone3_count = Column(Integer, comment="三区个数(23-33)")
    red_consecutive_groups = Column(Integer, comment="连号组数")
    red_consecutive_max_len = Column(Integer, comment="最大连号长度")
    red_repeat_count = Column(Integer, comment="与上期红球重复个数")
    red_ac_value = Column(Integer, comment="AC值")
    red_first_last_sum = Column(Integer, comment="首尾和")
    red_middle_avg = Column(DECIMAL(5, 2), comment="红球均值")
    red_std_dev = Column(DECIMAL(8, 4), comment="红球标准差")

    blue_odd_even = Column(String(4), comment="蓝球奇偶(odd/even)")
    blue_size = Column(String(4), comment="蓝球大小(1-8小, 9-16大)")
    blue_mod3 = Column(Integer, comment="蓝球除3余数")
    blue_mod4 = Column(Integer, comment="蓝球除4余数")
    blue_repeat_flag = Column(Integer, comment="是否与上期蓝球重复")

    total_sum = Column(Integer, comment="整体和值")
    total_odd_count = Column(Integer, comment="整体奇数个数")
    total_even_count = Column(Integer, comment="整体偶数个数")
    total_small_count = Column(Integer, comment="整体小数个数")
    total_big_count = Column(Integer, comment="整体大数个数")
    special_pattern = Column(String(50), comment="特殊形态")

    created_at = Column(DateTime, server_default=func.now(), comment="创建时间")
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), comment="更新时间")