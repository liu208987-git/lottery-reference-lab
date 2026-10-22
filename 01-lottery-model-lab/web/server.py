#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import mimetypes
import os
import subprocess
import sys
import threading
import traceback
import uuid
import webbrowser
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo


LAB_ROOT = Path(__file__).resolve().parents[1]
MODEL_DATA_ROOT = LAB_ROOT / "model_data"
STATIC_ROOT = Path(__file__).resolve().parent / "static"


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


APP_MODE = os.environ.get("LOTTERY_APP_MODE", "private").strip().lower()
PUBLIC_MODE = APP_MODE == "public" or env_flag("LOTTERY_PUBLIC_MODE")
APP_MODE = "public" if PUBLIC_MODE else "private"
RUNTIME_ROOT = (
    Path(os.environ["LOTTERY_RUNTIME_ROOT"]).expanduser()
    if os.environ.get("LOTTERY_RUNTIME_ROOT")
    else None
)
RESULTS_ROOT = (
    Path(os.environ["LOTTERY_RESULTS_ROOT"]).expanduser()
    if os.environ.get("LOTTERY_RESULTS_ROOT")
    else (RUNTIME_ROOT / "results" if RUNTIME_ROOT else LAB_ROOT / "results")
)
PRIVATE_DATA_ROOT = Path(
    os.environ.get("LOTTERY_PRIVATE_DATA_ROOT", str(LAB_ROOT / "data"))
).expanduser()
MANUAL_ENTRIES = None if PUBLIC_MODE else PRIVATE_DATA_ROOT / "manual_entries.csv"
SYNCED_ENTRIES = None if PUBLIC_MODE else PRIVATE_DATA_ROOT / "synced_entries.csv"
LUNAR_CALENDAR_PATH = (
    Path(os.environ["LOTTERY_LUNAR_CALENDAR_PATH"]).expanduser()
    if os.environ.get("LOTTERY_LUNAR_CALENDAR_PATH")
    else (
        RUNTIME_ROOT / "lunar_calendar.csv"
        if RUNTIME_ROOT
        else MODEL_DATA_ROOT / "lunar_calendar.csv"
    )
)
PUBLIC_MAX_FUTURE_DAYS = max(
    1, int(os.environ.get("LOTTERY_PUBLIC_MAX_FUTURE_DAYS", "366"))
)
ALLOWED_ORIGINS = {
    item.strip().rstrip("/")
    for item in os.environ.get("LOTTERY_ALLOWED_ORIGINS", "").split(",")
    if item.strip()
}
RUNNER = LAB_ROOT / "run_experiments.py"
TRAIN_TIMEOUT_SECONDS = 2 * 60 * 60
TRAINING_CODE_PATHS = {
    "run_experiments.py": RUNNER,
    "src/lottery_lab.py": LAB_ROOT / "src" / "lottery_lab.py",
    "src/model_selection.py": LAB_ROOT / "src" / "model_selection.py",
    "src/p1_analysis.py": LAB_ROOT / "src" / "p1_analysis.py",
    "src/null_audit.py": LAB_ROOT / "src" / "null_audit.py",
    "src/p0_reporting.py": LAB_ROOT / "src" / "p0_reporting.py",
    "src/pipeline_adapter.py": LAB_ROOT / "src" / "pipeline_adapter.py",
    "src/pipeline_null.py": LAB_ROOT / "src" / "pipeline_null.py",
    "scripts/chinese_calendar.swift": LAB_ROOT / "scripts" / "chinese_calendar.swift",
}
sys.path.insert(0, str(LAB_ROOT / "src"))

from lottery_lab import (  # noqa: E402
    Draw,
    GAME_SPECS,
    load_effective_draws,
    predict_target,
    sha256_file,
    suggest_next_draw,
    validate_draw,
)
from data_sync import SyncScan, scan_missing_draws  # noqa: E402


DATA_PATHS = (
    {
        "ssq": RUNTIME_ROOT / "ssq_history.csv",
        "dlt": RUNTIME_ROOT / "dlt_history.csv",
    }
    if RUNTIME_ROOT
    else {
        "ssq": MODEL_DATA_ROOT / "ssq_history.csv",
        "dlt": MODEL_DATA_ROOT / "dlt_history.csv",
    }
)
DATA_LOCK = threading.Lock()
MODEL_DATA_LOCK = threading.Lock()
TRAIN_LOCK = threading.Lock()
SYNC_LOCK = threading.Lock()
PREDICTION_LOCK = threading.Lock()
TRAIN_STATE: dict[str, object] = {
    "status": "disabled" if PUBLIC_MODE else "idle",
    "started_at": None,
    "finished_at": None,
    "message": "公开试玩模式不开放训练" if PUBLIC_MODE else "尚未在本次服务启动后训练",
    "output": "",
}
SYNC_STATE: dict[str, object] = {
    "status": "disabled" if PUBLIC_MODE else "idle",
    "started_at": None,
    "finished_at": None,
    "message": "公开试玩模式使用只读快照" if PUBLIC_MODE else "等待启动自动扫描",
    "trigger": None,
    "trusted_time": None,
    "games": {},
    "candidate_count": 0,
    "appended_count": 0,
    "error": None,
}
SYNC_ENTRY_FIELDS = [
    "lottery_code",
    "issue",
    "draw_date",
    "front_numbers",
    "back_numbers",
    "created_at_utc",
    "source_url",
    "trusted_time_utc",
]
PREDICTION_JOBS: dict[str, dict[str, object]] = {}


