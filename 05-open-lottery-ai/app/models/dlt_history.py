# -*- coding: utf-8 -*-
"""
大乐透历史开奖结果表 (dlt_history) 的 ORM 模型。
"""
from sqlalchemy import Column, BigInteger, String, Date, Integer, DECIMAL, DateTime, func
from app.core.database import Base

class DLTHistory(Base):
    __tablename__ = "dlt_history"

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment="主键ID")
    issue_num = Column(String(20), nullable=False, unique=True, index=True, comment="期号")
    draw_date = Column(Date, nullable=False, index=True, comment="开奖日期")
    weekday = Column(String(10), comment="星期几")
    year = Column(Integer, comment="年份")
    month = Column(Integer, comment="月份")
    quarter = Column(Integer, comment="季度")

    front_one = Column(Integer, nullable=False, comment="前区1")
    front_two = Column(Integer, nullable=False, comment="前区2")
    front_three = Column(Integer, nullable=False, comment="前区3")
    front_four = Column(Integer, nullable=False, comment="前区4")
    front_five = Column(Integer, nullable=False, comment="前区5")
    back_one = Column(Integer, nullable=False, comment="后区1")
    back_two = Column(Integer, nullable=False, comment="后区2")

    front_max = Column(Integer, comment="前区最大值")
    front_min = Column(Integer, comment="前区最小值")
    front_span = Column(Integer, comment="前区跨度")
    front_summation = Column(Integer, comment="前区和值")
    front_summation_tail = Column(Integer, comment="和值尾数")
    front_odd_count = Column(Integer, comment="前区奇数个数")
    front_even_count = Column(Integer, comment="前区偶数个数")
    front_small_count = Column(Integer, comment="前区小数个数(1-17为小)")
    front_big_count = Column(Integer, comment="前区大数个数(18-35为大)")
    front_prime_count = Column(Integer, comment="前区质数个数")
    front_composite_count = Column(Integer, comment="前区合数个数")
    front_mod0_count = Column(Integer, comment="除3余0个数")
    front_mod1_count = Column(Integer, comment="除3余1个数")
    front_mod2_count = Column(Integer, comment="除3余2个数")
    front_zone1_count = Column(Integer, comment="一区个数(1-12)")
    front_zone2_count = Column(Integer, comment="二区个数(13-24)")
    front_zone3_count = Column(Integer, comment="三区个数(25-35)")
    front_consecutive_groups = Column(Integer, comment="连号组数")
    front_consecutive_max_len = Column(Integer, comment="最大连号长度")
    front_repeat_count = Column(Integer, comment="与上期前区重复个数")
    front_ac_value = Column(Integer, comment="AC值")
    front_first_last_sum = Column(Integer, comment="首尾和")
    front_middle_avg = Column(DECIMAL(5, 2), comment="前区均值")
    front_std_dev = Column(DECIMAL(8, 4), comment="前区标准差")

    back_odd_count = Column(Integer, comment="后区奇数个数")
    back_even_count = Column(Integer, comment="后区偶数个数")
    back_span = Column(Integer, comment="后区跨度")
    back_summation = Column(Integer, comment="后区和值")
    back_summation_tail = Column(Integer, comment="后区和值尾数")
    back_small_count = Column(Integer, comment="后区小数个数(1-6为小)")
    back_big_count = Column(Integer, comment="后区大数个数(7-12为大)")
    back_repeat_count = Column(Integer, comment="与上期后区重复个数")
    back_repeat_flag_front = Column(Integer, comment="后区号码是否与前区重复")

    total_summation = Column(Integer, comment="总合值")
    total_odd_count = Column(Integer, comment="整体奇数个数")
    total_even_count = Column(Integer, comment="整体偶数个数")
    special_pattern = Column(String(50), comment="特殊形态")

    created_at = Column(DateTime, server_default=func.now(), comment="创建时间")
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), comment="更新时间")