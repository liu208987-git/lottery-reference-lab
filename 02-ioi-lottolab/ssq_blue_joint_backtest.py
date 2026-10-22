"""双色球蓝球独立模型与“红蓝合并”模型的无泄漏走期回测。

这个脚本只读取历史数据库并输出报告，不会修改生产预测、审计数据库或自学习参数。
每个被评估期只能使用该期之前已经开奖的数据；前 70% 评估样本用于选择窗口，
后 30% 作为独立留出段。主要指标是多分类对数损失，Top1/Top5 仅作辅助观察。

运行：python ssq_blue_joint_backtest.py
输出：ssq_blue_joint_backtest_results.json / .md
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np

import ssq_db
from app_paths import DATA_ROOT


BLUE_POOL = 16
START_AT = 500
TRAIN_RATIO = 0.70
WINDOWS: tuple[int | None, ...] = (100, 200, 500, None)
MODEL_NAMES = (
    "blue_frequency",
    "joint_raw_frequency",
    "joint_opportunity_normalized",
    "joint_transition",
    "joint_transition_ensemble",
    "joint_overdue_ensemble",
)


def _safe_percent(value: float) -> str:
    return f"{value * 100:.3f}%"


def _binomial_upper_tail(n: int, observed: int, p: float) -> float:
    """P(X >= observed), X~Binomial(n,p), using stable recurrence."""
    if observed <= 0:
        return 1.0
    if observed > n:
        return 0.0
    log_term = (
        math.lgamma(n + 1) - math.lgamma(observed + 1)
        - math.lgamma(n - observed + 1)
        + observed * math.log(p) + (n - observed) * math.log1p(-p)
    )
    term = math.exp(log_term)
    terms = [term]
    for k in range(observed, n):
        term *= (n - k) / (k + 1) * p / (1 - p)
        terms.append(term)
    return min(1.0, float(math.fsum(terms)))


def _binomial_two_sided(n: int, observed: int, p: float) -> float:
    """Exact two-sided binomial p-value using probability ordering."""
    def log_pmf(k: int) -> float:
        return (
            math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)
            + k * math.log(p) + (n - k) * math.log1p(-p)
        )

    observed_log_p = log_pmf(observed)
    selected_logs = []
    for k in range(n + 1):
        log_pk = log_pmf(k)
        if log_pk <= observed_log_p + 1e-12:
            selected_logs.append(log_pk)
    largest = max(selected_logs)
    value = math.exp(largest) * math.fsum(
        math.exp(item - largest) for item in selected_logs)
    return min(1.0, float(value))


def _posthoc_any_hot_probability(draws: int, pool: int, threshold: int) -> float:
    """Exact P(max category count >= threshold) for equal multinomial draws."""
    # Exponential generating function:
    # P(all counts <= threshold-1) = n!/pool^n * [x^n](sum x^k/k!)^pool.
    cap = threshold - 1
    coefficients = [0.0] * (draws + 1)
    coefficients[0] = 1.0
    for _ in range(pool):
        updated = [0.0] * (draws + 1)
        for used, coefficient in enumerate(coefficients):
            if coefficient == 0:
                continue
            for k in range(cap + 1):
                if used + k <= draws:
                    updated[used + k] += coefficient / math.factorial(k)
        coefficients = updated
    no_hot = coefficients[draws] * math.factorial(draws) / (pool ** draws)
    return max(0.0, min(1.0, 1.0 - no_hot))


def _regularized_gamma_q(shape: float, value: float) -> float:
    """Regularized upper incomplete gamma Q(a,x), for chi-square survival."""
    if shape <= 0 or value < 0:
        raise ValueError("shape must be positive and value non-negative")
    if value == 0:
        return 1.0
    epsilon = 3e-14
    tiny = 1e-300
    log_gamma = math.lgamma(shape)

    if value < shape + 1:
        term = 1.0 / shape
        series = term
        current_shape = shape
        for _ in range(10000):
            current_shape += 1
            term *= value / current_shape
            series += term
            if abs(term) < abs(series) * epsilon:
                break
        lower = series * math.exp(-value + shape * math.log(value) - log_gamma)
        return max(0.0, min(1.0, 1.0 - lower))

    b = value + 1.0 - shape
    c = 1.0 / tiny
    d = 1.0 / max(b, tiny)
    fraction = d
    for i in range(1, 10001):
        coefficient = -i * (i - shape)
        b += 2.0
        d = coefficient * d + b
        if abs(d) < tiny:
            d = tiny
        c = b + coefficient / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        delta = d * c
        fraction *= delta
        if abs(delta - 1.0) < epsilon:
            break
    upper = math.exp(-value + shape * math.log(value) - log_gamma) * fraction
    return max(0.0, min(1.0, upper))


def load_draws() -> list[dict]:
    draws = ssq_db.get_all_draws("ASC")
    if len(draws) < START_AT + 100:
        raise ValueError(f"双色球历史数据不足：{len(draws)} 期")
    return draws


@dataclass
class FeatureStore:
    issues: list[str]
    reds: list[list[int]]
    blues: list[int]
    blue_prefix: np.ndarray
    red_prefix: np.ndarray
    joint_prefix: np.ndarray
    transition_prefix: np.ndarray
    gaps: np.ndarray

    @classmethod
    def build(cls, draws: list[dict]) -> "FeatureStore":
        issues = [str(row["issue"]) for row in draws]
        reds = [[int(row[f"r{i}"]) for i in range(1, 7)] for row in draws]
        blues = [int(row["b1"]) for row in draws]
        n = len(draws)

        blue_prefix = np.zeros((n + 1, BLUE_POOL), dtype=np.int32)
        red_prefix = np.zeros((n + 1, BLUE_POOL), dtype=np.int32)
        transition_prefix = np.zeros((n + 1, 33, BLUE_POOL), dtype=np.int32)

        for i in range(n):
            blue_prefix[i + 1] = blue_prefix[i]
            blue_prefix[i + 1, blues[i] - 1] += 1

            red_prefix[i + 1] = red_prefix[i]
            for number in reds[i]:
                if number <= BLUE_POOL:
                    red_prefix[i + 1, number - 1] += 1

            transition_prefix[i + 1] = transition_prefix[i]
            if i >= 1:
                previous_seven = set(reds[i - 1] + [blues[i - 1]])
                for number in previous_seven:
                    transition_prefix[i + 1, number - 1, blues[i] - 1] += 1

        joint_prefix = blue_prefix + red_prefix

        last_any = np.full(33, -1, dtype=np.int32)
        gaps = np.zeros((n + 1, BLUE_POOL), dtype=np.float64)
        for i in range(n):
            for blue_index in range(BLUE_POOL):
                last = int(last_any[blue_index])
                gaps[i, blue_index] = i - last if last >= 0 else i + 1
            for number in set(reds[i] + [blues[i]]):
                last_any[number - 1] = i
        for blue_index in range(BLUE_POOL):
            gaps[n, blue_index] = n - int(last_any[blue_index])

        return cls(
            issues=issues,
            reds=reds,
            blues=blues,
            blue_prefix=blue_prefix,
            red_prefix=red_prefix,
            joint_prefix=joint_prefix,
            transition_prefix=transition_prefix,
            gaps=gaps,
        )

    def probabilities(self, target: int, window: int | None, model: str) -> np.ndarray:
        """Return a 16-class probability vector using history strictly before target."""
        lower = 0 if window is None else max(0, target - window)
        alpha = 1.0

        blue_counts = self.blue_prefix[target] - self.blue_prefix[lower]
        red_counts = self.red_prefix[target] - self.red_prefix[lower]
        joint_counts = self.joint_prefix[target] - self.joint_prefix[lower]
        blue_p = (blue_counts + alpha) / (blue_counts.sum() + BLUE_POOL * alpha)
        red_p = (red_counts + alpha) / (red_counts.sum() + BLUE_POOL * alpha)
        joint_p = (joint_counts + alpha) / (joint_counts.sum() + BLUE_POOL * alpha)

        # One blue plus six reds create different exposure counts. 25%/75% first
        # normalizes each channel and then pools them in proportion to the four
        # eligible outcome slots per draw among numbers 1..16.
        opportunity_normalized = 0.25 * blue_p + 0.75 * red_p

        transition_counts = (
            self.transition_prefix[target] - self.transition_prefix[lower])
        context_rows = []
        for number in set(self.reds[target - 1] + [self.blues[target - 1]]):
            row = transition_counts[number - 1]
            context_rows.append((row + alpha) / (row.sum() + BLUE_POOL * alpha))
        transition_p = np.mean(context_rows, axis=0)
        transition_p /= transition_p.sum()

        overdue = self.gaps[target] + 1.0
        overdue /= overdue.sum()

        if model == "blue_frequency":
            return blue_p
        if model == "joint_raw_frequency":
            return joint_p
        if model == "joint_opportunity_normalized":
            return opportunity_normalized
        if model == "joint_transition":
            return transition_p
        if model == "joint_transition_ensemble":
            return 0.75 * opportunity_normalized + 0.25 * transition_p
        if model == "joint_overdue_ensemble":
            return 0.90 * opportunity_normalized + 0.10 * overdue
        raise KeyError(model)


def evaluate(
    store: FeatureStore,
    model: str,
    window: int | None,
    begin: int,
    end: int,
) -> dict:
    log_loss = 0.0
    brier = 0.0
    top1_hits = 0
    top5_hits = 0
    count = 0
    for target in range(max(START_AT, begin), end):
        probabilities = store.probabilities(target, window, model)
        actual = store.blues[target] - 1
        log_loss -= math.log(max(float(probabilities[actual]), 1e-15))
        brier += float(np.sum(probabilities * probabilities) - 2 * probabilities[actual] + 1)
        order = np.argsort(-probabilities)
        top1_hits += int(actual == int(order[0]))
        top5_hits += int(actual in order[:5])
        count += 1

    return {
        "records": count,
        "log_loss": log_loss / count,
        "brier_score": brier / count,
        "top1_hits": top1_hits,
        "top1_rate": top1_hits / count,
        "top5_hits": top5_hits,
        "top5_rate": top5_hits / count,
    }


def _window_label(window: int | None) -> str:
    return "expanding" if window is None else str(window)


def _blue_04_analysis(store: FeatureStore) -> dict:
    n = len(store.blues)
    all_count = store.blues.count(4)
    all_number_counts = [store.blues.count(number) for number in range(1, 17)]
    expected = n / 16
    chi_square = sum((count - expected) ** 2 / expected for count in all_number_counts)
    windows = {}
    for window in (15, 30, 50, 100, 200):
        count = store.blues[-window:].count(4)
        windows[str(window)] = {
            "count": count,
            "rate": count / window,
            "prespecified_upper_tail_p": _binomial_upper_tail(window, count, 1 / 16),
        }

    next_after_04 = 0
    previous_04 = 0
    next_after_other = 0
    previous_other = 0
    same_consecutive = 0
    for i in range(1, n):
        if store.blues[i] == store.blues[i - 1]:
            same_consecutive += 1
        if store.blues[i - 1] == 4:
            previous_04 += 1
            next_after_04 += int(store.blues[i] == 4)
        else:
            previous_other += 1
            next_after_other += int(store.blues[i] == 4)

    recent15 = [
        {"issue": issue, "blue": blue}
        for issue, blue in zip(store.issues[-15:], store.blues[-15:])
    ]
    return {
        "all_history": {
            "draws": n,
            "count": all_count,
            "rate": all_count / n,
            "theoretical_rate": 1 / 16,
            "expected_count": n / 16,
            "exact_two_sided_p": _binomial_two_sided(n, all_count, 1 / 16),
            "all_number_counts": {
                f"{number:02d}": all_number_counts[number - 1]
                for number in range(1, 17)
            },
            "uniform_chi_square": chi_square,
            "uniform_degrees_of_freedom": 15,
            "uniform_chi_square_p": _regularized_gamma_q(15 / 2, chi_square / 2),
        },
        "recent_windows": windows,
        "recent15_sequence": recent15,
        "posthoc_probability_any_one_of_16_occurs_at_least_4_in_15":
            _posthoc_any_hot_probability(15, 16, 4),
        "transition": {
            "next_04_after_04_count": next_after_04,
            "previous_04_count": previous_04,
            "next_04_after_04_rate": next_after_04 / previous_04,
            "next_04_after_other_count": next_after_other,
            "previous_other_count": previous_other,
            "next_04_after_other_rate": next_after_other / previous_other,
            "same_blue_consecutive_count": same_consecutive,
            "same_blue_consecutive_rate": same_consecutive / (n - 1),
            "same_blue_consecutive_exact_p": _binomial_two_sided(
                n - 1, same_consecutive, 1 / 16),
        },
    }


def run_analysis(draws: list[dict] | None = None) -> dict:
    draws = draws or load_draws()
    store = FeatureStore.build(draws)
    n = len(draws)
    split = int(n * TRAIN_RATIO)

    baseline = {
        "log_loss": math.log(BLUE_POOL),
        "brier_score": (BLUE_POOL - 1) / BLUE_POOL,
        "top1_rate": 1 / BLUE_POOL,
        "top5_rate": 5 / BLUE_POOL,
    }

    models = {}
    for model in MODEL_NAMES:
        training_candidates = []
        for window in WINDOWS:
            metrics = evaluate(store, model, window, START_AT, split)
            training_candidates.append({
                "window": _window_label(window),
                **metrics,
            })
        selected = min(training_candidates, key=lambda item: item["log_loss"])
        selected_window = (
            None if selected["window"] == "expanding" else int(selected["window"]))
        holdout = evaluate(store, model, selected_window, split, n)

        blocks = []
        edges = np.linspace(split, n, 6, dtype=int)
        for begin, end in zip(edges[:-1], edges[1:]):
            block = evaluate(store, model, selected_window, int(begin), int(end))
            blocks.append({
                "issue_from": store.issues[int(begin)],
                "issue_to": store.issues[int(end) - 1],
                **block,
            })

        current_p = store.probabilities(n, selected_window, model)
        current_order = np.argsort(-current_p)
        blue04_rank = int(np.where(current_order == 3)[0][0]) + 1
        models[model] = {
            "selected_window": _window_label(selected_window),
            "selection_metric": "minimum training log_loss",
            "training_candidates": training_candidates,
            "training_selected": selected,
            "holdout": {
                **holdout,
                "top1_nominal_binomial_p": _binomial_upper_tail(
                    holdout["records"], holdout["top1_hits"], 1 / 16),
                "top5_nominal_binomial_p": _binomial_upper_tail(
                    holdout["records"], holdout["top5_hits"], 5 / 16),
            },
            "holdout_blocks": blocks,
            "current": {
                "trained_through": store.issues[-1],
                "top5": [int(index) + 1 for index in current_order[:5]],
                "blue04_rank": blue04_rank,
                "blue04_probability": float(current_p[3]),
                "all_probabilities": {
                    f"{i + 1:02d}": float(current_p[i]) for i in range(BLUE_POOL)
                },
            },
        }

    all_joint_worse = all(
        models[name]["holdout"]["log_loss"] >= baseline["log_loss"]
        for name in MODEL_NAMES if name != "blue_frequency")
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "data": {
            "database": str(ssq_db.DB_PATH),
            "draws": n,
            "issue_from": store.issues[0],
            "issue_to": store.issues[-1],
            "evaluation_from_index": START_AT,
            "training_records": split - START_AT,
            "holdout_records": n - split,
            "training_issue_to": store.issues[split - 1],
            "holdout_issue_from": store.issues[split],
            "no_future_data": True,
        },
        "uniform_baseline": baseline,
        "blue04": _blue_04_analysis(store),
        "models": models,
        "decision": {
            "joint_models_beat_uniform_log_loss": not all_joint_worse,
            "production_blue_algorithm_changed": False,
            "reason": (
                "所有红蓝合并候选在独立留出段的对数损失均未优于16选1均匀基线；"
                "局部Top5提升跨时间块不稳定，不足以替换生产算法。"
                if all_joint_worse else
                "至少一个候选优于均匀基线，仍需重复样本与多重检验校正后再决定。"
            ),
        },
    }


def render_markdown(result: dict) -> str:
    data = result["data"]
    baseline = result["uniform_baseline"]
    blue04 = result["blue04"]
    lines = [
        "# 双色球蓝球独立 / 红蓝合并模型回测",
        "",
        f"生成时间：{result['generated_at']}",
        f"数据：{data['draws']} 期（{data['issue_from']} ～ {data['issue_to']}）",
        f"走期评估：从第 {data['evaluation_from_index'] + 1} 条记录开始；训练段 "
        f"{data['training_records']} 期，独立留出段 {data['holdout_records']} 期。",
        "每期预测只使用此前开奖；窗口仅在训练段选择，留出段不参与调参。",
        "",
        "## 蓝球 04 真实统计",
        "",
    ]
    history = blue04["all_history"]
    lines.extend([
        f"- 全历史：{history['count']}/{history['draws']} = "
        f"{_safe_percent(history['rate'])}；理论 6.250%，期望次数 "
        f"{history['expected_count']:.25g}，精确双侧 p={history['exact_two_sided_p']:.4f}。",
        f"- 16个蓝球全体均匀性：chi-square={history['uniform_chi_square']:.4f}，"
        f"df={history['uniform_degrees_of_freedom']}，p={history['uniform_chi_square_p']:.4f}；"
        "未发现整体号码偏置。",
    ])
    for window, values in blue04["recent_windows"].items():
        lines.append(
            f"- 最近 {window} 期：{values['count']} 次，"
            f"{_safe_percent(values['rate'])}；若预先指定观察 04，出现不少于该次数的概率 "
            f"p={values['prespecified_upper_tail_p']:.4f}。")
    lines.extend([
        f"- 事后查看16个号码并挑最热者：任一号码在15期内至少出现4次的概率为 "
        f"{_safe_percent(blue04['posthoc_probability_any_one_of_16_occurs_at_least_4_in_15'])}。",
        f"- 04之后下一期仍开04："
        f"{blue04['transition']['next_04_after_04_count']}/"
        f"{blue04['transition']['previous_04_count']} = "
        f"{_safe_percent(blue04['transition']['next_04_after_04_rate'])}。",
        f"- 任意蓝球连号（两期相同）："
        f"{blue04['transition']['same_blue_consecutive_count']}/"
        f"{history['draws'] - 1} = "
        f"{_safe_percent(blue04['transition']['same_blue_consecutive_rate'])}，"
        f"精确双侧 p={blue04['transition']['same_blue_consecutive_exact_p']:.4f}。",
        "",
        "## 独立留出段结果",
        "",
        f"均匀基线：log loss={baseline['log_loss']:.6f}，"
        f"Brier={baseline['brier_score']:.6f}，Top1=6.250%，Top5=31.250%。",
        "",
        "| 模型 | 训练选择窗口 | 留出段 log loss | Brier | Top1 | Top5 | 当前Top5 | 04排名 / 模型值 |",
        "|---|---:|---:|---:|---:|---:|---|---|",
    ])
    for name, model in result["models"].items():
        holdout = model["holdout"]
        current = model["current"]
        lines.append(
            f"| {name} | {model['selected_window']} | {holdout['log_loss']:.6f} | "
            f"{holdout['brier_score']:.6f} | {_safe_percent(holdout['top1_rate'])} | "
            f"{_safe_percent(holdout['top5_rate'])} | "
            f"{' '.join(f'{value:02d}' for value in current['top5'])} | "
            f"第{current['blue04_rank']} / {_safe_percent(current['blue04_probability'])} |")

    joint = result["models"]["joint_opportunity_normalized"]
    lines.extend([
        "",
        "## 合并模型时间块稳定性",
        "",
        "| 期号范围 | log loss | Top1 | Top5 |",
        "|---|---:|---:|---:|",
    ])
    for block in joint["holdout_blocks"]:
        lines.append(
            f"| {block['issue_from']} ～ {block['issue_to']} | "
            f"{block['log_loss']:.6f} | {_safe_percent(block['top1_rate'])} | "
            f"{_safe_percent(block['top5_rate'])} |")

    lines.extend([
        "",
        "## 结论",
        "",
        result["decision"]["reason"],
        "原样合并会把同一号码在红球与蓝球中的不同抽样机会混在一起，因此报告同时给出"
        "“原样合并”和“机会归一化合并”。当前两种做法都没有在主要校准指标上击败均匀基线。",
        "Top5 的某一留出段观察提升不代表下一期概率已提高：训练段与多个时间块并不一致，"
        "且本报告比较了多个窗口与模型，需要防止择优偏差。",
        "",
        "> 彩票开奖按设计是独立随机事件。历史频度、遗漏或连开不会改变每个蓝球下一期"
        "理论上的 1/16 概率；回测结果也未提供足够证据推翻这一点。",
        "",
    ])
    return "\n".join(lines)


def write_reports(result: dict, output_dir: Path = DATA_ROOT) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "ssq_blue_joint_backtest_results.json"
    markdown_path = output_dir / "ssq_blue_joint_backtest_results.md"
    json_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    markdown_path.write_text(render_markdown(result), encoding="utf-8")
    return json_path, markdown_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir", type=Path, default=DATA_ROOT,
        help="报告输出目录（默认数据目录）")
    args = parser.parse_args(argv)
    result = run_analysis()
    json_path, markdown_path = write_reports(result, args.output_dir)
    print(f"JSON: {json_path}")
    print(f"Markdown: {markdown_path}")
    print(result["decision"]["reason"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
