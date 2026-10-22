"""双色球 PDF 外生特征实验模型。

这个模块把报告中可编码的信息分成五组，并用严格的时间顺序留出集比较：

* history: 只使用目标期之前的频率、EWMA、遗漏等历史信号；
* loading: 报告给出的固定球筒装载结构；
* calendar: 期内开奖序列和年内周期；
* maintenance: 每 20 次清洗、约 2 年换球的代理周期；
* governance: 2017 年公证机构变更及 2021143 故障后的制度分段。

真实球组编号、真实清洗日和换球日没有公开逐期数据，因此 maintenance
只能是研究用代理变量。模型仅在最后 25% 的从未参与调参的数据上优于均匀
基线、通过多重检验且分段稳定时才会用于生成号码，否则自动回退到均匀模型。
"""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from math import cos, pi, sin, sqrt
from statistics import NormalDist
from typing import Iterable
import random

import numpy as np

from lottery_predictor import _coverage_portfolio


RED_POOL = 33
RED_PICK = 6
BLUE_POOL = 16
BLUE_PICK = 1
WARMUP = 150

VARIANTS = {
    "history": ("history",),
    "loading": ("loading",),
    "calendar": ("loading", "calendar"),
    "maintenance_proxy": ("loading", "maintenance"),
    "governance": ("loading", "governance"),
    "pdf_external": ("loading", "calendar", "maintenance", "governance"),
    "hybrid": ("history", "loading", "calendar", "maintenance", "governance"),
}

GROUP_LABELS = {
    "history": "历史量价式信号",
    "loading": "固定装球结构",
    "calendar": "开奖序列/年内周期",
    "maintenance_proxy": "清洗与换球代理周期",
    "governance": "公证/故障制度分段",
    "pdf_external": "PDF全部外生因素",
    "hybrid": "历史+PDF外生因素",
}


@dataclass
class FeatureDataset:
    issues: list[str]
    names: list[str]
    groups: list[str]
    x: np.ndarray                 # periods x pool x features
    y: np.ndarray                 # periods x pool
    next_x: np.ndarray            # pool x features
    next_issue: str
    pool_size: int
    pick_count: int


@dataclass
class FittedLinearProbability:
    columns: np.ndarray
    mean: np.ndarray
    scale: np.ndarray
    beta: np.ndarray
    base: float
    shrink: float

    def predict(self, x: np.ndarray) -> np.ndarray:
        selected = x[..., self.columns]
        z = (selected - self.mean) / self.scale
        design = np.concatenate(
            [np.ones((*z.shape[:-1], 1), dtype=float), z], axis=-1)
        raw = self.base + self.shrink * (design @ self.beta)
        return _calibrate(np.clip(raw, 0.001, 0.999), self.base * x.shape[-2])


def _next_issue(latest: str) -> str:
    year, sequence = int(latest[:4]), int(latest[4:])
    return f"{year}{sequence + 1:03d}"


def _ball_layout(number: int, pool_size: int) -> tuple[float, float, float]:
    """返回报告中固定装球顺序对应的球筒、筒内位置和筒容量。"""
    if pool_size == RED_POOL:
        if number <= 12:
            tube = (number - 1) // 4 + 1
            position = (number - 1) % 4 + 1
            size = 4
        else:
            tube = (number - 13) // 3 + 4
            position = (number - 13) % 3 + 1
            size = 3
    else:
        if number <= 12:
            tube = (number - 1) // 2 + 1
            position = (number - 1) % 2 + 1
            size = 2
        else:
            tube = number - 6
            position = 1
            size = 1
    return tube / 10.0, position / 4.0, size / 4.0


def _periodic(phase: float) -> tuple[float, float]:
    angle = 2.0 * pi * phase
    return sin(angle), cos(angle)


