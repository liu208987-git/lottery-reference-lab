# -*- coding: utf-8 -*-
"""
模型管理接口：列出已训练模型、下载模型文件。
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
import os
import glob
from app.core.config import settings

router = APIRouter(prefix="/models", tags=["Models"])


@router.get("/list")
async def list_models():
    """列出所有已保存的模型文件（.pt），从 ssq 和 dlt 子目录中收集"""
    base_dir = settings.MODEL_SAVE_DIR
    if not os.path.exists(base_dir):
        return {"models": []}

    all_models = []
    # 遍历 ssq 和 dlt 子目录
    for lottery_type in ['ssq', 'dlt']:
        sub_dir = os.path.join(base_dir, lottery_type)
        if os.path.exists(sub_dir):
            # 查找所有 .pt 文件
            pt_files = glob.glob(os.path.join(sub_dir, "*.pt"))
            scaler_files = glob.glob(os.path.join(sub_dir, "*_scaler.joblib"))
            # 只返回文件名（不包含路径）
            for f in pt_files + scaler_files:
                all_models.append(os.path.basename(f))

    return {"models": sorted(all_models)}


@router.get("/download/{model_name}")
async def download_model(model_name: str):
    """下载指定的模型文件，自动搜索 ssq 和 dlt 子目录"""
    # 防止路径遍历攻击
    if ".." in model_name or "/" in model_name or "\\" in model_name:
        raise HTTPException(400, "Invalid file name")

    base_dir = settings.MODEL_SAVE_DIR
    # 尝试在 ssq 和 dlt 子目录中查找
    for lottery_type in ['ssq', 'dlt']:
        sub_dir = os.path.join(base_dir, lottery_type)
        model_path = os.path.join(sub_dir, model_name)
        if os.path.exists(model_path):
            return FileResponse(model_path, filename=model_name)

    raise HTTPException(404, "Model not found")