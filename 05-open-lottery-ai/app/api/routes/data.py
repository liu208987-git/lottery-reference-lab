# -*- coding: utf-8 -*-
"""
数据查询接口：获取历史开奖数据及统计信息。
"""
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func
from app.core.database import get_db
from app.models.ssq_history import SSQHistory
from app.models.dlt_history import DLTHistory
from app.schemas.lottery import SSQHistoryResponse, DLTHistoryResponse

router = APIRouter(prefix="/data", tags=["Data"])


@router.get("/ssq")
async def get_ssq_data(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db)
):
    """
    获取双色球历史数据，按期号降序排列。
    - limit: 返回记录条数
    - offset: 偏移量，用于分页
    """
    # 查询总记录数
    total_result = await db.execute(select(func.count()).select_from(SSQHistory))
    total = total_result.scalar_one()

    result = await db.execute(
        select(SSQHistory).order_by(desc(SSQHistory.issue_num)).offset(offset).limit(limit)
    )
    items = result.scalars().all()
    return {"total": total, "items": items}


@router.get("/ssq/latest")
async def get_latest_ssq(db: AsyncSession = Depends(get_db)):
    """获取最新一期双色球开奖数据"""
    result = await db.execute(select(SSQHistory).order_by(desc(SSQHistory.issue_num)).limit(1))
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(404, "No data")
    return row


@router.get("/dlt")
async def get_dlt_data(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db)
):
    """获取大乐透历史数据"""
    # 查询总记录数
    total_result = await db.execute(select(func.count()).select_from(DLTHistory))
    total = total_result.scalar_one()

    result = await db.execute(
        select(DLTHistory).order_by(desc(DLTHistory.issue_num)).offset(offset).limit(limit)
    )
    items = result.scalars().all()
    return {"total": total, "items": items}


@router.get("/dlt/latest")
async def get_latest_dlt(db: AsyncSession = Depends(get_db)):
    """获取最新一期大乐透开奖数据"""
    result = await db.execute(select(DLTHistory).order_by(desc(DLTHistory.issue_num)).limit(1))
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(404, "No data")
    return row