"""Leakage-free quantitative signal research for lottery number inclusion.

The gate is deliberately conservative.  Candidate models are enabled only
when they improve per-draw Brier score versus the uniform model, survive a
Bonferroni correction, and remain positive in at least three of four time
blocks.  Otherwise the deployable result is the uniform model.
"""

from __future__ import annotations

from collections import Counter
from math import exp, log, sqrt
from statistics import NormalDist, fmean


MODEL_NAMES = (
    "bayes_frequency",
    "ewma_hot_10",
    "ewma_hot_25",
    "ewma_hot_50",
    "ewma_mean_reversion_25",
    "ewma_crossover_10_80",
    "markov_hit_state",
    "gap_reversion",
)
_GATE_CACHE = {}


def _sum_calibrate(values, target):
    values = [min(0.995, max(0.005, float(x))) for x in values]
    for _ in range(20):
        delta = target - sum(values)
        if abs(delta) < 1e-10:
            break
        free = [i for i, x in enumerate(values)
                if (delta > 0 and x < 0.995) or (delta < 0 and x > 0.005)]
        if not free:
            break
        step = delta / len(free)
        for i in free:
            values[i] = min(0.995, max(0.005, values[i] + step))
    return {i + 1: value for i, value in enumerate(values)}


def _ewma(seq, pool_size, half_life):
    decay = exp(-log(2.0) / half_life)
    totals = [0.0] * pool_size
    weight_sum = 0.0
    weight = 1.0
    for draw in reversed(seq):
        for number in draw:
            totals[number - 1] += weight
        weight_sum += weight
        weight *= decay
    if not weight_sum:
        return [0.0] * pool_size
    return [x / weight_sum for x in totals]


def model_probabilities(seq, pool_size, pick_count, model):
    """Predict inclusion probability for each number for the next draw."""
    base = pick_count / pool_size
    if not seq or model == "uniform":
        return {n: base for n in range(1, pool_size + 1)}

    if model == "bayes_frequency":
        counts = Counter(x for draw in seq for x in draw)
        prior = 200.0
        raw = [(prior * base + counts[n]) / (prior + len(seq))
               for n in range(1, pool_size + 1)]

    elif model.startswith("ewma_hot_"):
        half_life = int(model.rsplit("_", 1)[1])
        signal = _ewma(seq, pool_size, half_life)
        # Shrink noisy short-window estimates toward the fair-draw probability.
        strength = half_life / (half_life + 30.0)
        raw = [base + strength * (x - base) for x in signal]

    elif model == "ewma_mean_reversion_25":
        signal = _ewma(seq, pool_size, 25)
        raw = [base - 0.35 * (x - base) for x in signal]

    elif model == "ewma_crossover_10_80":
        short = _ewma(seq, pool_size, 10)
        long = _ewma(seq, pool_size, 80)
        raw = [base + 0.40 * (s - ell) for s, ell in zip(short, long)]

    elif model == "markov_hit_state":
        prior = 100.0
        last = set(seq[-1])
        raw = []
        for number in range(1, pool_size + 1):
            state = number in last
            trials = hits = 0
            for previous, following in zip(seq[:-1], seq[1:]):
                if (number in previous) == state:
                    trials += 1
                    hits += number in following
            raw.append((prior * base + hits) / (prior + trials))

    elif model == "gap_reversion":
        raw = []
        for number in range(1, pool_size + 1):
            positions = [i for i, draw in enumerate(seq) if number in draw]
            if not positions:
                raw.append(base)
                continue
            omission = len(seq) - 1 - positions[-1]
            gaps = [b - a for a, b in zip(positions[:-1], positions[1:])]
            mean_gap = fmean(gaps) if gaps else 1.0 / base
            ratio = min(2.0, omission / max(mean_gap, 1.0))
            raw.append(base * (1.0 + 0.15 * (ratio - 1.0)))

    else:
        raise ValueError(f"unknown model: {model}")

    return _sum_calibrate(raw, pick_count)


def _brier(probabilities, actual, pool_size):
    return fmean(
        (probabilities[n] - (1.0 if n in actual else 0.0)) ** 2
        for n in range(1, pool_size + 1)
    )


