from sqlalchemy import select, func
from app.models.ssq_history import SSQHistory
from app.models.dlt_history import DLTHistory
import pandas as pd
import torch
from torch.utils.data import Dataset


class LotteryDataset(Dataset):
    """彩票数据集"""

    def __init__(self, data, seq_len=30):
        self.data = data
        self.seq_len = seq_len

    def __len__(self):
        return len(self.data) - self.seq_len

    def __getitem__(self, idx):
        x = self.data[idx:idx + self.seq_len]
        y = self.data[idx + self.seq_len]
        return torch.tensor(x, dtype=torch.float32), torch.tensor(y, dtype=torch.float32)


async def load_lottery_data(lottery_type: str, db):
    """从数据库加载彩票数据"""
    if lottery_type == "ssq":
        result = await db.execute(
            select(SSQHistory).order_by(SSQHistory.issue_num)
        )
        records = result.scalars().all()
        # 提取特征
        data = []
        for r in records:
            features = [
                r.year, r.month, r.quarter,
                r.red_summation, r.red_span,
                r.red_odd_count, r.red_even_count,
                r.red_small_count, r.red_big_count,
                r.red_prime_count, r.red_composite_count,
                r.red_zone1_count, r.red_zone2_count, r.red_zone3_count,
                r.red_ac_value,
                r.total_odd_count, r.total_even_count,
                r.red_one, r.red_two, r.red_three, r.red_four, r.red_five, r.red_six,
                r.blue_one
            ]
            data.append(features)
        return pd.DataFrame(data)
    # 类似实现 DLT