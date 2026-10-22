# -*- coding: utf-8 -*-
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, List
from app.services.agent_service import AgentService
from app.core.config import settings

router = APIRouter(prefix="/agent", tags=["AI Agent"])

class HyperparamsRecommendRequest(BaseModel):
    lottery_type: str = Field(..., description="彩种: ssq 或 dlt")
    description: Optional[str] = Field("", description="需求描述，如'追求高准确率'、'快速训练'")

class HyperparamsRecommendResponse(BaseModel):
    epochs: int
    batch_size: int
    seq_len: int
    learning_rate: float
    reason: Optional[str] = None

class ModelsRecommendResponse(BaseModel):
    models: List[str]

@router.post("/recommend-hyperparams", response_model=HyperparamsRecommendResponse)
async def recommend_hyperparams(req: HyperparamsRecommendRequest):
    if not settings.AGENT_ENABLED:
        raise HTTPException(403, "Agent 功能未启用")
    try:
        result = AgentService.recommend_hyperparams(req.lottery_type, req.description)
        reason = result.pop("reason", None)
        return HyperparamsRecommendResponse(**result, reason=reason)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"推荐失败: {str(e)}")

@router.get("/recommend-models/{lottery_type}", response_model=ModelsRecommendResponse)
async def recommend_models(lottery_type: str):
    if not settings.AGENT_ENABLED:
        raise HTTPException(403, "Agent 功能未启用")
    try:
        models = AgentService.recommend_models(lottery_type)
        return ModelsRecommendResponse(models=models)
    except Exception as e:
        raise HTTPException(500, f"推荐模型失败: {str(e)}")