def _external_values(issue: str, global_index: int) -> dict[str, float]:
    sequence = int(issue[4:])
    slot_sin, slot_cos = _periodic(((sequence - 1) % 3) / 3.0)
    annual_sin, annual_cos = _periodic((sequence - 1) / 153.0)
    clean_sin, clean_cos = _periodic(global_index / 20.0)
    set_clean_sin, set_clean_cos = _periodic(global_index / 80.0)
    replace_sin, replace_cos = _periodic(global_index / 306.0)
    return {
        "slot_sin": slot_sin,
        "slot_cos": slot_cos,
        "annual_sin": annual_sin,
        "annual_cos": annual_cos,
        "clean20_sin": clean_sin,
        "clean20_cos": clean_cos,
        "set_clean80_sin": set_clean_sin,
        "set_clean80_cos": set_clean_cos,
        "replace306_sin": replace_sin,
        "replace306_cos": replace_cos,
        # 2017-04-01 后首个双色球开奖约为 2017037。
        "post_notary_2017": float(issue >= "2017037"),
        # 2021143 当期故障在开奖前不可知，只从下一期开始分段，避免泄漏。
        "post_fault_2021143": float(issue >= "2021144"),
    }


def _candidate_features(
    number: int,
    pool_size: int,
    history: dict[str, np.ndarray],
    external: dict[str, float],
) -> tuple[list[str], list[str], list[float]]:
    index = number - 1
    number_z = (number - (pool_size + 1) / 2.0) / pool_size
    tube, position, tube_size = _ball_layout(number, pool_size)
    names = [
        "hist_long", "hist_ewma10", "hist_ewma50", "hist_cross",
        "hist_gap", "hist_last",
        "load_number", "load_number2", "load_tube", "load_position",
        "load_tube_size",
    ]
    groups = ["history"] * 6 + ["loading"] * 5
    values = [
        history["long"][index], history["ewma10"][index],
        history["ewma50"][index], history["cross"][index],
        history["gap"][index], history["last"][index],
        number_z, number_z * number_z, tube, position, tube_size,
    ]
    physical = (number_z, tube, position)
    group_keys = {
        "calendar": ("slot_sin", "slot_cos", "annual_sin", "annual_cos"),
        "maintenance": (
            "clean20_sin", "clean20_cos", "set_clean80_sin",
            "set_clean80_cos", "replace306_sin", "replace306_cos",
        ),
        "governance": ("post_notary_2017", "post_fault_2021143"),
    }
    for group, keys in group_keys.items():
        for key in keys:
            value = external[key]
            # 共同时间变量本身在逐期概率和校准时会相互抵消；与号码、球筒、
            # 筒内位置交互后，才能检验开奖机制是否改变号码的相对概率。
            names.append(f"{key}_common")
            groups.append(group)
            values.append(value)
            for suffix, physical_value in zip(
                    ("number", "tube", "position"), physical):
                names.append(f"{key}_x_{suffix}")
                groups.append(group)
                values.append(value * physical_value)
    return names, groups, values


def _history_snapshot(
    count: int,
    base: float,
    counts: np.ndarray,
    ewma10_num: np.ndarray,
    ewma10_den: float,
    ewma50_num: np.ndarray,
    ewma50_den: float,
    last_seen: np.ndarray,
    gap_sum: np.ndarray,
    gap_count: np.ndarray,
    last_vector: np.ndarray,
) -> dict[str, np.ndarray]:
    long_rate = counts / max(count, 1) - base
    ewma10 = ewma10_num / max(ewma10_den, 1e-12) - base
    ewma50 = ewma50_num / max(ewma50_den, 1e-12) - base
    omission = np.where(last_seen >= 0, count - 1 - last_seen, count)
    mean_gap = np.where(gap_count > 0, gap_sum / np.maximum(gap_count, 1), 1.0 / base)
    gap = np.clip(omission / np.maximum(mean_gap, 1.0) - 1.0, -1.0, 2.0)
    return {
        "long": long_rate,
        "ewma10": ewma10,
        "ewma50": ewma50,
        "cross": ewma10 - ewma50,
        "gap": gap,
        "last": last_vector.copy(),
    }


