from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
import uuid
from datetime import date, timedelta
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest import mock


LAB_ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = LAB_ROOT / "web" / "server.py"
sys.path.insert(0, str(LAB_ROOT / "scripts"))

import check_public_bundle  # noqa: E402


def load_public_server(runtime_root: Path):
    module_name = f"lottery_public_server_test_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(module_name, SERVER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载公共模式服务端模块")
    module = importlib.util.module_from_spec(spec)
    environment = {
        "LOTTERY_APP_MODE": "public",
        "LOTTERY_PUBLIC_MODE": "1",
        "LOTTERY_RUNTIME_ROOT": str(runtime_root),
        "LOTTERY_RESULTS_ROOT": str(runtime_root / "results"),
        "LOTTERY_ALLOWED_ORIGINS": "",
    }
    with mock.patch.dict(os.environ, environment, clear=False):
        sys.modules[module_name] = module
        try:
            spec.loader.exec_module(module)
        finally:
            sys.modules.pop(module_name, None)
    return module


class PublicModeHttpContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary_directory = tempfile.TemporaryDirectory()
        cls.runtime_root = Path(cls.temporary_directory.name)
        (cls.runtime_root / "results").mkdir(parents=True)
        cls.required_files = [
            cls.runtime_root / "ssq_history.csv",
            cls.runtime_root / "dlt_history.csv",
            cls.runtime_root / "results" / "experiment_manifest.json",
            cls.runtime_root / "results" / "ga_weights.json",
            cls.runtime_root / "results" / "model_metrics.csv",
            cls.runtime_root / "lunar_calendar.csv",
        ]
        for path in cls.required_files:
            path.write_text("\n", encoding="utf-8")
        (cls.runtime_root / "results" / "experiment_manifest.json").write_text(
            "{}\n",
            encoding="utf-8",
        )

        cls.web_server = load_public_server(cls.runtime_root)

        class QuietHandler(cls.web_server.AppHandler):
            def log_message(self, format_string: str, *args: object) -> None:
                return

        cls.http_server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.server_thread = threading.Thread(
            target=cls.http_server.serve_forever,
            daemon=True,
        )
        cls.server_thread.start()
        host, port = cls.http_server.server_address
        cls.base_url = f"http://{host}:{port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.http_server.shutdown()
        cls.http_server.server_close()
        cls.server_thread.join(timeout=2)
        cls.temporary_directory.cleanup()

    def setUp(self) -> None:
        for path in self.required_files:
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("\n", encoding="utf-8")
        with self.web_server.PREDICTION_LOCK:
            self.web_server.PREDICTION_JOBS.clear()
        with self.web_server.TRAIN_LOCK:
            self.web_server.TRAIN_STATE.update(
                {
                    "status": "disabled",
                    "started_at": None,
                    "finished_at": None,
                    "message": "公开试玩模式不开放训练",
                    "output": "",
                }
            )
        with self.web_server.SYNC_LOCK:
            self.web_server.SYNC_STATE.update(
                {
                    "status": "disabled",
                    "started_at": None,
                    "finished_at": None,
                    "message": "公开试玩模式使用只读快照",
                    "trigger": None,
                    "trusted_time": None,
                    "games": {},
                    "candidate_count": 0,
                    "appended_count": 0,
                    "error": None,
                }
            )

    def request_json(
        self,
        path: str,
        *,
        method: str = "GET",
        payload: dict[str, object] | None = None,
        origin: str | None = None,
    ) -> tuple[int, object]:
        body = None
        headers: dict[str, str] = {}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if origin is not None:
            headers["Origin"] = origin
        request = Request(
            f"{self.base_url}{path}",
            data=body,
            headers=headers,
            method=method,
        )
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    def sample_draws(self, code: str):
        spec = self.web_server.GAME_SPECS[code]
        issue = "2026001" if code == "ssq" else "26001"
        return [
            self.web_server.Draw(
                issue=issue,
                draw_date=date.today() - timedelta(days=2),
                front=tuple(range(1, spec.front_pick + 1)),
                back=tuple(range(1, spec.back_pick + 1)),
            )
        ]

    def valid_prediction_payload(self) -> dict[str, object]:
        return {
            "lottery_code": "ssq",
            "issue": "2026999",
            "draw_date": (date.today() + timedelta(days=1)).isoformat(),
            "async": True,
        }

    def test_public_status_exposes_read_only_capabilities(self) -> None:
        with (
            mock.patch.object(
                self.web_server,
                "load_game_draws",
                side_effect=self.sample_draws,
            ),
            mock.patch.object(self.web_server, "results_are_stale", return_value=False),
            mock.patch.object(self.web_server, "best_models", return_value=[]),
        ):
            status, payload = self.request_json("/api/status")

        self.assertEqual(status, 200)
        self.assertIsInstance(payload, dict)
        assert isinstance(payload, dict)
        self.assertEqual(payload["app_mode"], "public")
        self.assertEqual(
            payload["capabilities"],
            {
                "can_predict": True,
                "can_train": False,
                "can_sync": False,
                "can_write_draws": False,
            },
        )
        self.assertEqual(payload["training"]["status"], "disabled")
        self.assertEqual(payload["sync"]["status"], "disabled")
        self.assertIsNone(self.web_server.MANUAL_ENTRIES)
        self.assertIsNone(self.web_server.SYNCED_ENTRIES)

    def test_public_mode_rejects_all_management_posts_with_403(self) -> None:
        with (
            mock.patch.object(self.web_server, "append_manual_draw") as append_draw,
            mock.patch.object(self.web_server, "try_queue_training") as queue_training,
            mock.patch.object(self.web_server, "try_queue_sync") as queue_sync,
        ):
            for path in ("/api/draws", "/api/train", "/api/sync"):
                with self.subTest(path=path):
                    status, payload = self.request_json(
                        path,
                        method="POST",
                        payload={},
                        origin=self.base_url,
                    )
                    self.assertEqual(status, 403)
                    self.assertIn("仅允许预测", payload["error"])

        append_draw.assert_not_called()
        queue_training.assert_not_called()
        queue_sync.assert_not_called()

    def test_public_mode_rejects_synchronous_prediction(self) -> None:
        payload = self.valid_prediction_payload()
        payload["async"] = False
        with mock.patch.object(self.web_server, "predict_target") as predict_target:
            status, response = self.request_json(
                "/api/predict",
                method="POST",
                payload=payload,
                origin=self.base_url,
            )

        self.assertEqual(status, 400)
        self.assertIn("只允许异步预测", response["error"])
        predict_target.assert_not_called()

    def test_prediction_accepts_same_origin_and_rejects_foreign_origin(self) -> None:
        job_snapshot = {
            "job_id": "same-origin-job",
            "status": "queued",
            "progress": 0,
        }
        worker_started = threading.Event()

        def fake_worker(*args: object) -> None:
            worker_started.set()

        with (
            mock.patch.object(
                self.web_server,
                "load_game_draws",
                side_effect=self.sample_draws,
            ),
            mock.patch.object(
                self.web_server,
                "try_queue_prediction",
                return_value="same-origin-job",
            ) as queue_prediction,
            mock.patch.object(
                self.web_server,
                "prediction_job_snapshot",
                return_value=job_snapshot,
            ),
            mock.patch.object(
                self.web_server,
                "prediction_worker",
                side_effect=fake_worker,
            ),
        ):
            accepted_status, accepted = self.request_json(
                "/api/predict",
                method="POST",
                payload=self.valid_prediction_payload(),
                origin=self.base_url,
            )
            rejected_status, rejected = self.request_json(
                "/api/predict",
                method="POST",
                payload=self.valid_prediction_payload(),
                origin="https://foreign.example",
            )

        self.assertEqual(accepted_status, 202)
        self.assertEqual(accepted["job"], job_snapshot)
        self.assertTrue(worker_started.wait(timeout=1))
        self.assertEqual(rejected_status, 400)
        self.assertIn("非同源", rejected["error"])
        queue_prediction.assert_called_once()

    def test_async_prediction_entry_queues_job_without_private_data_paths(self) -> None:
        with (
            mock.patch.object(
                self.web_server,
                "load_game_draws",
                side_effect=self.sample_draws,
            ),
            mock.patch.object(self.web_server, "prediction_worker", return_value=None),
        ):
            status, payload = self.request_json(
                "/api/predict",
                method="POST",
                payload=self.valid_prediction_payload(),
                origin=self.base_url,
            )

        self.assertEqual(status, 202)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["job"]["status"], "queued")
        request_payload = payload["job"]["request"]
        self.assertEqual(request_payload["lottery_code"], "ssq")
        self.assertNotIn("manual_entries", json.dumps(payload))
        self.assertNotIn("synced_entries", json.dumps(payload))

    def test_health_and_ready_endpoints(self) -> None:
        health_status, health = self.request_json("/healthz")
        self.assertEqual(health_status, 200)
        self.assertEqual(health, {"ok": True, "mode": "public"})

        with mock.patch.object(self.web_server, "results_are_stale", return_value=False):
            ready_status, ready = self.request_json("/readyz")
        self.assertEqual(ready_status, 200)
        self.assertEqual(ready["ok"], True)
        self.assertEqual(ready["missing"], [])
        self.assertEqual(ready["mode"], "public")

    def test_ready_failure_does_not_disclose_absolute_runtime_paths(self) -> None:
        missing = self.runtime_root / "data" / "missing-dlt.csv"
        data_paths = dict(self.web_server.DATA_PATHS)
        data_paths["dlt"] = missing
        with (
            mock.patch.object(self.web_server, "DATA_PATHS", data_paths),
            mock.patch.object(self.web_server, "results_are_stale", return_value=False),
        ):
            status, payload = self.request_json("/readyz")

        self.assertEqual(status, 503)
        self.assertEqual(payload["ok"], False)
        self.assertTrue(payload["missing"])
        for item in payload["missing"]:
            self.assertFalse(
                Path(str(item)).is_absolute(),
                f"readyz 泄露绝对路径: {item}",
            )

    def test_public_main_does_not_start_sync_worker(self) -> None:
        class FakeHttpServer:
            def __init__(self) -> None:
                self.closed = False
                self.serve_calls = 0

            def serve_forever(self) -> None:
                self.serve_calls += 1

            def server_close(self) -> None:
                self.closed = True

        fake_server = FakeHttpServer()
        arguments = SimpleNamespace(host="127.0.0.1", port=8765, open=False)
        with (
            mock.patch.object(
                self.web_server.argparse.ArgumentParser,
                "parse_args",
                return_value=arguments,
            ),
            mock.patch.object(
                self.web_server,
                "ThreadingHTTPServer",
                return_value=fake_server,
            ),
            mock.patch.object(self.web_server, "try_queue_sync") as queue_sync,
            mock.patch("builtins.print"),
        ):
            self.web_server.main()

        queue_sync.assert_not_called()
        self.assertEqual(fake_server.serve_calls, 1)
        self.assertTrue(fake_server.closed)


