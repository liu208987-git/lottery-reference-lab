"""彩票预测平台 - 桌面启动器

双击运行 start_app.py 或 彩票预测平台.bat 即可：
1. 自动启动Flask服务器
2. 自动打开默认浏览器
3. 关闭窗口即停止服务
"""

import webbrowser
import threading
import time
import sys
import os

# 确保工作目录为脚本所在目录
os.chdir(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def open_browser():
    """延迟2秒后打开浏览器，等待Flask启动完成。"""
    time.sleep(2)
    webbrowser.open("http://localhost:5000")


def main():
    print("=" * 55)
    print("       彩票预测可视化与机器自学习平台")
    print("=" * 55)
    print()
    print("  正在启动服务...")
    print("  浏览器将自动打开，请勿关闭此窗口")
    print("  关闭此窗口即可停止服务")
    print()

    # 后台线程打开浏览器
    threading.Thread(target=open_browser, daemon=True).start()

    # 启动Flask（延迟import避免浏览器先打开）
    from web_app import app
    app.run(host="127.0.0.1", port=5000, debug=False)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n服务已停止。")
    except Exception as e:
        print(f"\n启动失败: {e}")
        print("请检查Python环境是否正确安装。")
        input("按回车键退出...")
