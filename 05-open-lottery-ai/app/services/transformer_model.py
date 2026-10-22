# -*- coding: utf-8 -*-
"""
Transformer 模型定义，用于彩票序列预测。
"""
import torch
import torch.nn as nn
import math

class PositionalEncoding(nn.Module):
    """位置编码，为序列添加位置信息"""
    def __init__(self, d_model, max_len=5000):
        super().__init__()
        pe = torch.zeros(max_len, d_model)
        position = torch.arange(0, max_len, dtype=torch.float).unsqueeze(1)
        div_term = torch.exp(torch.arange(0, d_model, 2).float() * (-math.log(10000.0) / d_model))
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)
        pe = pe.unsqueeze(0)  # (1, max_len, d_model)
        self.register_buffer('pe', pe)

    def forward(self, x):
        return x + self.pe[:, :x.size(1), :]

class LotteryTransformer(nn.Module):
    """
    彩票预测 Transformer 模型。
    输入形状: (batch, seq_len, input_dim)
    输出形状: (batch, output_dim) 其中 output_dim=7 (6个红球+1个蓝球)
    """
    def __init__(self, input_dim, d_model=128, nhead=4, num_layers=3, output_dim=7):
        super().__init__()
        self.input_proj = nn.Linear(input_dim, d_model)
        self.pos_enc = PositionalEncoding(d_model)
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=nhead,
            batch_first=True,
            dropout=0.1
        )
        self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=num_layers)
        self.output_layer = nn.Linear(d_model, output_dim)

    def forward(self, x):
        # x: (batch, seq_len, input_dim)
        x = self.input_proj(x)          # (batch, seq_len, d_model)
        x = self.pos_enc(x)             # 加上位置编码
        x = self.encoder(x)             # (batch, seq_len, d_model)
        x = x[:, -1, :]                 # 取最后一个时间步的输出
        return self.output_layer(x)     # (batch, output_dim)