def build_feature_dataset(
    rows: Iterable[dict],
    *,
    pool_size: int,
    pick_count: int,
    prefix: str,
    warmup: int = WARMUP,
) -> FeatureDataset:
    rows = list(rows)
    if len(rows) <= warmup + 100:
        raise ValueError(f"历史数据不足：至少需要 {warmup + 101} 期")
    base = pick_count / pool_size
    counts = np.zeros(pool_size)
    ewma10_num = np.zeros(pool_size)
    ewma50_num = np.zeros(pool_size)
    ewma10_den = ewma50_den = 0.0
    decay10 = 0.5 ** (1.0 / 10.0)
    decay50 = 0.5 ** (1.0 / 50.0)
    last_seen = np.full(pool_size, -1, dtype=int)
    gap_sum = np.zeros(pool_size)
    gap_count = np.zeros(pool_size)
    last_vector = np.zeros(pool_size)
    x_periods: list[list[list[float]]] = []
    y_periods: list[np.ndarray] = []
    issues: list[str] = []
    names: list[str] | None = None
    groups: list[str] | None = None

    for index, row in enumerate(rows):
        history = _history_snapshot(
            index, base, counts, ewma10_num, ewma10_den, ewma50_num,
            ewma50_den, last_seen, gap_sum, gap_count, last_vector)
        if index >= warmup:
            external = _external_values(row["issue"], index)
            period_features = []
            for number in range(1, pool_size + 1):
                candidate_names, candidate_groups, values = _candidate_features(
                    number, pool_size, history, external)
                if names is None:
                    names, groups = candidate_names, candidate_groups
                period_features.append(values)
            actual = np.zeros(pool_size)
            for pick_index in range(1, pick_count + 1):
                actual[row[f"{prefix}{pick_index}"] - 1] = 1.0
            x_periods.append(period_features)
            y_periods.append(actual)
            issues.append(row["issue"])

        current = np.zeros(pool_size)
        for pick_index in range(1, pick_count + 1):
            current[row[f"{prefix}{pick_index}"] - 1] = 1.0
        hit_indices = np.flatnonzero(current)
        for hit in hit_indices:
            if last_seen[hit] >= 0:
                gap_sum[hit] += index - last_seen[hit]
                gap_count[hit] += 1
            last_seen[hit] = index
        counts += current
        ewma10_num = decay10 * ewma10_num + current
        ewma10_den = decay10 * ewma10_den + 1.0
        ewma50_num = decay50 * ewma50_num + current
        ewma50_den = decay50 * ewma50_den + 1.0
        last_vector = current

    next_issue = _next_issue(rows[-1]["issue"])
    next_history = _history_snapshot(
        len(rows), base, counts, ewma10_num, ewma10_den, ewma50_num,
        ewma50_den, last_seen, gap_sum, gap_count, last_vector)
    next_external = _external_values(next_issue, len(rows))
    next_features = []
    for number in range(1, pool_size + 1):
        _, _, values = _candidate_features(
            number, pool_size, next_history, next_external)
        next_features.append(values)
    return FeatureDataset(
        issues=issues,
        names=names or [],
        groups=groups or [],
        x=np.asarray(x_periods, dtype=float),
        y=np.asarray(y_periods, dtype=float),
        next_x=np.asarray(next_features, dtype=float),
        next_issue=next_issue,
        pool_size=pool_size,
        pick_count=pick_count,
    )


def _columns_for(dataset: FeatureDataset, variant: str) -> np.ndarray:
    allowed = set(VARIANTS[variant])
    return np.asarray(
        [i for i, group in enumerate(dataset.groups) if group in allowed],
        dtype=int,
    )


def _fit(
    dataset: FeatureDataset,
    variant: str,
    period_indices: np.ndarray,
    ridge: float,
    shrink: float,
) -> FittedLinearProbability:
    columns = _columns_for(dataset, variant)
    x = dataset.x[period_indices][..., columns].reshape(-1, len(columns))
    y = dataset.y[period_indices].reshape(-1) - dataset.pick_count / dataset.pool_size
    mean = x.mean(axis=0)
    scale = x.std(axis=0)
    scale[scale < 1e-10] = 1.0
    z = (x - mean) / scale
    design = np.column_stack([np.ones(len(z)), z])
    gram = design.T @ design / len(design)
    penalty = np.eye(gram.shape[0]) * ridge
    penalty[0, 0] = 0.0
    rhs = design.T @ y / len(design)
    try:
        beta = np.linalg.solve(gram + penalty, rhs)
    except np.linalg.LinAlgError:
        beta = np.linalg.pinv(gram + penalty) @ rhs
    return FittedLinearProbability(
        columns=columns,
        mean=mean,
        scale=scale,
        beta=beta,
        base=dataset.pick_count / dataset.pool_size,
        shrink=shrink,
    )