def prediction_event(update: dict[str, object]) -> dict[str, object]:
    return {
        "timestamp": utc_now(),
        "progress": int(update.get("progress", 0)),
        "stage": str(update.get("stage", "")),
        "title": str(update.get("title", "")),
        "detail": str(update.get("detail", "")),
        "zone": update.get("zone"),
        "models": list(update.get("models", [])),
    }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def training_state_snapshot() -> dict[str, object]:
    with TRAIN_LOCK:
        return dict(TRAIN_STATE)


def sync_state_snapshot() -> dict[str, object]:
    with SYNC_LOCK:
        return json.loads(json.dumps(SYNC_STATE, ensure_ascii=False))


def load_game_draws(code: str) -> list[Draw]:
    return load_effective_draws(
        DATA_PATHS[code],
        GAME_SPECS[code],
        MANUAL_ENTRIES,
        SYNCED_ENTRIES,
    )


def trusted_current_date() -> date:
    with SYNC_LOCK:
        trusted_time = SYNC_STATE.get("trusted_time")
        if isinstance(trusted_time, dict) and trusted_time.get("current_date"):
            try:
                return date.fromisoformat(str(trusted_time["current_date"]))
            except ValueError:
                pass
    return date.today()


def try_queue_training() -> bool:
    if PUBLIC_MODE:
        return False
    with SYNC_LOCK:
        if SYNC_STATE["status"] in {"queued", "running"}:
            return False
    with TRAIN_LOCK:
        if TRAIN_STATE["status"] in {"queued", "running"}:
            return False
        TRAIN_STATE.update(
            {
                "status": "queued",
                "started_at": None,
                "finished_at": None,
                "message": "训练任务已排队",
                "output": "",
            }
        )
        return True


def try_queue_sync(trigger: str = "manual") -> bool:
    if PUBLIC_MODE:
        return False
    with TRAIN_LOCK:
        if TRAIN_STATE["status"] in {"queued", "running"}:
            return False
    with SYNC_LOCK:
        if SYNC_STATE["status"] in {"queued", "running"}:
            return False
        SYNC_STATE.update(
            {
                "status": "queued",
                "started_at": None,
                "finished_at": None,
                "message": "自动扫描已排队",
                "trigger": trigger,
                "candidate_count": 0,
                "appended_count": 0,
                "error": None,
            }
        )
        return True


def prediction_job_snapshot(job_id: str) -> dict[str, object]:
    with PREDICTION_LOCK:
        job = PREDICTION_JOBS.get(job_id)
        if job is None:
            raise ValueError("预测任务不存在或已过期")
        return json.loads(json.dumps(job, ensure_ascii=False))


def try_queue_prediction(payload: dict[str, object]) -> str | None:
    with PREDICTION_LOCK:
        if any(
            job.get("status") in {"queued", "running"}
            for job in PREDICTION_JOBS.values()
        ):
            return None
        completed = [
            (job_id, str(job.get("finished_at") or ""))
            for job_id, job in PREDICTION_JOBS.items()
            if job.get("status") in {"completed", "failed"}
        ]
        for old_job_id, _ in sorted(completed, key=lambda item: item[1])[:-8]:
            PREDICTION_JOBS.pop(old_job_id, None)
        job_id = uuid.uuid4().hex
        queued_update = {
            "progress": 0,
            "stage": "queued",
            "title": "预测实验已进入队列",
            "detail": "正在准备冻结数据与模型参数。",
            "zone": None,
            "models": [],
        }
        PREDICTION_JOBS[job_id] = {
            "job_id": job_id,
            "status": "queued",
            **queued_update,
            "started_at": None,
            "updated_at": utc_now(),
            "finished_at": None,
            "result": None,
            "error": None,
            "events": [prediction_event(queued_update)],
            "request": {
                "lottery_code": str(payload.get("lottery_code", "")),
                "issue": str(payload.get("issue", "")),
                "draw_date": str(payload.get("draw_date", "")),
            },
        }
        return job_id


