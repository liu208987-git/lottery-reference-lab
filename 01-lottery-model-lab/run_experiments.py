#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path


LAB_ROOT = Path(__file__).resolve().parent
MODEL_DATA_ROOT = LAB_ROOT / "model_data"
sys.path.insert(0, str(LAB_ROOT / "src"))

from lottery_lab import run_experiment  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(
        description="运行双色球/大乐透多模型时间留出回测"
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="减少遗传算法种群和代数，适合开发验证",
    )
    parser.add_argument(
        "--results-dir",
        type=Path,
        default=LAB_ROOT / "results",
    )
    parser.add_argument(
        "--lunar-calendar",
        type=Path,
        default=MODEL_DATA_ROOT / "lunar_calendar.csv",
        help="固定中国农历缓存；缺失或日期不完整时拒绝运行",
    )
    parser.add_argument(
        "--audit-permutations",
        type=int,
        help="whole-draw、max-T、顺序统计量和变化点的代理次数",
    )
    parser.add_argument(
        "--pipeline-null-repetitions",
        type=int,
        help="完整公平历史中重新运行模型选择管线的次数；0 表示跳过",
    )
    parser.add_argument(
        "--p1-bootstrap-repetitions",
        type=int,
        help="moving-block bootstrap 的重复次数",
    )
    parser.add_argument("--pipeline-null-workers", type=int, default=1)
    parser.add_argument(
        "--pipeline-null-backend",
        choices=("sequential", "thread", "process"),
        default="sequential",
    )
    parser.add_argument(
        "--ssq-model-start-date",
        default="none",
        help="双色球模型起始日期 YYYY-MM-DD；none 表示保留全历史",
    )
    parser.add_argument(
        "--dlt-model-start-date",
        default="2014-01-01",
        help="大乐透模型起始日期 YYYY-MM-DD；早期数据仍参与审计",
    )
    parser.add_argument(
        "--confirm-p0",
        action="store_true",
        help="使用 9999 次统计代理和 999 次完整管线公平模拟",
    )
    args = parser.parse_args()

    ga_population = 24 if args.quick else 48
    ga_generations = 15 if args.quick else 50
    if args.confirm_p0:
        audit_permutations = args.audit_permutations or 9_999
        era_permutations = 999
        pipeline_null_repetitions = (
            999
            if args.pipeline_null_repetitions is None
            else args.pipeline_null_repetitions
        )
    elif args.quick:
        audit_permutations = args.audit_permutations or 99
        era_permutations = 49
        pipeline_null_repetitions = (
            19
            if args.pipeline_null_repetitions is None
            else args.pipeline_null_repetitions
        )
    else:
        audit_permutations = args.audit_permutations or 999
        era_permutations = 199
        pipeline_null_repetitions = (
            99
            if args.pipeline_null_repetitions is None
            else args.pipeline_null_repetitions
        )
    p1_bootstrap_repetitions = (
        args.p1_bootstrap_repetitions
        if args.p1_bootstrap_repetitions is not None
        else (499 if args.quick else 1999)
    )

    def parse_start_date(value: str) -> date | None:
        return None if value.lower() == "none" else date.fromisoformat(value)

    pipeline_backend = args.pipeline_null_backend
    if args.pipeline_null_workers > 1 and pipeline_backend == "sequential":
        pipeline_backend = "process"
    manifest = run_experiment(
        data_paths={
            "ssq": MODEL_DATA_ROOT / "ssq_history.csv",
            "dlt": MODEL_DATA_ROOT / "dlt_history.csv",
        },
        output_dir=args.results_dir,
        swift_helper=LAB_ROOT / "scripts" / "chinese_calendar.swift",
        manual_entries_path=LAB_ROOT / "data" / "manual_entries.csv",
        synced_entries_path=LAB_ROOT / "data" / "synced_entries.csv",
        lunar_calendar_path=args.lunar_calendar,
        ga_population=ga_population,
        ga_generations=ga_generations,
        model_start_dates={
            "ssq": parse_start_date(args.ssq_model_start_date),
            "dlt": parse_start_date(args.dlt_model_start_date),
        },
        audit_permutations=audit_permutations,
        audit_batch_size=8 if args.quick else 16,
        era_permutations=era_permutations,
        pipeline_null_repetitions=pipeline_null_repetitions,
        pipeline_null_workers=args.pipeline_null_workers,
        pipeline_null_backend=pipeline_backend,
        p1_bootstrap_repetitions=p1_bootstrap_repetitions,
    )
    print("实验完成")
    print(f"日历来源: {manifest['calendar_source']}")
    for code, split in manifest["splits"].items():
        print(
            f"{code}: 原始 {split['raw_draw_count']} 期，模型使用 "
            f"{split['model_draw_count']} 期，留出集 "
            f"{split['test_start_date']} 至 {split['test_end_date']} "
            f"({split['test_draw_count']} 期)"
        )
    print(
        "P0: "
        f"{audit_permutations} 次统计代理，"
        f"{pipeline_null_repetitions} 次完整管线公平模拟"
    )
    print(
        "P1: 嵌套滚动调参、条件 Bernoulli 组合 NLL、"
        f"{p1_bootstrap_repetitions} 次 moving-block bootstrap"
    )
    print(f"结果目录: {args.results_dir.resolve()}")


if __name__ == "__main__":
    main()