def _block_stability(differences, blocks=4):
    size = max(1, len(differences) // blocks)
    chunks = [differences[i:i + size] for i in range(0, len(differences), size)]
    chunks = chunks[:blocks]
    return sum(bool(chunk) and fmean(chunk) > 0 for chunk in chunks)


def _newey_west_pvalue(values):
    """One-sided p-value for mean > 0 with autocorrelation-robust error."""
    count = len(values)
    if count < 2:
        return 1.0
    mean = fmean(values)
    centered = [x - mean for x in values]
    max_lag = max(1, int(count ** (1.0 / 3.0)))
    long_run_variance = sum(x * x for x in centered) / count
    for lag in range(1, max_lag + 1):
        covariance = sum(
            centered[i] * centered[i - lag] for i in range(lag, count)
        ) / count
        bartlett_weight = 1.0 - lag / (max_lag + 1.0)
        long_run_variance += 2.0 * bartlett_weight * covariance
    if long_run_variance <= 0:
        return 1.0
    z = mean / sqrt(long_run_variance / count)
    return 1.0 - NormalDist().cdf(z)


def research_gate(seq, pool_size, pick_count, validation_periods=200,
                  min_train=100, training_window=1000):
    """Run walk-forward candidate evaluation and return deployment decision."""
    relevant = seq[-(training_window + validation_periods):]
    cache_key = (pool_size, pick_count, validation_periods, min_train,
                 training_window, tuple(tuple(draw) for draw in relevant))
    if cache_key in _GATE_CACHE:
        return _GATE_CACHE[cache_key]
    start = max(min_train, len(seq) - validation_periods)
    if len(seq) - start < 60:
        report = {
            "selected_model": "uniform", "gate_passed": False,
            "reason": "样本不足，至少需要60个样本外验证期", "candidates": [],
        }
        _GATE_CACHE[cache_key] = report
        return report

    base = pick_count / pool_size
    uniform = {n: base for n in range(1, pool_size + 1)}
    candidate_differences = {name: [] for name in MODEL_NAMES}
    for index in range(start, len(seq)):
        history = seq[max(0, index - training_window):index]
        actual = set(seq[index])
        baseline_loss = _brier(uniform, actual, pool_size)
        for name in MODEL_NAMES:
            candidate = model_probabilities(
                history, pool_size, pick_count, name)
            loss = _brier(candidate, actual, pool_size)
            candidate_differences[name].append(baseline_loss - loss)

    rows = []
    tests = len(MODEL_NAMES)
    baseline_brier = base * (1.0 - base)
    for name, differences in candidate_differences.items():
        improvement = fmean(differences)
        raw_p = _newey_west_pvalue(differences)
        corrected_p = min(1.0, raw_p * tests)
        stable_blocks = _block_stability(differences)
        relative = improvement / baseline_brier
        rows.append({
            "model": name,
            "brier_improvement": improvement,
            "relative_improvement": relative,
            "corrected_p": corrected_p,
            "stable_blocks": stable_blocks,
            "validation_periods": len(differences),
        })
    rows.sort(key=lambda row: row["brier_improvement"], reverse=True)
    best = rows[0]
    passed = (best["brier_improvement"] > 0
              and best["relative_improvement"] >= 0.001
              and best["corrected_p"] < 0.05
              and best["stable_blocks"] >= 3)
    selected = best["model"] if passed else "uniform"
    reason = ("候选信号通过多重检验和稳定性门槛"
              if passed else "没有候选信号通过多重检验和稳定性门槛，回退等概率")
    report = {
        "selected_model": selected,
        "gate_passed": passed,
        "reason": reason,
        "best_candidate": best,
        "candidates": rows,
        "validation_start": start,
        "validation_periods": len(seq) - start,
        "training_window": training_window,
    }
    _GATE_CACHE[cache_key] = report
    return report


def deploy_probabilities(seq, pool_size, pick_count, **gate_options):
    report = research_gate(seq, pool_size, pick_count, **gate_options)
    training_window = report.get("training_window", len(seq))
    probabilities = model_probabilities(
        seq[-training_window:], pool_size, pick_count, report["selected_model"])
    return probabilities, report
