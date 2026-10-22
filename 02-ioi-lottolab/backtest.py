"""Walk-forward audit for the legacy and current lottery algorithms."""

from __future__ import annotations

import argparse

import dlt_db
import ssq_db
from dlt_analyzer import Analyzer as DltAnalyzer
from ssq_analyzer import Analyzer as SsqAnalyzer


def _is_prize(game, red_hits, blue_hits):
    if game == "dlt":
        return (red_hits, blue_hits) in {
            (5, 2), (5, 1), (5, 0), (4, 2), (4, 1), (3, 2),
            (4, 0), (3, 1), (2, 2), (3, 0), (1, 2), (2, 1), (0, 2),
        }
    return (red_hits, blue_hits) in {
        (6, 1), (6, 0), (5, 1), (5, 0), (4, 1),
        (4, 0), (3, 1), (2, 1), (1, 1), (0, 1),
    }


def audit(game, rows, analyzer_cls, red_pick, blue_pick, red_pool, blue_pool,
          start=100):
    methods = {"legacy": "legacy_predict", "current": "predict"}
    stats = {name: {"red": 0, "blue": 0, "prize": 0, "portfolio": 0}
             for name in methods}
    count = 0
    for index in range(start, len(rows)):
        actual = rows[index]
        actual_red = {actual[f"r{i}"] for i in range(1, red_pick + 1)}
        actual_blue = {actual[f"b{i}"] for i in range(1, blue_pick + 1)}
        analyzer = analyzer_cls(rows[:index])
        for name, method_name in methods.items():
            if name == "current":
                # The quant candidates are already evaluated leakage-free by
                # quant_research.py.  Here we isolate the portfolio coverage
                # layer and avoid rerunning a nested model search every period.
                result = analyzer.predict(use_quant_gate=False)
            else:
                result = getattr(analyzer, method_name)()
            red_hits = len(set(result["reds"]) & actual_red)
            blue_hits = len(set(result["blues"]) & actual_blue)
            stats[name]["red"] += red_hits
            stats[name]["blue"] += blue_hits
            stats[name]["prize"] += _is_prize(game, red_hits, blue_hits)
            tickets = result.get("tickets", [(result["reds"], result["blues"])])
            stats[name]["portfolio"] += any(
                _is_prize(game, len(set(r) & actual_red),
                          len(set(b) & actual_blue))
                for r, b in tickets)
        count += 1

    print(f"{game.upper()} walk-forward periods: {count}")
    print(f"uniform expected single-ticket hits: red={red_pick**2/red_pool:.4f}, "
          f"blue={blue_pick**2/blue_pool:.4f}")
    for name, values in stats.items():
        print(f"{name:7s}: red={values['red']/count:.4f}, "
              f"blue={values['blue']/count:.4f}, single prizes={values['prize']}, "
              f"portfolio prize periods={values['portfolio']}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", type=int, default=100)
    args = parser.parse_args()
    audit("dlt", dlt_db.get_all_draws(), DltAnalyzer, 5, 2, 35, 12,
          args.start)
    audit("ssq", ssq_db.get_all_draws(), SsqAnalyzer, 6, 1, 33, 16,
          args.start)


if __name__ == "__main__":
    main()
