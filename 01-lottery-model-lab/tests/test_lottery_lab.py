from __future__ import annotations

import json
import math
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import numpy as np


LAB_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB_ROOT / "src"))
sys.path.insert(0, str(LAB_ROOT / "web"))

from lottery_lab import (  # noqa: E402
    Draw,
    GAME_SPECS,
    LunarDate,
    generate_base_predictions,
    evaluate_model,
    load_effective_draws,
    meihua_components,
    optimize_ga_weights,
    probabilities_from_scores,
    suggest_next_draw,
    xiaoliuren_components,
)
import server as web_server  # noqa: E402
from data_sync import GameSyncResult, SyncScan, TrustedTime  # noqa: E402


class LotteryLabTests(unittest.TestCase):
    def test_probability_projection_has_correct_sum(self) -> None:
        probabilities = probabilities_from_scores(
            np.asarray([0.2, 1.0, -0.4, 0.5, 2.0]), 2
        )
        self.assertAlmostEqual(float(probabilities.sum()), 2.0, places=8)
        self.assertTrue(np.all(probabilities > 0))
        self.assertTrue(np.all(probabilities < 1))

    def test_uniform_combination_nll_matches_fixed_size_sample_space(self) -> None:
        actual = np.zeros((4, 5), dtype=float)
        actual[0, [0, 1]] = 1.0
        actual[1, [1, 2]] = 1.0
        actual[2, [2, 3]] = 1.0
        actual[3, [3, 4]] = 1.0
        probabilities = np.full((4, 5), 0.4)
        metrics, _, _ = evaluate_model(
            "uniform_random",
            probabilities,
            probabilities,
            actual,
            pool_size=5,
            pick_count=2,
        )
        self.assertAlmostEqual(
            float(metrics["combination_nll"]),
            math.log(math.comb(5, 2)),
            places=10,
        )
        self.assertAlmostEqual(
            float(metrics["combination_nll_skill_vs_uniform"]),
            0.0,
            places=10,
        )

    def test_layered_entries_deduplicate_identical_rows_and_reject_conflicts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            base = root / "ssq.csv"
            base.write_text(
                "issue,draw_date,red_1,red_2,red_3,red_4,red_5,red_6,blue_1\n"
                "2026001,2026-01-01,1,2,3,4,5,6,1\n",
                encoding="utf-8-sig",
            )
            manual = root / "manual.csv"
            manual.write_text(
                "lottery_code,issue,draw_date,front_numbers,back_numbers,created_at_utc\n"
                "ssq,2026002,2026-01-04,07 08 09 10 11 12,02,now\n",
                encoding="utf-8-sig",
            )
            synced = root / "synced.csv"
            synced.write_text(
                "lottery_code,issue,draw_date,front_numbers,back_numbers,created_at_utc\n"
                "ssq,2026002,2026-01-04,07 08 09 10 11 12,02,now\n",
                encoding="utf-8-sig",
            )
            draws = load_effective_draws(
                base,
                GAME_SPECS["ssq"],
                manual,
                synced,
            )
            self.assertEqual([draw.issue for draw in draws], ["2026001", "2026002"])

            synced.write_text(
                "lottery_code,issue,draw_date,front_numbers,back_numbers,created_at_utc\n"
                "ssq,2026002,2026-01-04,07 08 09 10 11 13,02,now\n",
                encoding="utf-8-sig",
            )
            with self.assertRaisesRegex(ValueError, "存在冲突"):
                load_effective_draws(
                    base,
                    GAME_SPECS["ssq"],
                    manual,
                    synced,
                )

    def test_traditional_components_are_deterministic(self) -> None:
        lunar = LunarDate(43, 6, 8, False)
        self.assertEqual(meihua_components(lunar, 12), (5, 1, 3, 2))
        self.assertEqual(xiaoliuren_components(lunar, 12), (6, 1, 6))

    def test_future_draw_changes_do_not_leak_backward(self) -> None:
        spec = GAME_SPECS["ssq"]
        start = date(2020, 1, 1)
        draws_a = []
        draws_b = []
        lunar_dates = {}
        for index in range(30):
            draw_date = start + timedelta(days=index * 3)
            front = tuple(sorted({((index + step * 5) % 33) + 1 for step in range(6)}))
            if len(front) < 6:
                front = tuple(range(1, 7))
            alternate = tuple(sorted({((index + step * 7 + 9) % 33) + 1 for step in range(6)}))
            if len(alternate) < 6:
                alternate = tuple(range(8, 14))
            draws_a.append(Draw(str(2020001 + index), draw_date, front, ((index % 16) + 1,)))
            draws_b.append(
                Draw(
                    str(2020001 + index),
                    draw_date,
                    front if index <= 15 else alternate,
                    ((index % 16) + 1,),
                )
            )
            lunar_dates[draw_date] = LunarDate(37, (index % 12) + 1, (index % 28) + 1, False)

        _, predictions_a = generate_base_predictions(
            draws_a, spec, "front", lunar_dates
        )
        _, predictions_b = generate_base_predictions(
            draws_b, spec, "front", lunar_dates
        )
        for model_name in predictions_a:
            np.testing.assert_allclose(
                predictions_a[model_name]["scores"][15],
                predictions_b[model_name]["scores"][15],
            )

    def test_ga_returns_simplex_weights(self) -> None:
        rng = np.random.default_rng(7)
        actual = np.zeros((40, 10))
        for row in range(40):
            actual[row, rng.choice(10, size=2, replace=False)] = 1
        predictions = {}
        for name in ("model_a", "model_b", "model_c"):
            scores = rng.normal(size=(40, 10))
            probabilities = np.full((40, 10), 0.2)
            predictions[name] = {
                "scores": scores,
                "probabilities": probabilities,
            }
        names, weights, _ = optimize_ga_weights(
            predictions,
            actual,
            np.arange(10, 30),
            pick_count=2,
            seed=42,
            population_size=12,
            generations=5,
        )
        self.assertEqual(names, ["model_a", "model_b", "model_c"])
        self.assertAlmostEqual(float(weights.sum()), 1.0, places=8)
        self.assertTrue(np.all(weights >= 0))

    def test_next_draw_schedule(self) -> None:
        spec = GAME_SPECS["ssq"]
        draws = [
            Draw("2026082", date(2026, 7, 19), (5, 7, 10, 14, 21, 28), (4,))
        ]
        issue, next_date = suggest_next_draw(draws, spec)
        self.assertEqual(issue, "2026083")
        self.assertEqual(next_date, date(2026, 7, 21))

    def test_next_draw_issue_resets_at_calendar_year_boundary(self) -> None:
        ssq_issue, ssq_date = suggest_next_draw(
            [
                Draw(
                    "2025153",
                    date(2025, 12, 30),
                    (1, 2, 3, 4, 5, 6),
                    (1,),
                )
            ],
            GAME_SPECS["ssq"],
        )
        self.assertEqual((ssq_issue, ssq_date), ("2026001", date(2026, 1, 1)))

        dlt_issue, dlt_date = suggest_next_draw(
            [
                Draw(
                    "25150",
                    date(2025, 12, 31),
                    (1, 2, 3, 4, 5),
                    (1, 2),
                )
            ],
            GAME_SPECS["dlt"],
        )
        self.assertEqual((dlt_issue, dlt_date), ("26001", date(2026, 1, 3)))

    def test_training_queue_rejects_duplicate_requests(self) -> None:
        original = web_server.training_state_snapshot()
        try:
            with web_server.TRAIN_LOCK:
                web_server.TRAIN_STATE.update(
                    {
                        "status": "idle",
                        "started_at": None,
                        "finished_at": None,
                        "message": "test",
                        "output": "",
                    }
                )
            self.assertTrue(web_server.try_queue_training())
            self.assertFalse(web_server.try_queue_training())
        finally:
            with web_server.TRAIN_LOCK:
                web_server.TRAIN_STATE.clear()
                web_server.TRAIN_STATE.update(original)

    def test_sync_queue_rejects_duplicate_requests(self) -> None:
        original = web_server.sync_state_snapshot()
        try:
            with web_server.SYNC_LOCK:
                web_server.SYNC_STATE.update(
                    {
                        "status": "idle",
                        "started_at": None,
                        "finished_at": None,
                        "message": "test",
                        "trigger": None,
                        "trusted_time": None,
                        "games": {},
                        "candidate_count": 0,
                        "appended_count": 0,
                        "error": None,
                    }
                )
            self.assertTrue(web_server.try_queue_sync("test"))
            self.assertFalse(web_server.try_queue_sync("test"))
        finally:
            with web_server.SYNC_LOCK:
                web_server.SYNC_STATE.clear()
                web_server.SYNC_STATE.update(original)

    def test_sync_persistence_writes_independent_layer(self) -> None:
        trusted = TrustedTime(
            datetime(2026, 7, 21, 5, 0, tzinfo=timezone.utc),
            "network_date_header",
            ("https://clock.test/",),
        )
        ssq_draw = Draw(
            "2026083",
            date(2026, 7, 21),
            (2, 9, 14, 18, 25, 31),
            (12,),
        )
        scan = SyncScan(
            trusted_time=trusted,
            games={
                "ssq": GameSyncResult(
                    "ssq",
                    date(2026, 7, 19),
                    date(2026, 7, 21),
                    1,
                    2,
                    0,
                    1,
                    0,
                    (ssq_draw,),
                ),
                "dlt": GameSyncResult(
                    "dlt",
                    date(2026, 7, 20),
                    date(2026, 7, 21),
                    1,
                    1,
                    0,
                    1,
                    0,
                    (),
                ),
            },
        )
        with tempfile.TemporaryDirectory() as temporary_dir:
            synced_path = Path(temporary_dir) / "synced_entries.csv"
            with (
                mock.patch.object(web_server, "SYNCED_ENTRIES", synced_path),
                mock.patch.object(web_server, "load_game_draws", return_value=[]),
            ):
                appended = web_server.persist_synced_draws(scan)
                self.assertEqual(appended, {"ssq": 1, "dlt": 0})
                self.assertTrue(synced_path.exists())
                content = synced_path.read_text(encoding="utf-8-sig")
                self.assertIn("2026083", content)
                self.assertIn("02 09 14 18 25 31", content)

    def test_results_become_stale_when_training_code_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            results_root = root / "results"
            results_root.mkdir()
            data_paths = {
                "ssq": root / "ssq.csv",
                "dlt": root / "dlt.csv",
            }
            for path in data_paths.values():
                path.write_text("data\n", encoding="utf-8")
            code_path = root / "model.py"
            code_path.write_text("VERSION = 1\n", encoding="utf-8")
            manifest = {
                "data_files": {
                    code: {"sha256": web_server.sha256_file(path)}
                    for code, path in data_paths.items()
                },
                "code_files": {
                    "model.py": {"sha256": web_server.sha256_file(code_path)}
                },
                "manual_entries_file": None,
            }
            (results_root / "experiment_manifest.json").write_text(
                json.dumps(manifest),
                encoding="utf-8",
            )
            with (
                mock.patch.object(web_server, "RESULTS_ROOT", results_root),
                mock.patch.object(web_server, "DATA_PATHS", data_paths),
                mock.patch.object(
                    web_server,
                    "TRAINING_CODE_PATHS",
                    {"model.py": code_path},
                ),
                mock.patch.object(
                    web_server,
                    "MANUAL_ENTRIES",
                    root / "manual.csv",
                ),
            ):
                self.assertFalse(web_server.results_are_stale())
                code_path.write_text("VERSION = 2\n", encoding="utf-8")
                self.assertTrue(web_server.results_are_stale())

    def test_manual_draw_must_be_next_and_chronological(self) -> None:
        today = date.today()
        latest = Draw(
            "2026001",
            today - timedelta(days=2),
            (1, 2, 3, 4, 5, 6),
            (1,),
        )
        expected_issue, _ = suggest_next_draw([latest], GAME_SPECS["ssq"])
        payload = {
            "lottery_code": "ssq",
            "issue": expected_issue,
            "draw_date": today.isoformat(),
            "front": [7, 8, 9, 10, 11, 12],
            "back": [2],
        }

        with tempfile.TemporaryDirectory() as temporary_dir:
            manual_path = Path(temporary_dir) / "manual_entries.csv"
            with (
                mock.patch.object(web_server, "MANUAL_ENTRIES", manual_path),
                mock.patch.object(
                    web_server,
                    "load_effective_draws",
                    return_value=[latest],
                ),
            ):
                wrong_issue = dict(payload, issue=f"0{expected_issue}")
                with self.assertRaisesRegex(ValueError, "当前下一期"):
                    web_server.append_manual_draw(wrong_issue)

                old_date = dict(payload, draw_date=latest.draw_date.isoformat())
                with self.assertRaisesRegex(ValueError, "晚于当前最新记录"):
                    web_server.append_manual_draw(old_date)

                future_date = dict(
                    payload,
                    draw_date=(today + timedelta(days=1)).isoformat(),
                )
                with self.assertRaisesRegex(ValueError, "不能晚于今天"):
                    web_server.append_manual_draw(future_date)

                draw = web_server.append_manual_draw(payload)
                self.assertEqual(draw.issue, expected_issue)
                self.assertTrue(manual_path.exists())


if __name__ == "__main__":
    unittest.main()
