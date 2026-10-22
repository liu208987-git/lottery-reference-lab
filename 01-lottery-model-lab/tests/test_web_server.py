from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from datetime import date, timedelta
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from unittest import mock

import numpy as np


LAB_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB_ROOT / "src"))
sys.path.insert(0, str(LAB_ROOT / "web"))

import lottery_lab  # noqa: E402
import server as web_server  # noqa: E402


class QuietAppHandler(web_server.AppHandler):
    def log_message(self, format_string: str, *args: object) -> None:
        return


class PredictionApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietAppHandler)
        cls.server_thread = threading.Thread(
            target=cls.server.serve_forever,
            daemon=True,
        )
        cls.server_thread.start()
        host, port = cls.server.server_address
        cls.base_url = f"http://{host}:{port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join(timeout=2)

    def setUp(self) -> None:
        with web_server.PREDICTION_LOCK:
            self.original_jobs = dict(web_server.PREDICTION_JOBS)
            web_server.PREDICTION_JOBS.clear()

    def tearDown(self) -> None:
        with web_server.PREDICTION_LOCK:
            web_server.PREDICTION_JOBS.clear()
            web_server.PREDICTION_JOBS.update(self.original_jobs)

    def request_json(
        self,
        path: str,
        *,
        method: str = "GET",
        payload: dict[str, object] | None = None,
    ) -> tuple[int, dict[str, object]]:
        body = None
        headers: dict[str, str] = {}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(
            f"{self.base_url}{path}",
            data=body,
            headers=headers,
            method=method,
        )
        with urlopen(request, timeout=3) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def test_async_predict_api_reports_progress_then_completed_result(self) -> None:
        prediction_started = threading.Event()
        allow_completion = threading.Event()
        expected_result = {
            "lottery_code": "ssq",
            "issue": "2026083",
            "zones": {"front": {"models": {}}, "back": {"models": {}}},
        }

        def fake_predict_target(**kwargs: object) -> dict[str, object]:
            callback = kwargs["progress_callback"]
            assert callable(callback)
            callback(
                {
                    "progress": 38,
                    "stage": "front_models",
                    "title": "红球：基础模型与随机基线并行更新",
                    "detail": "正在更新贝叶斯频率、共现网络与传统规则。",
                    "zone": "front",
                    "models": ["bayesian_all", "cooccurrence_network"],
                }
            )
            prediction_started.set()
            if not allow_completion.wait(timeout=3):
                raise TimeoutError("测试未释放预测任务")
            callback(
                {
                    "progress": 94,
                    "stage": "back_ranking",
                    "title": "蓝球：生成固定大小号码组合",
                    "detail": "正在冻结最终排序。",
                    "zone": "back",
                    "models": ["ga_ensemble"],
                }
            )
            return expected_result

        with tempfile.TemporaryDirectory() as temporary_dir:
            results_root = Path(temporary_dir)
            (results_root / "ga_weights.json").write_text("{}", encoding="utf-8")
            with (
                mock.patch.object(web_server, "RESULTS_ROOT", results_root),
                mock.patch.object(
                    web_server,
                    "predict_target",
                    side_effect=fake_predict_target,
                ),
            ):
                status, queued = self.request_json(
                    "/api/predict",
                    method="POST",
                    payload={
                        "lottery_code": "ssq",
                        "issue": "2026083",
                        "draw_date": "2026-07-21",
                        "async": True,
                    },
                )
                self.assertEqual(status, 202)
                self.assertTrue(queued["ok"])
                job_id = str(queued["job"]["job_id"])
                self.assertTrue(job_id)

                self.assertTrue(prediction_started.wait(timeout=2))
                status, running = self.request_json(
                    f"/api/predict-status?job_id={job_id}"
                )
                self.assertEqual(status, 200)
                self.assertEqual(running["job_id"], job_id)
                self.assertEqual(running["status"], "running")
                self.assertEqual(running["progress"], 38)
                self.assertEqual(running["stage"], "front_models")
                self.assertEqual(running["zone"], "front")
                self.assertEqual(
                    running["models"],
                    ["bayesian_all", "cooccurrence_network"],
                )
                self.assertIn("贝叶斯", running["detail"])

                allow_completion.set()
                deadline = time.monotonic() + 2
                while True:
                    _, completed = self.request_json(
                        f"/api/predict-status?job_id={job_id}"
                    )
                    if completed["status"] == "completed":
                        break
                    if time.monotonic() >= deadline:
                        self.fail(f"异步预测未完成，最后状态: {completed}")
                    time.sleep(0.01)

                self.assertEqual(completed["progress"], 100)
                self.assertEqual(completed["stage"], "completed")
                self.assertEqual(completed["result"], expected_result)
                self.assertIsNone(completed["error"])
                self.assertIsNotNone(completed["finished_at"])


