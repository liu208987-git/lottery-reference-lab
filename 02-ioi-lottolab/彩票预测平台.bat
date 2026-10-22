@echo off
chcp 65001 >nul 2>&1
title 彩票预测可视化与机器自学习平台
cd /d "%~dp0"
python start_app.py
if errorlevel 1 (
    echo.
    echo 启动失败，请确保已安装Python并配置了环境变量
    echo.
    pause
)
