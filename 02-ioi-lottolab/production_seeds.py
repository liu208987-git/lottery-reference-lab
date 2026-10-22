"""生产算法共享的确定性随机种子。"""

from __future__ import annotations

import random
from hashlib import sha256


def dlt_v4_seed(trained_through: str, history_count: int) -> int:
    """与大乐透 v4 线上预测一致的稳定种子。"""
    payload = f"dlt-sina-v4|{trained_through}|{history_count}".encode("utf-8")
    return int.from_bytes(sha256(payload).digest()[:8], "big")


def dlt_v4_rng(trained_through: str, history_count: int) -> random.Random:
    return random.Random(dlt_v4_seed(trained_through, history_count))
