"""Application paths shared by source and packaged desktop builds."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _default_data_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


DATA_ROOT = Path(os.environ.get("LOTTO_DATA_DIR", _default_data_root())).resolve()
DATA_ROOT.mkdir(parents=True, exist_ok=True)

