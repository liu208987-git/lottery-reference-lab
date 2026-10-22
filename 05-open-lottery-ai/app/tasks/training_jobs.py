# -*- coding: utf-8 -*-
"""
Celery 异步训练任务定义。
"""
from app.core.celery_app import celery_app
from app.services.trainer import train_lottery_model
from app.services.fetch_service import run_fetch_script   # 新增

@celery_app.task(bind=True)
def start_training(self, lottery_type, epochs, batch_size, seq_len, learning_rate):
    """
    异步训练任务，更新任务状态并返回训练结果。
    """
    self.update_state(
        state="RUNNING",
        meta={"lottery_type": lottery_type, "epochs": epochs, "progress": "0%"}
    )
    try:
        result = train_lottery_model(
            lottery_type=lottery_type,
            epochs=epochs,
            batch_size=batch_size,
            seq_len=seq_len,
            lr=learning_rate
        )
        self.update_state(
            state="SUCCESS",
            meta={"result": result, "progress": "100%"}
        )
        return result
    except Exception as e:
        self.update_state(
            state="FAILURE",
            meta={"error": str(e)}
        )
        raise e


@celery_app.task(bind=True)
def run_full_pipeline(self, lottery_type, epochs, batch_size, seq_len, learning_rate):
    """
    完整流水线任务：先执行数据抓取，再执行训练。
    状态阶段：fetch → train → done
    """
    # 1. 抓取阶段
    self.update_state(
        state="FETCHING",
        meta={"stage": "fetch", "progress": "0%", "message": "正在更新数据..."}
    )

    fetch_result = run_fetch_script(lottery_type)
    if not fetch_result['success']:
        self.update_state(
            state="FAILURE",
            meta={"stage": "fetch", "error": fetch_result['message']}
        )
        raise Exception(f"数据抓取失败: {fetch_result['message']}")

    # 2. 训练阶段
    self.update_state(
        state="RUNNING",
        meta={"stage": "train", "progress": "0%", "message": "数据已更新，开始训练..."}
    )

    try:
        result = train_lottery_model(
            lottery_type=lottery_type,
            epochs=epochs,
            batch_size=batch_size,
            seq_len=seq_len,
            lr=learning_rate
        )
        self.update_state(
            state="SUCCESS",
            meta={"stage": "done", "result": result, "progress": "100%"}
        )
        return result
    except Exception as e:
        self.update_state(
            state="FAILURE",
            meta={"stage": "train", "error": str(e)}
        )
        raise e