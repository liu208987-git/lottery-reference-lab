# syntax=docker/dockerfile:1.7

ARG PYTHON_IMAGE=python:3.12.13-slim-bookworm@sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b

FROM ${PYTHON_IMAGE} AS wheels

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /build

COPY requirements-runtime.txt ./requirements-runtime.txt
RUN python -m pip wheel \
    --wheel-dir /wheels \
    --requirement requirements-runtime.txt


FROM ${PYTHON_IMAGE} AS runtime

ARG BUILD_DATE=unknown
ARG VCS_REF=unknown
ARG VERSION=dev
ARG COMPOSE_SHA256=unknown
ARG SOURCE_REPOSITORY=https://github.com/Coco422/lottery-model-lab

LABEL org.opencontainers.image.title="Lottery Model Lab" \
      org.opencontainers.image.description="Public, read-only lottery probability model playground" \
      org.opencontainers.image.source="${SOURCE_REPOSITORY}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="NOASSERTION" \
      io.lottery-lab.compose-sha256="${COMPOSE_SHA256}"

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=0 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    LOTTERY_APP_MODE=public \
    LOTTERY_RUNTIME_ROOT=/app/model_data \
    LOTTERY_RESULTS_ROOT=/app/results \
    LOTTERY_LUNAR_CALENDAR_PATH=/app/model_data/lunar_calendar.csv

RUN groupadd --gid 10001 lottery \
    && useradd \
        --uid 10001 \
        --gid 10001 \
        --no-create-home \
        --home-dir /nonexistent \
        --shell /usr/sbin/nologin \
        lottery

COPY --from=wheels /wheels /wheels
COPY requirements-runtime.txt /tmp/requirements-runtime.txt
RUN python -m pip install \
        --no-cache-dir \
        --no-index \
        --find-links /wheels \
        --requirement /tmp/requirements-runtime.txt \
    && rm -rf /wheels /tmp/requirements-runtime.txt

WORKDIR /app

# Runtime code allowlist. Tests, private data, local environments and reports are
# intentionally absent from the production image.
COPY --chown=10001:10001 run_experiments.py ./run_experiments.py
COPY --chown=10001:10001 src/ ./src/
COPY --chown=10001:10001 web/ ./web/
COPY --chown=10001:10001 scripts/chinese_calendar.swift ./scripts/chinese_calendar.swift

# Frozen public result allowlist.
COPY --chown=10001:10001 results/brier_decomposition.csv ./results/brier_decomposition.csv
COPY --chown=10001:10001 results/calibration_audit.csv ./results/calibration_audit.csv
COPY --chown=10001:10001 results/change_point_audit.csv ./results/change_point_audit.csv
COPY --chown=10001:10001 results/cutoff_comparison.csv ./results/cutoff_comparison.csv
COPY --chown=10001:10001 results/dlt_era_audit.csv ./results/dlt_era_audit.csv
COPY --chown=10001:10001 results/dlt_source_crosscheck.csv ./results/dlt_source_crosscheck.csv
COPY --chown=10001:10001 results/dlt_source_crosscheck.json ./results/dlt_source_crosscheck.json
COPY --chown=10001:10001 results/experiment_manifest.json ./results/experiment_manifest.json
COPY --chown=10001:10001 results/ga_weights.json ./results/ga_weights.json
COPY --chown=10001:10001 results/holdout_predictions.csv ./results/holdout_predictions.csv
COPY --chown=10001:10001 results/model_metrics.csv ./results/model_metrics.csv
COPY --chown=10001:10001 results/moving_block_bootstrap.csv ./results/moving_block_bootstrap.csv
COPY --chown=10001:10001 results/order_statistic_audit.csv ./results/order_statistic_audit.csv
COPY --chown=10001:10001 results/p0_audit_summary.csv ./results/p0_audit_summary.csv
COPY --chown=10001:10001 results/p1_hyperparameter_selection.csv ./results/p1_hyperparameter_selection.csv
COPY --chown=10001:10001 results/pair_cooccurrence_audit.csv ./results/pair_cooccurrence_audit.csv
COPY --chown=10001:10001 results/pipeline_null_replicates.csv ./results/pipeline_null_replicates.csv
COPY --chown=10001:10001 results/pipeline_null_report.json ./results/pipeline_null_report.json
COPY --chown=10001:10001 results/pipeline_null_summary.csv ./results/pipeline_null_summary.csv
COPY --chown=10001:10001 results/randomness_diagnostics.csv ./results/randomness_diagnostics.csv

# Frozen public model inputs. Runtime/manual/synced entries are never copied.
COPY --chown=10001:10001 model_data/ssq_history.csv ./model_data/ssq_history.csv
COPY --chown=10001:10001 model_data/dlt_history.csv ./model_data/dlt_history.csv
COPY --chown=10001:10001 model_data/lunar_calendar.csv ./model_data/lunar_calendar.csv

COPY --chmod=0555 deploy/entrypoint.sh /usr/local/bin/lottery-entrypoint

USER 10001:10001

EXPOSE 8765

HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=4 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/readyz', timeout=3).read()"]

ENTRYPOINT ["/usr/local/bin/lottery-entrypoint"]
CMD ["python", "web/server.py", "--host", "0.0.0.0", "--port", "8765"]