def prediction_worker(job_id: str, payload: dict[str, object]) -> None:
    started_update = {
        "progress": 1,
        "stage": "startup",
        "title": "启动预测实验流水线",
        "detail": "锁定本次请求的彩种、期号与开奖日期。",
        "zone": None,
        "models": [],
    }
    with PREDICTION_LOCK:
        PREDICTION_JOBS[job_id].update(
            {
                "status": "running",
                "started_at": utc_now(),
                "updated_at": utc_now(),
                **started_update,
            }
        )
        PREDICTION_JOBS[job_id]["events"].append(
            prediction_event(started_update)
        )

    def report_progress(update: dict[str, object]) -> None:
        with PREDICTION_LOCK:
            job = PREDICTION_JOBS.get(job_id)
            if job is not None and job.get("status") == "running":
                job.update(update)
                job["updated_at"] = utc_now()
                events = job.setdefault("events", [])
                if isinstance(events, list):
                    events.append(prediction_event(update))
                    del events[:-32]

    try:
        code = str(payload.get("lottery_code", ""))
        result = predict_target(
            data_path=DATA_PATHS[code],
            spec=GAME_SPECS[code],
            target_issue=str(payload.get("issue", "")).strip(),
            target_date=date.fromisoformat(str(payload.get("draw_date", ""))),
            swift_helper=LAB_ROOT / "scripts" / "chinese_calendar.swift",
            ga_weights_path=RESULTS_ROOT / "ga_weights.json",
            manual_entries_path=MANUAL_ENTRIES,
            synced_entries_path=SYNCED_ENTRIES,
            lunar_calendar_path=LUNAR_CALENDAR_PATH,
            progress_callback=report_progress,
        )
        completed_update = {
            "progress": 100,
            "stage": "completed",
            "title": "预测实验完成",
            "detail": "全部模型结果已冻结，正在切换到号码卡片。",
            "zone": None,
            "models": [],
        }
        with PREDICTION_LOCK:
            PREDICTION_JOBS[job_id].update(
                {
                    "status": "completed",
                    **completed_update,
                    "updated_at": utc_now(),
                    "finished_at": utc_now(),
                    "result": result,
                }
            )
            PREDICTION_JOBS[job_id]["events"].append(
                prediction_event(completed_update)
            )
    except Exception as error:
        failed_update = {
            "progress": 100,
            "stage": "failed",
            "title": "预测实验中止",
            "detail": str(error),
            "zone": None,
            "models": [],
        }
        with PREDICTION_LOCK:
            PREDICTION_JOBS[job_id].update(
                {
                    "status": "failed",
                    **failed_update,
                    "updated_at": utc_now(),
                    "finished_at": utc_now(),
                    "error": str(error),
                }
            )
            PREDICTION_JOBS[job_id]["events"].append(
                prediction_event(failed_update)
            )


def parse_scalar(value: str) -> object:
    if value == "":
        return value
    try:
        if any(character in value for character in (".", "e", "E")):
            return float(value)
        return int(value)
    except ValueError:
        return value


