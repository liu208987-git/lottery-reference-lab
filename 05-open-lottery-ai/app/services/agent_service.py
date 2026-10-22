# -*- coding: utf-8 -*-
import logging
import json
import os
import traceback
from typing import List, Dict, Any, Optional
from datetime import datetime
import numpy as np
import httpx
from sentence_transformers import SentenceTransformer
from openai import OpenAI
from sqlalchemy import select, desc
from app.core.config import settings
from app.core.database import SyncSessionLocal
from app.models.ssq_history import SSQHistory  # 用于获取数据量
from app.models.dlt_history import DLTHistory
from app.models.ssq_forecast import SSQForecast
from app.models.dlt_forecast import DLTForecast
from app.core.agent_templates import SYSTEM_PROMPT, USER_PROMPT_TEMPLATE

logger = logging.getLogger(__name__)

class AgentService:
    _embedding_model = None
    _llm_client = None

    @classmethod
    def _get_embedding_model(cls):
        if cls._embedding_model is None:
            logger.info(f"加载嵌入模型: {settings.EMBEDDING_MODEL_NAME}")
            cls._embedding_model = SentenceTransformer(settings.EMBEDDING_MODEL_NAME)
        return cls._embedding_model

    @classmethod
    def _get_llm_client(cls):
        if cls._llm_client is None:
            if not settings.DEEPSEEK_API_KEY:
                raise ValueError("DEEPSEEK_API_KEY 未配置，无法使用大模型")
            http_client = httpx.Client(timeout=60.0, follow_redirects=True)
            cls._llm_client = OpenAI(
                api_key=settings.DEEPSEEK_API_KEY,
                base_url=settings.DEEPSEEK_BASE_URL,
                http_client=http_client,
            )
        return cls._llm_client

    @classmethod
    def _get_embedding(cls, text: str) -> np.ndarray:
        model = cls._get_embedding_model()
        return model.encode(text, normalize_embeddings=True)

    @classmethod
    def _fetch_historical_tasks(cls, lottery_type: str) -> List[Dict[str, Any]]:
        """从数据库获取已完成的历史训练任务（基于预测记录反向推断）"""
        # 由于没有专门的训练任务表，我们用预测记录中的 model_version 和 quality_score 来代表历史训练结果
        # 同时查询历史数据量作为参考
        with SyncSessionLocal() as session:
            # 查询该彩种所有预测记录，按模型版本分组，取最高质量评分
            if lottery_type == 'ssq':
                stmt = select(SSQForecast).where(
                    SSQForecast.model_version.isnot(None)
                ).order_by(desc(SSQForecast.create_time))
            else:
                stmt = select(DLTForecast).where(
                    DLTForecast.model_version.isnot(None)
                ).order_by(desc(DLTForecast.create_time))
            results = session.execute(stmt).scalars().all()

            # 按 model_version 去重，保留最新的一条记录（代表该模型的最终质量）
            model_map = {}
            for rec in results:
                model_name = rec.model_version
                if model_name not in model_map:
                    model_map[model_name] = rec
            tasks = []
            for model_name, rec in model_map.items():
                # 从模型文件名解析超参数（如果有）
                # 例如: ssq_epochs200_bs128_seq30_lr0_00005_1234567890.pt
                try:
                    parts = model_name.replace('.pt', '').split('_')
                    epochs = None
                    batch_size = None
                    seq_len = None
                    learning_rate = None
                    for p in parts:
                        if p.startswith('epochs'):
                            epochs = int(p.replace('epochs', ''))
                        elif p.startswith('bs'):
                            batch_size = int(p.replace('bs', ''))
                        elif p.startswith('seq'):
                            seq_len = int(p.replace('seq', ''))
                        elif p.startswith('lr'):
                            lr_str = p.replace('lr', '').replace('_', '.')
                            try:
                                learning_rate = float(lr_str)
                            except:
                                pass
                except:
                    pass
                if epochs is None or batch_size is None:
                    continue
                task_info = {
                    'model_name': model_name,
                    'epochs': epochs,
                    'batch_size': batch_size,
                    'seq_len': seq_len,
                    'learning_rate': learning_rate,
                    'quality_score': rec.quality_score,
                    'create_time': rec.create_time,
                }
                tasks.append(task_info)
            return tasks

    @classmethod
    def _build_task_text(cls, task: Dict[str, Any]) -> str:
        text = (
            f"模型: {task['model_name']} "
            f"轮数: {task['epochs']} "
            f"批次: {task['batch_size']} "
            f"序列长度: {task['seq_len']} "
            f"学习率: {task['learning_rate']} "
            f"质量评分: {task['quality_score']}"
        )
        return text

    @classmethod
    def retrieve_similar_tasks(cls, lottery_type: str, query: str, top_k: int = None) -> List[Dict[str, Any]]:
        if top_k is None:
            top_k = settings.RAG_TOP_K
        tasks = cls._fetch_historical_tasks(lottery_type)
        if not tasks:
            return []
        query_emb = cls._get_embedding(query)
        similarities = []
        for task in tasks:
            task_text = cls._build_task_text(task)
            task_emb = cls._get_embedding(task_text)
            sim = float(np.dot(query_emb, task_emb))
            similarities.append((sim, task))
        similarities.sort(key=lambda x: x[0], reverse=True)
        return [task for _, task in similarities[:top_k]]

    @classmethod
    def recommend_hyperparams(cls, lottery_type: str, description: str = "") -> Dict[str, Any]:
        if not settings.DEEPSEEK_API_KEY:
            raise ValueError("DEEPSEEK_API_KEY 未配置，无法使用推荐功能")
        lottery_name = "双色球" if lottery_type == 'ssq' else "大乐透"
        query_text = f"{lottery_type} {description}"
        similar_tasks = cls.retrieve_similar_tasks(lottery_type, query_text)
        similar_info = ""
        if similar_tasks:
            for idx, task in enumerate(similar_tasks, 1):
                similar_info += f"\n--- 相似任务 {idx} ---\n"
                similar_info += f"模型: {task['model_name']}\n"
                similar_info += f"轮数: {task['epochs']}\n"
                similar_info += f"批次: {task['batch_size']}\n"
                similar_info += f"序列长度: {task['seq_len']}\n"
                similar_info += f"学习率: {task['learning_rate']}\n"
                similar_info += f"质量评分: {task['quality_score']}\n"
        else:
            similar_info = "无历史相似任务，请根据通用经验推荐。"

        client = cls._get_llm_client()
        user_prompt = USER_PROMPT_TEMPLATE.format(
            lottery_type=lottery_type,
            lottery_name=lottery_name,
            similar_tasks=similar_info
        )

        try:
            response = client.chat.completions.create(
                model="deepseek-chat",
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.3,
                response_format={"type": "json_object"}
            )
            content = response.choices[0].message.content
        except Exception as e:
            logger.error(f"调用大模型失败: {traceback.format_exc()}")
            raise ValueError(f"大模型调用失败: {str(e)}")

        try:
            recommendation = json.loads(content)
        except json.JSONDecodeError:
            import re
            json_match = re.search(r'\{.*\}', content, re.DOTALL)
            if json_match:
                recommendation = json.loads(json_match.group())
            else:
                raise ValueError(f"大模型返回非 JSON 格式: {content}")

        required = ["epochs", "batch_size", "seq_len", "learning_rate"]
        for field in required:
            if field not in recommendation:
                raise ValueError(f"推荐结果缺少字段: {field}")
        return recommendation

    @classmethod
    def recommend_models(cls, lottery_type: str, top_k: int = 5) -> List[str]:
        """推荐质量评分最高的模型名称列表"""
        tasks = cls._fetch_historical_tasks(lottery_type)
        if not tasks:
            return []
        # 按质量评分降序排序
        sorted_tasks = sorted(tasks, key=lambda x: x.get('quality_score', 0), reverse=True)
        return [t['model_name'] for t in sorted_tasks[:top_k] if t.get('model_name')]