def _calibrate(probabilities: np.ndarray, target: float) -> np.ndarray:
    result = np.asarray(probabilities, dtype=float).copy()
    one_dimensional = result.ndim == 1
    if one_dimensional:
        result = result[None, :]
    for _ in range(30):
        delta = target - result.sum(axis=1)
        if np.max(np.abs(delta)) < 1e-10:
            break
        for row_index, row_delta in enumerate(delta):
            if row_delta > 0:
                free = result[row_index] < 0.999
            else:
                free = result[row_index] > 0.001
            if free.any():
                result[row_index, free] = np.clip(
                    result[row_index, free] + row_delta / free.sum(),
                    0.001, 0.999)
    return result[0] if one_dimensional else result


def _losses(probabilities: np.ndarray, actual: np.ndarray) -> np.ndarray:
    return np.mean((probabilities - actual) ** 2, axis=1)


def _top_hits(probabilities: np.ndarray, actual: np.ndarray, pick: int) -> float:
    selected = np.argpartition(probabilities, -pick, axis=1)[:, -pick:]
    return float(np.take_along_axis(actual, selected, axis=1).sum(axis=1).mean())


def _pvalue_newey_west(values: np.ndarray) -> float:
    values = np.asarray(values, dtype=float)
    count = len(values)
    if count < 2:
        return 1.0
    mean = float(values.mean())
    centered = values - mean
    max_lag = max(1, int(count ** (1.0 / 3.0)))
    variance = float(centered @ centered / count)
    for lag in range(1, max_lag + 1):
        covariance = float(centered[lag:] @ centered[:-lag] / count)
        variance += 2.0 * (1.0 - lag / (max_lag + 1.0)) * covariance
    if variance <= 0:
        return 1.0
    z_score = mean / sqrt(variance / count)
    return 1.0 - NormalDist().cdf(z_score)


def _stable_blocks(values: np.ndarray, blocks: int = 4) -> int:
    return sum(float(chunk.mean()) > 0 for chunk in np.array_split(values, blocks))


def _tune(
    dataset: FeatureDataset,
    variant: str,
    train: np.ndarray,
    validation: np.ndarray,
) -> tuple[float, float, float]:
    best = None
    for ridge in (0.0001, 0.001, 0.01, 0.1, 1.0):
        base_model = _fit(dataset, variant, train, ridge, 1.0)
        raw = base_model.predict(dataset.x[validation])
        base = dataset.pick_count / dataset.pool_size
        for shrink in (0.25, 0.5, 0.75, 1.0):
            probabilities = _calibrate(base + shrink * (raw - base), dataset.pick_count)
            loss = float(_losses(probabilities, dataset.y[validation]).mean())
            candidate = (loss, ridge, shrink)
            if best is None or candidate < best:
                best = candidate
    assert best is not None
    return best[1], best[2], best[0]


