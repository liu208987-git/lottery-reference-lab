# -*- coding: utf-8 -*-
"""
FastAPI 应用入口，注册路由、中间件和生命周期事件。
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.routes import health, data, train, predict, models, analysis,agent
from app.core.database import engine, Base

app = FastAPI(
    title="Open-Lottery-AI",
    description="基于 PyTorch + Transformer 的彩票预测系统后端",
    version="1.0.0"
)

# 配置 CORS（允许前端跨域访问）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # 生产环境请替换为前端域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(health.router)
app.include_router(data.router)
app.include_router(train.router)
app.include_router(predict.router)
app.include_router(models.router)
app.include_router(analysis.router)
app.include_router(agent.router)

@app.on_event("startup")
async def startup_event():
    """启动时创建数据库表（如果不存在）"""
    async with engine.begin() as conn:
        # 注意：生产环境建议使用 Alembic 迁移，这里仅为快速开发
        await conn.run_sync(Base.metadata.create_all)
    print("✅ 数据库连接成功，表结构已就绪")

@app.on_event("shutdown")
async def shutdown_event():
    """关闭时释放数据库连接池"""
    await engine.dispose()
    print("🛑 数据库连接已关闭")