def read_csv_rows(path: Path) -> list[dict[str, object]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return [
            {key: parse_scalar(value) for key, value in row.items()}
            for row in csv.DictReader(handle)
        ]


def results_are_stale() -> bool:
    manifest_path = RESULTS_ROOT / "experiment_manifest.json"
    if not manifest_path.exists():
        return True
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for code, path in DATA_PATHS.items():
            if manifest["data_files"][code]["sha256"] != sha256_file(path):
                return True
        recorded_code = manifest.get("code_files", {})
        for name, path in TRAINING_CODE_PATHS.items():
            if recorded_code.get(name, {}).get("sha256") != sha256_file(path):
                return True
        for name, metadata in manifest.get("result_files", {}).items():
            result_path = RESULTS_ROOT / name
            if (
                not result_path.exists()
                or metadata.get("sha256") != sha256_file(result_path)
            ):
                return True
        recorded_manual = manifest.get("manual_entries_file")
        if MANUAL_ENTRIES is not None and MANUAL_ENTRIES.exists():
            if not recorded_manual or recorded_manual.get("sha256") != sha256_file(
                MANUAL_ENTRIES
            ):
                return True
        elif recorded_manual is not None:
            return True
        recorded_synced = manifest.get("synced_entries_file")
        if SYNCED_ENTRIES is not None and SYNCED_ENTRIES.exists():
            if not recorded_synced or recorded_synced.get("sha256") != sha256_file(
                SYNCED_ENTRIES
            ):
                return True
        elif recorded_synced is not None:
            return True
        recorded_calendar = manifest.get("calendar_file")
        if recorded_calendar is not None:
            if (
                not isinstance(recorded_calendar, dict)
                or LUNAR_CALENDAR_PATH is None
                or not LUNAR_CALENDAR_PATH.exists()
                or recorded_calendar.get("sha256")
                != sha256_file(LUNAR_CALENDAR_PATH)
            ):
                return True
        elif PUBLIC_MODE:
            return True
        return False
    except (OSError, KeyError, ValueError, json.JSONDecodeError):
        return True


def best_models() -> list[dict[str, object]]:
    rows = read_csv_rows(RESULTS_ROOT / "model_metrics.csv")
    best: dict[tuple[str, str], dict[str, object]] = {}
    for row in rows:
        key = (str(row["lottery_code"]), str(row["zone"]))
        current = best.get(key)
        if current is None or float(row["brier_skill_vs_uniform"]) > float(
            current["brier_skill_vs_uniform"]
        ):
            best[key] = row
    return list(best.values())


def read_json_file(path: Path) -> object | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def get_audit_payload() -> dict[str, object]:
    manifest = read_json_file(RESULTS_ROOT / "experiment_manifest.json")
    return {
        "config": manifest.get("p0_audit") if isinstance(manifest, dict) else None,
        "p1_config": manifest.get("p1") if isinstance(manifest, dict) else None,
        "splits": manifest.get("splits") if isinstance(manifest, dict) else None,
        "summary": read_csv_rows(RESULTS_ROOT / "p0_audit_summary.csv"),
        "pipeline_null": read_csv_rows(
            RESULTS_ROOT / "pipeline_null_summary.csv"
        ),
        "cutoff_comparison": read_csv_rows(
            RESULTS_ROOT / "cutoff_comparison.csv"
        ),
        "eras": read_csv_rows(RESULTS_ROOT / "dlt_era_audit.csv"),
        "change_points": read_csv_rows(
            RESULTS_ROOT / "change_point_audit.csv"
        ),
        "source_crosscheck": read_json_file(
            RESULTS_ROOT / "dlt_source_crosscheck.json"
        ),
        "p1_hyperparameters": read_csv_rows(
            RESULTS_ROOT / "p1_hyperparameter_selection.csv"
        ),
        "moving_block_bootstrap": read_csv_rows(
            RESULTS_ROOT / "moving_block_bootstrap.csv"
        ),
        "calibration": read_csv_rows(
            RESULTS_ROOT / "calibration_audit.csv"
        ),
        "brier_decomposition": read_csv_rows(
            RESULTS_ROOT / "brier_decomposition.csv"
        ),
    }


def get_status() -> dict[str, object]:
    games: dict[str, object] = {}
    for code, spec in GAME_SPECS.items():
        draws = load_game_draws(code)
        next_issue, next_date = suggest_next_draw(draws, spec)
        games[code] = {
            "name": spec.name,
            "record_count": len(draws),
            "earliest_issue": draws[0].issue,
            "earliest_date": draws[0].draw_date.isoformat(),
            "latest_issue": draws[-1].issue,
            "latest_date": draws[-1].draw_date.isoformat(),
            "suggested_next_issue": next_issue,
            "suggested_next_date": next_date.isoformat(),
            "front_pool": spec.front_pool,
            "front_pick": spec.front_pick,
            "back_pool": spec.back_pool,
            "back_pick": spec.back_pick,
        }
    manifest_path = RESULTS_ROOT / "experiment_manifest.json"
    manifest = (
        json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest_path.exists()
        else None
    )
    if manifest:
        for code, split in manifest.get("splits", {}).items():
            if code in games:
                games[code].update(
                    {
                        "model_record_count": split.get(
                            "model_draw_count", games[code]["record_count"]
                        ),
                        "model_start_date": split.get("model_start_date"),
                        "excluded_history_count": split.get(
                            "excluded_pre_model_count", 0
                        ),
                    }
                )
    return {
        "app_mode": "public" if PUBLIC_MODE else "private",
        "capabilities": {
            "can_predict": True,
            "can_train": not PUBLIC_MODE,
            "can_sync": not PUBLIC_MODE,
            "can_write_draws": not PUBLIC_MODE,
        },
        "games": games,
        "results_stale": results_are_stale(),
        "results_generated_at": manifest.get("generated_at_utc") if manifest else None,
        "calendar_source": manifest.get("calendar_source") if manifest else None,
        "best_models": best_models(),
        "training": training_state_snapshot(),
        "sync": sync_state_snapshot(),
    }


def append_manual_draw(payload: dict[str, object]) -> Draw:
    if MANUAL_ENTRIES is None:
        raise PermissionError("公开试玩模式不允许录入数据")
    code = str(payload.get("lottery_code", ""))
    if code not in GAME_SPECS:
        raise ValueError("lottery_code 必须是 ssq 或 dlt")
    spec = GAME_SPECS[code]
    issue = str(payload.get("issue", "")).strip()
    if not issue.isdigit():
        raise ValueError("期号必须为数字文本")
    draw_date = date.fromisoformat(str(payload.get("draw_date", "")))
    current_date = trusted_current_date()
    if draw_date > current_date:
        raise ValueError(
            f"开奖日期不能晚于今天（可信当前日期 {current_date.isoformat()}）"
        )
    front = tuple(sorted(int(value) for value in payload.get("front", [])))
    back = tuple(sorted(int(value) for value in payload.get("back", [])))
    draw = Draw(issue=issue, draw_date=draw_date, front=front, back=back)
    validate_draw(draw, spec)

    if not MODEL_DATA_LOCK.acquire(blocking=False):
        raise ValueError("模型训练正在冻结数据快照，请训练完成后再录入")
    try:
        with DATA_LOCK:
            current = load_game_draws(code)
            expected_issue, _ = suggest_next_draw(current, spec)
            if issue != expected_issue:
                raise ValueError(f"期号必须是当前下一期: {expected_issue}")
            latest_draw = current[-1]
            if draw_date <= latest_draw.draw_date:
                raise ValueError(
                    f"开奖日期必须晚于当前最新记录: {latest_draw.draw_date.isoformat()}"
                )
            if issue in {item.issue for item in current}:
                raise ValueError(f"期号已存在: {issue}")
            rows: list[dict[str, str]] = []
            if MANUAL_ENTRIES.exists():
                with MANUAL_ENTRIES.open(
                    "r", encoding="utf-8-sig", newline=""
                ) as handle:
                    rows = list(csv.DictReader(handle))
            rows.append(
                {
                    "lottery_code": code,
                    "issue": issue,
                    "draw_date": draw_date.isoformat(),
                    "front_numbers": " ".join(f"{number:02d}" for number in front),
                    "back_numbers": " ".join(f"{number:02d}" for number in back),
                    "created_at_utc": utc_now(),
                }
            )
            rows.sort(
                key=lambda row: (row["draw_date"], row["lottery_code"], row["issue"])
            )
            MANUAL_ENTRIES.parent.mkdir(parents=True, exist_ok=True)
            temporary = MANUAL_ENTRIES.with_suffix(".tmp")
            with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(
                    handle,
                    fieldnames=[
                        "lottery_code",
                        "issue",
                        "draw_date",
                        "front_numbers",
                        "back_numbers",
                        "created_at_utc",
                    ],
                )
                writer.writeheader()
                writer.writerows(rows)
            temporary.replace(MANUAL_ENTRIES)
    finally:
        MODEL_DATA_LOCK.release()
    return draw


def persist_synced_draws(scan: SyncScan) -> dict[str, int]:
    if SYNCED_ENTRIES is None:
        raise PermissionError("公开试玩模式不允许写入同步数据")
    appended = {code: 0 for code in GAME_SPECS}
    if not MODEL_DATA_LOCK.acquire(blocking=False):
        raise ValueError("模型训练正在冻结数据快照，请训练完成后重新扫描")
    try:
        with DATA_LOCK:
            current_by_code = {
                code: {draw.issue: draw for draw in load_game_draws(code)}
                for code in GAME_SPECS
            }
            rows: list[dict[str, str]] = []
            existing_row_keys: set[tuple[str, str]] = set()
            if SYNCED_ENTRIES.exists():
                with SYNCED_ENTRIES.open(
                    "r", encoding="utf-8-sig", newline=""
                ) as handle:
                    for raw_row in csv.DictReader(handle):
                        row = {
                            field: str(raw_row.get(field, ""))
                            for field in SYNC_ENTRY_FIELDS
                        }
                        key = (row["lottery_code"], row["issue"])
                        if key in existing_row_keys:
                            continue
                        existing_row_keys.add(key)
                        rows.append(row)

            for code, game_result in scan.games.items():
                if game_result.error:
                    continue
                current = current_by_code[code]
                for draw in game_result.candidates:
                    existing = current.get(draw.issue)
                    if existing is not None:
                        if existing != draw:
                            raise ValueError(
                                f"{GAME_SPECS[code].name}自动同步发生并发冲突: {draw.issue}"
                            )
                        continue
                    key = (code, draw.issue)
                    if key in existing_row_keys:
                        continue
                    rows.append(
                        {
                            "lottery_code": code,
                            "issue": draw.issue,
                            "draw_date": draw.draw_date.isoformat(),
                            "front_numbers": " ".join(
                                f"{number:02d}" for number in draw.front
                            ),
                            "back_numbers": " ".join(
                                f"{number:02d}" for number in draw.back
                            ),
                            "created_at_utc": utc_now(),
                            "source_url": "https://jc.zhcw.com/port/client_json.php",
                            "trusted_time_utc": scan.trusted_time.now_utc.isoformat(),
                        }
                    )
                    existing_row_keys.add(key)
                    current[draw.issue] = draw
                    appended[code] += 1

            if sum(appended.values()) == 0:
                return appended
            rows.sort(
                key=lambda row: (
                    row["draw_date"],
                    row["lottery_code"],
                    int(row["issue"]),
                )
            )
            SYNCED_ENTRIES.parent.mkdir(parents=True, exist_ok=True)
            temporary = SYNCED_ENTRIES.with_suffix(".tmp")
            with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=SYNC_ENTRY_FIELDS)
                writer.writeheader()
                writer.writerows(rows)
            temporary.replace(SYNCED_ENTRIES)
        return appended
    finally:
        MODEL_DATA_LOCK.release()


