import os
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent.parent

def run_fetch_script(lottery_type: str) -> dict:
    script_map = {
        'ssq': 'fetch_ssq_incremental.py',
        'dlt': 'fetch_dlt_incremental.py'
    }
    script_name = script_map.get(lottery_type)
    if not script_name:
        return {'success': False, 'message': f'未知彩种: {lottery_type}'}

    script_path = BASE_DIR / 'app' / 'scripts' / script_name
    if not script_path.exists():
        return {'success': False, 'message': f'脚本不存在: {script_path}'}

    python_exec = sys.executable

    # 设置环境变量，将项目根目录加入 PYTHONPATH
    env = os.environ.copy()
    env['PYTHONPATH'] = str(BASE_DIR) + os.pathsep + env.get('PYTHONPATH', '')

    try:
        result = subprocess.run(
            [python_exec, str(script_path)],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=str(BASE_DIR),
            env=env  # 添加环境变量
        )
        if result.returncode == 0:
            return {'success': True, 'message': result.stdout.strip() or '数据更新成功'}
        else:
            return {'success': False, 'message': result.stderr.strip() or '脚本执行失败'}
    except subprocess.TimeoutExpired:
        return {'success': False, 'message': '数据抓取超时（超过2分钟）'}
    except Exception as e:
        return {'success': False, 'message': str(e)}