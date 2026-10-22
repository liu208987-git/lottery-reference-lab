"""Command-line report for quantitative lottery signal validation."""

from __future__ import annotations

import dlt_db
import ssq_db
from dlt_analyzer import Analyzer as DltAnalyzer
from quant_models import research_gate
from ssq_analyzer import Analyzer as SsqAnalyzer


def report(name, seq, pool, pick):
    result = research_gate(seq, pool, pick)
    print(f"\n{name}: selected={result['selected_model']}, "
          f"passed={result['gate_passed']}")
    print(result["reason"])
    print("model                         rel_brier   corrected_p  stable")
    for row in result["candidates"]:
        print(f"{row['model']:29s} {row['relative_improvement']:10.4%} "
              f"{row['corrected_p']:12.6f}  {row['stable_blocks']}/4")


def main():
    dlt = DltAnalyzer(dlt_db.get_all_draws())
    ssq = SsqAnalyzer(ssq_db.get_all_draws())
    report("大乐透前区", dlt.reds_seq, 35, 5)
    report("大乐透后区", dlt.blues_seq, 12, 2)
    report("双色球红球", ssq.reds_seq, 33, 6)
    report("双色球蓝球", ssq.blues_seq, 16, 1)


if __name__ == "__main__":
    main()