def sync_worker(trigger: str = "manual") -> None:
    with SYNC_LOCK:
        SYNC_STATE.update(
            {
                "status": "running",
                "started_at": utc_now(),
                "finished_at": None,
                "message": "正在联网校时并扫描缺失开奖",
                "trigger": trigger,
                "error": None,
            }
        )
    try:
        existing = {code: load_game_draws(code) for code in GAME_SPECS}
        scan = scan_missing_draws(existing)
        appended_by_code = persist_synced_draws(scan)
        payload = scan.as_dict()
        for code, count in appended_by_code.items():
            payload["games"][code]["appended_count"] = count
        errors = [
            f"{GAME_SPECS[code].name}: {result.error}"
            for code, result in scan.games.items()
            if result.error
        ]
        appended_count = sum(appended_by_code.values())
        if len(errors) == len(GAME_SPECS):
            status = "failed"
        elif errors:
            status = "partial"
        else:
            status = "completed"
        time_message = (
            "网络时间已校准"
            if scan.trusted_time.uses_network_time
            else "网络校时失败，已明确降级为本机时间"
        )
        message = f"{time_message}；自动补入 {appended_count} 期"
        if errors:
            message += f"；{len(errors)} 个彩种扫描异常"
        with SYNC_LOCK:
            SYNC_STATE.update(
                {
                    "status": status,
                    "finished_at": utc_now(),
                    "message": message,
                    "trusted_time": payload["trusted_time"],
                    "games": payload["games"],
                    "candidate_count": payload["candidate_count"],
                    "appended_count": appended_count,
                    "error": "；".join(errors) if errors else None,
                }
            )
    except Exception as error:
        with SYNC_LOCK:
            SYNC_STATE.update(
                {
                    "status": "failed",
                    "finished_at": utc_now(),
                    "message": "自动扫描失败",
                    "error": str(error),
                }
            )


