# -*- coding: utf-8 -*-
"""
API 请求与响应的 Pydantic 模型定义。
"""
from pydantic import BaseModel
from datetime import date
from typing import Optional, List

# ---------- 基础响应 ----------
class SSQHistoryResponse(BaseModel):
    """双色球历史数据响应"""
    id: int
    issue_num: str
    draw_date: date
    red_one: int
    red_two: int
    red_three: int
    red_four: int
    red_five: int
    red_six: int
    blue_one: int
    red_summation: Optional[int] = None
    red_span: Optional[int] = None

    class Config:
        from_attributes = True

class DLTHistoryResponse(BaseModel):
    """大乐透历史数据响应"""
    id: int
    issue_num: str
    draw_date: date
    front_one: int
    front_two: int
    front_three: int
    front_four: int
    front_five: int
    back_one: int
    back_two: int
    front_summation: Optional[int] = None
    front_span: Optional[int] = None

    class Config:
        from_attributes = True

# ---------- 训练请求 ----------
class TrainRequest(BaseModel):
    """训练任务请求"""
    lottery_type: str = "ssq"          # 'ssq' 或 'dlt'
    epochs: int = 50
    batch_size: int = 32
    seq_len: int = 30
    learning_rate: float = 1e-4
    with_fetch: bool = True

class TrainResponse(BaseModel):
    """训练任务响应"""
    task_id: str
    status: str
    message: str

# ---------- 预测请求/响应 ----------
class PredictRequest(BaseModel):
    """预测请求"""
    lottery_type: str = "ssq"
    model_version: Optional[str] = "latest"
    model_name: Optional[str] = None   # 新增：指定具体模型文件名（如 ssq_epochs50_bs32_seq30_lr0_0001_1234567890.pt）

class PredictResponse(BaseModel):
    """预测响应"""
    lottery_type: str
    forecast_date: date
    red: List[int]
    blue: List[int]
    quality_score: Optional[float] = None
    model_version: str = "Transformer"