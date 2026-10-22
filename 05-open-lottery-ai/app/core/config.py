# -*- coding: utf-8 -*-
"""
配置管理模块：从环境变量加载配置信息。
所有配置统一从 .env.development 读取，无硬编码。
"""
from pydantic_settings import BaseSettings
from pydantic import ConfigDict
from pathlib import Path

# 项目根目录
BASE_DIR = Path(__file__).resolve().parent.parent.parent


class Settings(BaseSettings):
    """
    应用配置类，自动读取 .env.development 或 .env.production。
    所有字段均从环境变量读取，无硬编码值。
    """
    model_config = ConfigDict(
        env_file=BASE_DIR / ".env.development",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore"
    )

    # ---------- MySQL 配置 ----------
    MYSQL_HOST: str
    MYSQL_PORT: int
    MYSQL_USER: str
    MYSQL_PASSWORD: str
    MYSQL_DATABASE: str

    @property
    def mysql_url(self) -> str:
        """生成异步 MySQL 连接 URL"""
        return f"mysql+asyncmy://{self.MYSQL_USER}:{self.MYSQL_PASSWORD}@{self.MYSQL_HOST}:{self.MYSQL_PORT}/{self.MYSQL_DATABASE}"

    # ---------- Redis 配置 ----------
    REDIS_HOST: str
    REDIS_PORT: int
    REDIS_PASSWORD: str
    REDIS_DB: int

    @property
    def redis_url(self) -> str:
        """生成 Redis 连接 URL"""
        if self.REDIS_PASSWORD:
            return f"redis://:{self.REDIS_PASSWORD}@{self.REDIS_HOST}:{self.REDIS_PORT}/{self.REDIS_DB}"
        return f"redis://{self.REDIS_HOST}:{self.REDIS_PORT}/{self.REDIS_DB}"

    # ---------- Celery 配置 ----------
    CELERY_BROKER_URL: str
    CELERY_RESULT_BACKEND: str

    # ---------- 训练配置 ----------
    MODEL_SAVE_DIR: str
    DEVICE: str

    # ---------- API 配置 ----------
    API_HOST: str
    API_PORT: int

    # Agent 相关配置
    DEEPSEEK_API_KEY: str = "your-deepseek-api-key-here"
    DEEPSEEK_BASE_URL: str = "https://api.deepseek.com/v1"
    AGENT_ENABLED: bool = True
    EMBEDDING_MODEL_NAME: str = "all-MiniLM-L6-v2"
    RAG_TOP_K: int = 3


# 创建全局配置实例
settings = Settings()