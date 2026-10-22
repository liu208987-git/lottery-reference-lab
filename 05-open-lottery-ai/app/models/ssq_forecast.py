# -*- coding: utf-8 -*-
"""
双色球预测结果表 (ssq_forecast) 的 ORM 模型。
"""
from sqlalchemy import Column, Integer, String, Date, Float, DateTime, func
from app.core.database import Base

class SSQForecast(Base):
    __tablename__ = "ssq_forecast"

    id = Column(Integer, primary_key=True, autoincrement=True)
    forecast_date = Column(Date, nullable=False, comment="预测日期")
    group_id = Column(Integer, default=1, comment="分组ID")
    red_one = Column(Integer, nullable=False, comment="红球1")
    red_two = Column(Integer, nullable=False, comment="红球2")
    red_three = Column(Integer, nullable=False, comment="红球3")
    red_four = Column(Integer, nullable=False, comment="红球4")
    red_five = Column(Integer, nullable=False, comment="红球5")
    red_six = Column(Integer, nullable=False, comment="红球6")
    blue_one = Column(Integer, nullable=False, comment="蓝球")
    model_version = Column(String(50), default="Transformer", comment="模型版本")
    quality_score = Column(Float, nullable=True, comment="质量评分")
    create_time = Column(DateTime, server_default=func.now(), comment="创建时间")