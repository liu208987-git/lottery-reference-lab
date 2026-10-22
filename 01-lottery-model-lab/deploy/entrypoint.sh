#!/bin/sh
set -eu

fatal() {
    printf 'lottery-entrypoint: %s\n' "$*" >&2
    exit 1
}

[ "$(id -u)" -ne 0 ] || fatal "refusing to run the public service as root"
[ "${LOTTERY_APP_MODE:-public}" = "public" ] \
    || fatal "this image only supports LOTTERY_APP_MODE=public"

runtime_root=${LOTTERY_RUNTIME_ROOT:-/app/model_data}
results_root=${LOTTERY_RESULTS_ROOT:-/app/results}
lunar_path=${LOTTERY_LUNAR_CALENDAR_PATH:-$runtime_root/lunar_calendar.csv}

for required_file in \
    "$runtime_root/ssq_history.csv" \
    "$runtime_root/dlt_history.csv" \
    "$lunar_path" \
    "$results_root/experiment_manifest.json" \
    "$results_root/ga_weights.json" \
    "$results_root/model_metrics.csv"
do
    [ -s "$required_file" ] || fatal "required public model file is missing or empty: $required_file"
done

for private_file in \
    /app/data/manual_entries.csv \
    /app/data/synced_entries.csv \
    "$runtime_root/manual_entries.csv" \
    "$runtime_root/synced_entries.csv"
do
    [ ! -e "$private_file" ] || fatal "private runtime data was included in the public image: $private_file"
done

python - "$runtime_root" "$results_root" <<'PY'
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path


runtime_root = Path(sys.argv[1])
results_root = Path(sys.argv[2])
manifest_path = results_root / "experiment_manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

if manifest.get("manual_entries_file") is not None:
    raise SystemExit("public manifest unexpectedly references manual_entries.csv")
if manifest.get("synced_entries_file") is not None:
    raise SystemExit("public manifest unexpectedly references synced_entries.csv")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


for code, filename in (("ssq", "ssq_history.csv"), ("dlt", "dlt_history.csv")):
    expected = manifest.get("data_files", {}).get(code, {}).get("sha256")
    if not expected:
        raise SystemExit(f"manifest is missing the {code} public data hash")
    actual = sha256(runtime_root / filename)
    if actual != expected:
        raise SystemExit(f"public {code} history hash does not match the model manifest")

calendar_metadata = manifest.get("calendar_file")
expected_calendar_hash = (
    calendar_metadata.get("sha256")
    if isinstance(calendar_metadata, dict)
    else None
)
calendar_path = Path(
    os.environ.get(
        "LOTTERY_LUNAR_CALENDAR_PATH",
        str(runtime_root / "lunar_calendar.csv"),
    )
)
if not expected_calendar_hash:
    raise SystemExit("manifest is missing the frozen lunar-calendar hash")
if sha256(calendar_path) != expected_calendar_hash:
    raise SystemExit("frozen lunar-calendar hash does not match the model manifest")

for filename, metadata in manifest.get("result_files", {}).items():
    path = results_root / filename
    expected = metadata.get("sha256") if isinstance(metadata, dict) else None
    if not expected or not path.is_file() or sha256(path) != expected:
        raise SystemExit(f"public result file failed manifest verification: {filename}")
PY

export PYTHONPATH="/app/src${PYTHONPATH:+:$PYTHONPATH}"
python -c 'import numpy; from lottery_lab import GAME_SPECS; assert set(GAME_SPECS) == {"ssq", "dlt"}'

exec "$@"
