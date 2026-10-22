# -*- coding: utf-8 -*-
"""
大乐透预测结果表 (dlt_forecast) 的 ORM 模型。
"""
from sqlalchemy import Column, Integer, String, Date, Float, DateTime, func
from app.core.database import Base

class DLTForecast(Base):
    __tablename__ = "dlt_forecast"

    id = Column(Integer, primary_key=True, autoincrement=True)
    forecast_date = Column(Date, nullable=False, comment="预测日期")
    group_id = Column(Integer, default=1, comment="分组ID")
    red_one = Column(Integer, nullable=False, comment="前区1")
    red_two = Column(Integer, nullable=False, comment="前区2")
    red_three = Column(Integer, nullable=False, comment="前区3")
    red_four = Column(Integer, nullable=False, comment="前区4")
    red_five = Column(Integer, nullable=False, comment="前区5")
    blue_one = Column(Integer, nullable=False, comment="后区1")
    blue_two = Column(Integer, nullable=False, comment="后区2")
    model_version = Column(String(50), default="Transformer", comment="模型版本")
    quality_score = Column(Float, nullable=True, comment="质量评分")
    create_time = Column(DateTime, server_default=func.now(), comment="创建时间")