class PublicBundleLeakAuditTests(unittest.TestCase):
    def test_scanner_detects_private_csv_local_path_and_sensitive_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / "data").mkdir()
            (root / "data" / "manual_entries.csv").write_text(
                "issue,draw_date\n",
                encoding="utf-8",
            )
            local_prefix = "/" + "Users" + "/someone/private/"
            (root / "manifest.json").write_text(
                json.dumps({"path": local_prefix + "model.csv"}),
                encoding="utf-8",
            )
            (root / ".env").write_text(
                "DEPLOY_TOKEN=not-a-placeholder-value\n",
                encoding="utf-8",
            )

            findings = check_public_bundle.scan_public_bundle(root)

        kinds = {finding.kind for finding in findings}
        self.assertIn("private_runtime_csv", kinds)
        self.assertIn("local_absolute_path", kinds)
        self.assertIn("sensitive_filename", kinds)
        self.assertIn("embedded_secret", kinds)

    def test_scanner_accepts_public_model_snapshot_and_env_example(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / "model_data").mkdir()
            (root / "model_data" / "ssq_history.csv").write_text(
                "issue,draw_date\n2026001,2026-01-01\n",
                encoding="utf-8",
            )
            (root / "results").mkdir()
            (root / "results" / "ga_weights.json").write_text(
                json.dumps({"weights": [0.5, 0.5]}),
                encoding="utf-8",
            )
            (root / ".env.example").write_text(
                "DEPLOY_TOKEN=${DEPLOY_TOKEN}\n",
                encoding="utf-8",
            )

            findings = check_public_bundle.scan_public_bundle(root)

        self.assertEqual(findings, [])

    def test_current_public_repository_has_no_private_bundle_leaks(self) -> None:
        findings = check_public_bundle.scan_public_bundle(LAB_ROOT)
        self.assertEqual(
            findings,
            [],
            "\n".join(finding.format(LAB_ROOT) for finding in findings),
        )


if __name__ == "__main__":
    unittest.main()