def evaluate_dataset(dataset: FeatureDataset) -> dict:
    periods = len(dataset.issues)
    train_end = max(100, int(periods * 0.55))
    validation_end = max(train_end + 60, int(periods * 0.75))
    validation_end = min(validation_end, periods - 60)
    train = np.arange(0, train_end)
    validation = np.arange(train_end, validation_end)
    test = np.arange(validation_end, periods)
    baseline = dataset.pick_count / dataset.pool_size
    uniform_loss = baseline * (1.0 - baseline)
    rows = []
    models: dict[str, FittedLinearProbability] = {}
    for variant in VARIANTS:
        ridge, shrink, validation_loss = _tune(
            dataset, variant, train, validation)
        model = _fit(
            dataset, variant, np.arange(0, validation_end), ridge, shrink)
        probabilities = model.predict(dataset.x[test])
        losses = _losses(probabilities, dataset.y[test])
        differences = uniform_loss - losses
        improvement = float(differences.mean())
        relative = improvement / uniform_loss
        rows.append({
            "model": variant,
            "label": GROUP_LABELS[variant],
            "ridge": ridge,
            "shrink": shrink,
            "validation_brier": validation_loss,
            "test_brier": float(losses.mean()),
            "relative_improvement": relative,
            "raw_p": _pvalue_newey_west(differences),
            "stable_blocks": _stable_blocks(differences),
            "top_hits": _top_hits(
                probabilities, dataset.y[test], dataset.pick_count),
            "test_periods": len(test),
        })
        models[variant] = model

    tests = len(rows)
    for row in rows:
        row["corrected_p"] = min(1.0, row.pop("raw_p") * tests)
    # 模型选择只看验证集；最终门槛只在未参与选择的测试集上判断。
    selected = min(rows, key=lambda row: row["validation_brier"])
    passed = (
        selected["relative_improvement"] >= 0.001
        and selected["corrected_p"] < 0.05
        and selected["stable_blocks"] >= 3
    )
    selected["gate_passed"] = passed
    next_probability = models[selected["model"]].predict(dataset.next_x)
    if not passed:
        next_probability = np.full(dataset.pool_size, baseline)
    rows.sort(key=lambda row: row["test_brier"])
    return {
        "selected_model": selected["model"] if passed else "uniform",
        "best_validation_candidate": selected["model"],
        "gate_passed": passed,
        "reason": (
            "留出测试通过多重检验与稳定性门槛"
            if passed else
            "外生/历史候选未在独立留出集稳定优于均匀基线，已回退均匀概率"
        ),
        "uniform_brier": uniform_loss,
        "split": {
            "train": len(train), "validation": len(validation),
            "test": len(test), "test_from": dataset.issues[validation_end],
            "test_to": dataset.issues[-1],
        },
        "rows": rows,
        "next_probabilities": {
            number: float(next_probability[number - 1])
            for number in range(1, dataset.pool_size + 1)
        },
    }


def run_research(rows: Iterable[dict], ticket_count: int = 5) -> dict:
    rows = list(rows)
    red_dataset = build_feature_dataset(
        rows, pool_size=RED_POOL, pick_count=RED_PICK, prefix="r")
    blue_dataset = build_feature_dataset(
        rows, pool_size=BLUE_POOL, pick_count=BLUE_PICK, prefix="b")
    red = evaluate_dataset(red_dataset)
    blue = evaluate_dataset(blue_dataset)
    latest = rows[-1]["issue"]
    seed_payload = f"ssq-exogenous-v1|{latest}|{len(rows)}".encode("utf-8")
    rng = random.Random(int.from_bytes(sha256(seed_payload).digest()[:8], "big"))
    tickets = _coverage_portfolio(
        rng, RED_POOL, RED_PICK, BLUE_POOL, BLUE_PICK, ticket_count,
        red["next_probabilities"] if red["gate_passed"] else None,
        blue["next_probabilities"] if blue["gate_passed"] else None,
    )
    return {
        "model": "ssq-pdf-exogenous-gated-v1",
        "trained_through": latest,
        "sample_size": len(rows),
        "next_issue": red_dataset.next_issue,
        "red": red,
        "blue": blue,
        "tickets": [(list(reds), list(blues)) for reds, blues in tickets],
        "pdf_factors": {
            "direct": [
                "红蓝球固定分筒与筒内摆放顺序",
                "2017-04-01 公证机构变更分段",
                "2021143 故障后分段（故障当期不作为先验特征）",
            ],
            "proxy": [
                "每20次清洗的全局周期代理",
                "4套球随机轮用下的80期预期清洗周期代理",
                "约2年换球对应的306期代理周期",
            ],
            "excluded": [
                "设备型号、材质等全时期常量（无法区分各期）",
                "当期实际球组、真实清洗/换球日期（逐期数据未公开）",
                "公证、封存、观摩等公平保障（不是号码方向信号）",
            ],
        },
    }

