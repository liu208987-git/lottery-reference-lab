# -*- coding: utf-8 -*-
"""
预测接口：基于已训练模型生成预测结果。
"""
from fastapi import APIRouter, Depends, HTTPException
from datetime import date
from app.schemas.lottery import PredictRequest, PredictResponse
from app.services.predictor import get_prediction

router = APIRouter(prefix="/predict", tags=["Prediction"])

@router.post("/", response_model=PredictResponse)
async def predict(request: PredictRequest):
    """
    根据彩种和模型版本生成预测号码。
    自动将预测结果保存到对应的 forecast 表中。
    """
    try:
        result = await get_prediction(
            lottery_type=request.lottery_type,
            model_version=request.model_version,
            model_name=request.model_name   # 新增传递
        )
        return PredictResponse(
            lottery_type=request.lottery_type,
            forecast_date=date.today(),
            red=result["red"],
            blue=result["blue"],
            quality_score=result.get("quality_score"),
            model_version=result.get("model_version", "Transformer")
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"预测失败: {str(e)}")