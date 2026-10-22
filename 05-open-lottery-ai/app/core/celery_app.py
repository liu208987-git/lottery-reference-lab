# -*- coding: utf-8 -*-
"""
Celery 应用配置，使用 RabbitMQ 作为消息代理。
"""
from celery import Celery
from .config import settings

celery_app = Celery(
    "lottery_worker",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
    include=["app.tasks.training_jobs"]
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    task_track_started=True,
    task_time_limit=7200,          # 2 小时硬超时
    task_soft_time_limit=6900,     # 软超时（提前 5 分钟）
)