class PredictionProgressTests(unittest.TestCase):
    def test_predict_target_emits_all_pipeline_stage_events(self) -> None:
        spec = lottery_lab.GAME_SPECS["ssq"]
        latest_date = date(2026, 7, 19)
        draws = [
            lottery_lab.Draw(
                "2026081",
                latest_date - timedelta(days=3),
                (1, 2, 3, 4, 5, 6),
                (1,),
            ),
            lottery_lab.Draw(
                "2026082",
                latest_date,
                (5, 7, 10, 14, 21, 28),
                (4,),
            ),
        ]
        events: list[dict[str, object]] = []

        def fake_generate(
            extended: list[lottery_lab.Draw],
            game_spec: lottery_lab.GameSpec,
            zone: str,
            lunar_dates: dict[date, lottery_lab.LunarDate],
            **kwargs: object,
        ) -> tuple[np.ndarray, dict[str, dict[str, np.ndarray]]]:
            del lunar_dates, kwargs
            pool_size = (
                game_spec.front_pool if zone == "front" else game_spec.back_pool
            )
            pick_count = (
                game_spec.front_pick if zone == "front" else game_spec.back_pick
            )
            row_count = len(extended)
            scores = np.tile(np.arange(pool_size, dtype=float), (row_count, 1))
            probabilities = np.full(
                (row_count, pool_size),
                pick_count / pool_size,
                dtype=float,
            )
            return (
                np.zeros((row_count, pool_size), dtype=float),
                {
                    "uniform_random": {
                        "scores": scores,
                        "probabilities": probabilities,
                    }
                },
            )

        weights_payload = {
            "_meta": {"model_start_dates": {"ssq": None}},
            "ssq_front": {"weights": {"uniform_random": 1.0}},
            "ssq_back": {"weights": {"uniform_random": 1.0}},
        }
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            weights_path = root / "ga_weights.json"
            weights_path.write_text(
                json.dumps(weights_payload),
                encoding="utf-8",
            )
            with (
                mock.patch.object(
                    lottery_lab,
                    "load_effective_draws",
                    return_value=draws,
                ),
                mock.patch.object(
                    lottery_lab,
                    "load_lunar_dates",
                    return_value=({}, "test_calendar"),
                ),
                mock.patch.object(
                    lottery_lab,
                    "filter_draws_for_model",
                    return_value=draws,
                ),
                mock.patch.object(
                    lottery_lab,
                    "generate_base_predictions",
                    side_effect=fake_generate,
                ),
            ):
                result = lottery_lab.predict_target(
                    data_path=root / "ssq.csv",
                    spec=spec,
                    target_issue="2026083",
                    target_date=date(2026, 7, 21),
                    swift_helper=root / "calendar.swift",
                    ga_weights_path=weights_path,
                    progress_callback=events.append,
                )

        self.assertEqual(result["issue"], "2026083")
        self.assertEqual(
            [event["stage"] for event in events],
            [
                "history",
                "model_window",
                "calendar",
                "calendar_ready",
                "front_models",
                "front_ensemble",
                "front_ranking",
                "back_models",
                "back_ensemble",
                "back_ranking",
                "finalize",
            ],
        )
        self.assertEqual(
            [event["progress"] for event in events],
            [2, 9, 15, 34, 38, 58, 64, 68, 88, 94, 98],
        )
        front_event = next(
            event for event in events if event["stage"] == "front_models"
        )
        self.assertEqual(front_event["zone"], "front")
        self.assertIn("bayesian_all", front_event["models"])
        self.assertIn("meihua_yishu", front_event["models"])
        self.assertIn("更新", front_event["detail"])
        ensemble_event = next(
            event for event in events if event["stage"] == "back_ensemble"
        )
        self.assertEqual(ensemble_event["models"], ["ga_ensemble"])
        finalize_event = next(
            event for event in events if event["stage"] == "finalize"
        )
        self.assertEqual(finalize_event["models"], [])


class TrainingDataLockTests(unittest.TestCase):
    def test_training_worker_rejects_manual_and_synced_writes_while_frozen(self) -> None:
        subprocess_started = threading.Event()
        allow_subprocess_return = threading.Event()
        original_training_state = web_server.training_state_snapshot()

        def fake_run(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            subprocess_started.set()
            if not allow_subprocess_return.wait(timeout=3):
                raise TimeoutError("测试未释放训练进程")
            return subprocess.CompletedProcess(args[0], 0, "ok", "")

        worker = threading.Thread(target=web_server.training_worker, daemon=True)
        try:
            with mock.patch.object(web_server.subprocess, "run", side_effect=fake_run):
                worker.start()
                self.assertTrue(subprocess_started.wait(timeout=2))
                payload = {
                    "lottery_code": "ssq",
                    "issue": "2026083",
                    "draw_date": date.today().isoformat(),
                    "front": [2, 9, 14, 18, 25, 31],
                    "back": [12],
                }
                with self.assertRaisesRegex(ValueError, "训练完成后再录入"):
                    web_server.append_manual_draw(payload)
                with self.assertRaisesRegex(ValueError, "训练完成后重新扫描"):
                    web_server.persist_synced_draws(mock.sentinel.scan)
        finally:
            allow_subprocess_return.set()
            worker.join(timeout=2)
            with web_server.TRAIN_LOCK:
                web_server.TRAIN_STATE.clear()
                web_server.TRAIN_STATE.update(original_training_state)

        self.assertFalse(worker.is_alive())


if __name__ == "__main__":
    unittest.main()
