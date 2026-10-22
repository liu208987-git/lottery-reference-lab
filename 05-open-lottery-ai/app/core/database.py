# -*- coding: utf-8 -*-
"""
数据库异步引擎与会话管理，同时提供同步引擎用于 Celery Worker 和 Agent。
"""
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from .config import settings

# ---------- 异步引擎（用于 FastAPI） ----------
engine = create_async_engine(
    settings.mysql_url,
    echo=False,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True
)

# 异步会话工厂
AsyncSessionLocal = async_sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False
)

# ---------- 同步引擎（用于 Celery Worker 和 Agent 同步查询） ----------
# 将异步 URL 中的 asyncmy 替换为 pymysql
sync_engine = create_engine(
    settings.mysql_url.replace("asyncmy", "pymysql"),
    pool_pre_ping=True,
)
SyncSessionLocal = sessionmaker(bind=sync_engine)

# ORM 基类（所有模型继承此基类）
Base = declarative_base()

async def get_db() -> AsyncSession:
    """FastAPI 依赖注入：获取数据库会话"""
    async with AsyncSessionLocal() as session:
        yield session