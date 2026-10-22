# -*- coding: utf-8 -*-
"""
Redis 异步客户端，用于缓存和状态管理。
"""
import redis.asyncio as redis
from .config import settings

redis_client = redis.from_url(
    settings.redis_url,
    decode_responses=True,
    max_connections=20
)

async def get_redis():
    """依赖注入：返回 Redis 客户端"""
    return redis_client