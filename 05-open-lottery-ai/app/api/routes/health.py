# -*- coding: utf-8 -*-
"""健康检查接口"""
from fastapi import APIRouter

router = APIRouter(tags=["Health"])

@router.get("/health")
async def health_check():
    """返回服务健康状态"""
    return {"status": "ok", "service": "lottery-backend", "version": "1.0.0"}