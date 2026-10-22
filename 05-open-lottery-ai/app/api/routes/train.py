# -*- coding: utf-8 -*-
"""
模型训练接口：提交训练任务、查询训练状态。
"""
from fastapi import APIRouter, Depends, HTTPException
from celery.result import AsyncResult
from app.schemas.lottery import TrainRequest, TrainResponse
from app.tasks.training_jobs import start_training, run_full_pipeline   # 新增导入 run_full_pipeline
from app.core.celery_app import celery_app

router = APIRouter(prefix="/train", tags=["Training"])

@router.post("/start", response_model=TrainResponse)
async def start_train(request: TrainRequest):
    """
    启动异步训练任务。
    提交后立即返回 task_id，用于后续查询进度。
    若 with_fetch=True，则先执行数据抓取再训练。
    """
    if request.with_fetch:
        # 完整流水线：抓取 + 训练
        task = run_full_pipeline.delay(
            lottery_type=request.lottery_type,
            epochs=request.epochs,
            batch_size=request.batch_size,
            seq_len=request.seq_len,
            learning_rate=request.learning_rate
        )
        message = "完整训练任务已提交（先抓取数据再训练）"
    else:
        # 仅训练
        task = start_training.delay(
            lottery_type=request.lottery_type,
            epochs=request.epochs,
            batch_size=request.batch_size,
            seq_len=request.seq_len,
            learning_rate=request.learning_rate
        )
        message = "训练任务已提交"

    return TrainResponse(
        task_id=task.id,
        status="pending",
        message=message
    )

@router.get("/status/{task_id}")
async def get_train_status(task_id: str):
    """
    查询训练任务状态。
    返回状态信息（pending/running/completed/failed）及结果。
    """
    task = AsyncResult(task_id, app=celery_app)
    if task.state == 'PENDING':
        return {"task_id": task_id, "status": "pending", "result": None}
    elif task.state == 'RUNNING':
        return {"task_id": task_id, "status": "running", "result": task.info}
    elif task.state == 'SUCCESS':
        return {"task_id": task_id, "status": "completed", "result": task.result}
    elif task.state == 'FAILURE':
        return {"task_id": task_id, "status": "failed", "result": str(task.info)}
    else:
        return {"task_id": task_id, "status": task.state, "result": None}