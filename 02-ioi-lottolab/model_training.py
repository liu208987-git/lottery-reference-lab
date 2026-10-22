"""Persist the self-learning gate report after each data synchronization."""

from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path

from quant_models import research_gate


ROOT = Path(__file__).resolve().parent


def train_and_save(game, rows):
    if game == "dlt":
        from dlt_analyzer import Analyzer
        red_pool, red_pick, blue_pool, blue_pick = 35, 5, 12, 2
    elif game == "ssq":
        from ssq_analyzer import Analyzer
        red_pool, red_pick, blue_pool, blue_pick = 33, 6, 16, 1
    else:
        raise ValueError(f"未知彩票类型: {game}")

    analyzer = Analyzer(rows)
    state = {
        "game": game,
        "trained_at": datetime.now().isoformat(timespec="seconds"),
        "trained_through": rows[-1]["issue"] if rows else None,
        "sample_size": len(rows),
        "red": research_gate(analyzer.reds_seq, red_pool, red_pick),
        "blue": research_gate(analyzer.blues_seq, blue_pool, blue_pick),
    }
    target = ROOT / f"{game}_model_state.json"
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2),
                         encoding="utf-8")
    temporary.replace(target)
    return state