def training_worker() -> None:
    with TRAIN_LOCK:
        TRAIN_STATE.update(
            {
                "status": "running",
                "started_at": utc_now(),
                "finished_at": None,
                "message": "正在执行 P0 审计、P1 嵌套调参、GA 验证和完整公平管线模拟",
                "output": "",
            }
        )
    try:
        with MODEL_DATA_LOCK:
            completed = subprocess.run(
                [sys.executable, str(RUNNER)],
                cwd=str(LAB_ROOT),
                text=True,
                capture_output=True,
                timeout=TRAIN_TIMEOUT_SECONDS,
            )
        success = completed.returncode == 0
        output = (completed.stdout + "\n" + completed.stderr).strip()
        with TRAIN_LOCK:
            TRAIN_STATE.update(
                {
                    "status": "completed" if success else "failed",
                    "finished_at": utc_now(),
                    "message": "训练和留出回测完成" if success else "训练失败",
                    "output": output[-12000:],
                }
            )
    except Exception:
        with TRAIN_LOCK:
            TRAIN_STATE.update(
                {
                    "status": "failed",
                    "finished_at": utc_now(),
                    "message": "训练进程异常终止",
                    "output": traceback.format_exc()[-12000:],
                }
            )


class AppHandler(BaseHTTPRequestHandler):
    server_version = "LotteryLab/1.0"
    sys_version = ""

    def log_message(self, format_string: str, *args: object) -> None:
        sys.stdout.write(
            f"[{self.log_date_time_string()}] {format_string % args}\n"
        )

    def send_json(
        self,
        payload: object,
        status: HTTPStatus = HTTPStatus.OK,
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header(
            "Permissions-Policy",
            "camera=(), geolocation=(), microphone=()",
        )
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, object]:
        if self.headers.get_content_type() != "application/json":
            raise ValueError("Content-Type 必须为 application/json")
        origin = self.headers.get("Origin")
        if origin:
            parsed_origin = urlparse(origin)
            host_header = self.headers.get("Host", "")
            normalized_origin = f"{parsed_origin.scheme}://{parsed_origin.netloc}".rstrip("/")
            same_origin = bool(
                parsed_origin.scheme in {"http", "https"}
                and parsed_origin.netloc
                and host_header
                and parsed_origin.netloc.lower() == host_header.lower()
            )
            if not same_origin and normalized_origin not in ALLOWED_ORIGINS:
                raise ValueError("拒绝非同源网页发起的写入请求")
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0 or content_length > 1024 * 1024:
            raise ValueError("请求体为空或过大")
        return json.loads(self.rfile.read(content_length).decode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/healthz":
                self.send_json({"ok": True, "mode": APP_MODE})
                return
            if parsed.path == "/readyz":
                required = {
                    "ssq_history.csv": DATA_PATHS["ssq"],
                    "dlt_history.csv": DATA_PATHS["dlt"],
                    "experiment_manifest.json": RESULTS_ROOT
                    / "experiment_manifest.json",
                    "ga_weights.json": RESULTS_ROOT / "ga_weights.json",
                    "model_metrics.csv": RESULTS_ROOT / "model_metrics.csv",
                }
                if LUNAR_CALENDAR_PATH is not None:
                    required["lunar_calendar.csv"] = LUNAR_CALENDAR_PATH
                missing = [name for name, path in required.items() if not path.exists()]
                ready = not missing and not results_are_stale()
                self.send_json(
                    {"ok": ready, "missing": missing, "mode": APP_MODE},
                    status=HTTPStatus.OK if ready else HTTPStatus.SERVICE_UNAVAILABLE,
                )
                return
            if parsed.path == "/api/status":
                self.send_json(get_status())
                return
            if parsed.path == "/api/metrics":
                self.send_json(read_csv_rows(RESULTS_ROOT / "model_metrics.csv"))
                return
            if parsed.path == "/api/audit":
                self.send_json(get_audit_payload())
                return
            if parsed.path == "/api/training-status":
                self.send_json(training_state_snapshot())
                return
            if parsed.path == "/api/sync-status":
                self.send_json(sync_state_snapshot())
                return
            if parsed.path == "/api/predict-status":
                query = parse_qs(parsed.query)
                job_id = query.get("job_id", [""])[0]
                if not job_id:
                    raise ValueError("缺少 job_id")
                self.send_json(prediction_job_snapshot(job_id))
                return
            if parsed.path == "/api/draws":
                query = parse_qs(parsed.query)
                code = query.get("lottery_code", ["ssq"])[0]
                limit = min(100, max(1, int(query.get("limit", ["12"])[0])))
                if code not in GAME_SPECS:
                    raise ValueError("未知彩种")
                spec = GAME_SPECS[code]
                draws = load_game_draws(code)
                payload = [
                    {
                        "issue": draw.issue,
                        "draw_date": draw.draw_date.isoformat(),
                        "front": draw.front,
                        "back": draw.back,
                    }
                    for draw in reversed(draws[-limit:])
                ]
                self.send_json(payload)
                return
            if parsed.path.startswith("/api/"):
                self.send_json({"error": "未知 API"}, status=HTTPStatus.NOT_FOUND)
                return
            self.serve_static(parsed.path)
        except (ValueError, KeyError, json.JSONDecodeError) as error:
            self.send_json(
                {"error": str(error)}, status=HTTPStatus.BAD_REQUEST
            )
        except Exception as error:
            self.send_json(
                {"error": str(error)}, status=HTTPStatus.INTERNAL_SERVER_ERROR
            )

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            if PUBLIC_MODE and parsed.path in {"/api/draws", "/api/train", "/api/sync"}:
                self.send_json(
                    {"error": "公开试玩模式仅允许预测，不开放数据写入、同步或训练"},
                    status=HTTPStatus.FORBIDDEN,
                )
                return
            if parsed.path == "/api/draws":
                draw = append_manual_draw(self.read_json())
                self.send_json(
                    {
                        "ok": True,
                        "issue": draw.issue,
                        "draw_date": draw.draw_date.isoformat(),
                        "results_stale": True,
                    },
                    status=HTTPStatus.CREATED,
                )
                return
            if parsed.path == "/api/train":
                if not try_queue_training():
                    self.send_json(
                        {"error": "训练已经排队或正在运行"},
                        status=HTTPStatus.CONFLICT,
                    )
                    return
                threading.Thread(target=training_worker, daemon=True).start()
                self.send_json(
                    {"ok": True, "training": training_state_snapshot()},
                    status=HTTPStatus.ACCEPTED,
                )
                return
            if parsed.path == "/api/sync":
                if not try_queue_sync("manual"):
                    self.send_json(
                        {"error": "自动扫描已经排队或正在运行"},
                        status=HTTPStatus.CONFLICT,
                    )
                    return
                threading.Thread(
                    target=sync_worker,
                    args=("manual",),
                    daemon=True,
                ).start()
                self.send_json(
                    {"ok": True, "sync": sync_state_snapshot()},
                    status=HTTPStatus.ACCEPTED,
                )
                return
            if parsed.path == "/api/predict":
                payload = self.read_json()
                code = str(payload.get("lottery_code", ""))
                if code not in GAME_SPECS:
                    raise ValueError("未知彩种")
                weights_path = RESULTS_ROOT / "ga_weights.json"
                if not weights_path.exists():
                    self.send_json(
                        {"error": "请先运行一次模型训练"},
                        status=HTTPStatus.CONFLICT,
                    )
                    return
                if PUBLIC_MODE:
                    if payload.get("async") is not True:
                        self.send_json(
                            {"error": "公开试玩模式只允许异步预测"},
                            status=HTTPStatus.BAD_REQUEST,
                        )
                        return
                    issue = str(payload.get("issue", "")).strip()
                    if not issue.isdigit() or len(issue) > 12:
                        raise ValueError("期号必须是 1–12 位数字")
                    target_date = date.fromisoformat(str(payload.get("draw_date", "")))
                    public_draws = load_game_draws(code)
                    if issue in {draw.issue for draw in public_draws}:
                        raise ValueError(f"期号已存在: {issue}")
                    latest_date = public_draws[-1].draw_date
                    if target_date < latest_date:
                        raise ValueError("预测日期不能早于当前最新开奖日期")
                    china_today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
                    latest_allowed = china_today + timedelta(days=PUBLIC_MAX_FUTURE_DAYS)
                    if target_date > latest_allowed:
                        raise ValueError(
                            f"公开试玩最多预测未来 {PUBLIC_MAX_FUTURE_DAYS} 天"
                        )
                if payload.get("async") is True:
                    job_id = try_queue_prediction(payload)
                    if job_id is None:
                        self.send_json(
                            {"error": "已有预测实验正在运行"},
                            status=HTTPStatus.CONFLICT,
                        )
                        return
                    threading.Thread(
                        target=prediction_worker,
                        args=(job_id, payload),
                        daemon=True,
                    ).start()
                    self.send_json(
                        {"ok": True, "job": prediction_job_snapshot(job_id)},
                        status=HTTPStatus.ACCEPTED,
                    )
                    return
                result = predict_target(
                    data_path=DATA_PATHS[code],
                    spec=GAME_SPECS[code],
                    target_issue=str(payload.get("issue", "")).strip(),
                    target_date=date.fromisoformat(str(payload.get("draw_date", ""))),
                    swift_helper=LAB_ROOT / "scripts" / "chinese_calendar.swift",
                    ga_weights_path=weights_path,
                    manual_entries_path=MANUAL_ENTRIES,
                    synced_entries_path=SYNCED_ENTRIES,
                    lunar_calendar_path=LUNAR_CALENDAR_PATH,
                )
                self.send_json(result)
                return
            self.send_json(
                {"error": "未知 API"}, status=HTTPStatus.NOT_FOUND
            )
        except (ValueError, KeyError, PermissionError, json.JSONDecodeError) as error:
            self.send_json(
                {"error": str(error)}, status=HTTPStatus.BAD_REQUEST
            )
        except Exception as error:
            self.send_json(
                {"error": str(error)}, status=HTTPStatus.INTERNAL_SERVER_ERROR
            )

    def serve_static(self, request_path: str) -> None:
        relative = request_path.lstrip("/") or "index.html"
        parts = Path(relative).parts
        if ".." in parts:
            self.send_error(HTTPStatus.NOT_FOUND.value)
            return
        path = STATIC_ROOT.joinpath(*parts)
        if path.is_dir():
            path = path / "index.html"
        if not path.exists() or not path.is_file():
            path = STATIC_ROOT / "index.html"
        body = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK.value)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header(
            "Permissions-Policy",
            "camera=(), geolocation=(), microphone=()",
        )
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; "
            "base-uri 'none'; frame-ancestors 'none'",
        )
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description="启动 Lottery Lab 本地系统")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), AppHandler)
    url = f"http://{args.host}:{args.port}"
    print(f"Lottery Lab 已启动: {url}")
    if not PUBLIC_MODE and try_queue_sync("startup"):
        threading.Thread(
            target=sync_worker,
            args=("startup",),
            daemon=True,
        ).start()
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在停止服务……")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
