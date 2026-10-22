"""双色球 V8-DT50 历史逐期回测（独立验证脚本，不修改生产程序）。

每期只使用目标期开奖前已经存在的数据：

1. 按生产 V8 的期号种子生成并排序 5 注；
2. 选一注为红球基础，寻找与其共享 5 个红球的结构最优替代组；
3. 组成 5 胆 + 2 拖 + 12 蓝（24 注、48 元）；
4. 再加入一注与主体分散的单式保险（2 元），合计 25 注、50 元；
5. 可选排除已经开出过的完整红球+蓝球组合；
6. 可选使用仅由此前历史形成的低频结构过滤。

运行：python backtest_ssq_dantuo50.py
输出：ssq_dantuo50_backtest_results.json / ssq_dantuo50_backtest_report.md
"""

from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from itertools import combinations
from pathlib import Path
from typing import Iterable

import ssq_db
from app_paths import DATA_ROOT
from ssq_prediction_audit import prize_level
from ticket_ranking import rank_tickets
from v8_predictor import build_v8_balanced, v8_rng


PRIZES = ["一等奖", "二等奖", "三等奖", "四等奖", "五等奖", "六等奖", "福运奖"]
PRIZE_RANK = {name: index for index, name in enumerate(PRIZES, 1)}
FIXED_PRIZE = {"三等奖": 3000, "四等奖": 200, "五等奖": 10,
               "六等奖": 5, "福运奖": 5}
MIN_EMPIRICAL_HISTORY = 100
RARE_RATE = 0.015
TAIL_RATE = 0.01
PRIMES = {2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31}


def _reds(draw: dict) -> tuple[int, ...]:
    return tuple(int(draw[f"r{index}"]) for index in range(1, 7))


def _ticket_key(reds: Iterable[int], blue: int) -> tuple[int, ...]:
    return tuple(sorted(int(number) for number in reds)) + (int(blue),)


def _max_consecutive_run(reds: Iterable[int]) -> int:
    ordered = sorted(int(number) for number in reds)
    best = current = 1
    for left, right in zip(ordered, ordered[1:]):
        current = current + 1 if right == left + 1 else 1
        best = max(best, current)
    return best


def _ac_value(reds: Iterable[int]) -> int:
    ordered = sorted(int(number) for number in reds)
    return len({right - left for left, right in combinations(ordered, 2)}) - 5


def _has_two_disjoint_triples(reds: Iterable[int]) -> bool:
    values = set(int(number) for number in reds)
    starts = [start for start in range(1, 32)
              if {start, start + 1, start + 2} <= values]
    return any(
        {left, left + 1, left + 2}.isdisjoint(
            {right, right + 1, right + 2})
        for left, right in combinations(starts, 2)
    )


def _shape_values(reds: Iterable[int]) -> dict[str, int | bool]:
    reds = tuple(sorted(int(number) for number in reds))
    zones = (
        sum(number <= 11 for number in reds),
        sum(12 <= number <= 22 for number in reds),
        sum(number >= 23 for number in reds),
    )
    mod_counts = tuple(sum(number % 3 == value for number in reds)
                       for value in range(3))
    tail_counts = Counter(number % 10 for number in reds)
    return {
        "sum": sum(reds),
        "span": max(reds) - min(reds),
        "ac": _ac_value(reds),
        "odd": sum(number % 2 for number in reds),
        "big": sum(number >= 17 for number in reds),
        "prime": sum(number in PRIMES for number in reds),
        "zone_max": max(zones),
        "mod_max": max(mod_counts),
        "run": _max_consecutive_run(reds),
        "tail_max": max(tail_counts.values()),
        "two_triples": _has_two_disjoint_triples(reds),
    }


def _hard_shape_reasons(
    reds: Iterable[int],
    seen_reds: set[tuple[int, ...]] | None = None,
) -> list[str]:
    """历史0次或结构上越界的硬过滤项。"""
    reds = tuple(sorted(int(number) for number in reds))
    shape = _shape_values(reds)
    reasons = []
    if seen_reds is not None and reds in seen_reds:
        reasons.append("历史已开红球组合")
    if shape["sum"] <= 28 or shape["sum"] >= 173:
        reasons.append("和值<=28或>=173")
    if shape["span"] <= 6:
        reasons.append("跨度<=6")
    if shape["ac"] <= 1 or shape["ac"] >= 11:
        reasons.append("AC值<=1或>=11")
    if shape["two_triples"]:
        reasons.append("两组独立3连号")
    if shape["run"] >= 6:
        reasons.append("6连号")
    if shape["tail_max"] >= 5:
        reasons.append("5个以上同尾")
    if shape["mod_max"] >= 6:
        reasons.append("全同012路")
    return reasons


def _quantile(values: list[int], rate: float) -> int:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("quantile values cannot be empty")
    index = max(0, min(len(ordered) - 1, int((len(ordered) - 1) * rate)))
    return ordered[index]


@dataclass
class EmpiricalState:
    """只保存回测时点之前已经开奖的统计量。"""

    draws: int = 0
    transitions: int = 0
    max_runs: Counter = field(default_factory=Counter)
    odd_counts: Counter = field(default_factory=Counter)
    big_counts: Counter = field(default_factory=Counter)
    prime_counts: Counter = field(default_factory=Counter)
    zone_max_counts: Counter = field(default_factory=Counter)
    mod_max_counts: Counter = field(default_factory=Counter)
    tail_max_counts: Counter = field(default_factory=Counter)
    ac_counts: Counter = field(default_factory=Counter)
    repeat_counts: Counter = field(default_factory=Counter)
    sums: list[int] = field(default_factory=list)
    spans: list[int] = field(default_factory=list)
    previous_reds: tuple[int, ...] | None = None

    def update(self, draw: dict) -> None:
        reds = _reds(draw)
        shape = _shape_values(reds)
        self.draws += 1
        self.max_runs[shape["run"]] += 1
        self.odd_counts[shape["odd"]] += 1
        self.big_counts[shape["big"]] += 1
        self.prime_counts[shape["prime"]] += 1
        self.zone_max_counts[shape["zone_max"]] += 1
        self.mod_max_counts[shape["mod_max"]] += 1
        self.tail_max_counts[shape["tail_max"]] += 1
        self.ac_counts[shape["ac"]] += 1
        self.sums.append(shape["sum"])
        self.spans.append(shape["span"])
        if self.previous_reds is not None:
            repeats = len(set(reds) & set(self.previous_reds))
            self.repeat_counts[repeats] += 1
            self.transitions += 1
        self.previous_reds = reds

    def rare_reasons(self, reds: Iterable[int]) -> list[str]:
        """返回在当前时点此前历史中属于低频形态的原因。"""
        if self.draws < MIN_EMPIRICAL_HISTORY:
            return []
        reds = tuple(sorted(int(number) for number in reds))
        shape = _shape_values(reds)
        reasons: list[str] = []

        run = int(shape["run"])
        if run >= 4:
            rate = sum(count for value, count in self.max_runs.items()
                       if value >= run) / self.draws
            if rate < RARE_RATE:
                reasons.append("连续号>=4")

        odd = int(shape["odd"])
        if self.odd_counts[odd] / self.draws < RARE_RATE:
            reasons.append("极端奇偶")

        for name, counter, value in (
            ("极端大小", self.big_counts, int(shape["big"])),
            ("极端质合", self.prime_counts, int(shape["prime"])),
        ):
            if counter[value] / self.draws < RARE_RATE:
                reasons.append(name)

        for name, counter, value in (
            ("单区5球以上", self.zone_max_counts, int(shape["zone_max"])),
            ("单路5球以上", self.mod_max_counts, int(shape["mod_max"])),
            ("4个以上同尾", self.tail_max_counts, int(shape["tail_max"])),
        ):
            if value >= 4:
                rate = sum(count for level, count in counter.items()
                           if level >= value) / self.draws
                if rate < RARE_RATE:
                    reasons.append(name)

        ac = int(shape["ac"])
        if self.ac_counts[ac] / self.draws < RARE_RATE:
            reasons.append("极端AC值")

        if self.previous_reds is not None and self.transitions:
            repeats = len(set(reds) & set(self.previous_reds))
            if repeats >= 4:
                rate = sum(count for value, count in self.repeat_counts.items()
                           if value >= repeats) / self.transitions
                if rate < RARE_RATE:
                    reasons.append("与上期重号>=4")

        red_sum = int(shape["sum"])
        sum_low = _quantile(self.sums, TAIL_RATE)
        sum_high = _quantile(self.sums, 1 - TAIL_RATE)
        if red_sum < sum_low or red_sum > sum_high:
            reasons.append("极端和值")

        span = int(shape["span"])
        span_low = _quantile(self.spans, TAIL_RATE)
        span_high = _quantile(self.spans, 1 - TAIL_RATE)
        if span < span_low or span > span_high:
            reasons.append("极端跨度")
        return reasons


def _ranked_v8(issue: str, history: list[dict]):
    tickets = build_v8_balanced(
        v8_rng("ssq", issue), [], 33, 6, 16, 1, 5)
    ranking = rank_tickets(tickets, history, "ssq")
    return [tickets[item["index"]] for item in ranking]


def _alternate_candidates(
    base_reds: Iterable[int],
    representative_blue: int,
    history: list[dict],
) -> list[tuple[list[int], int, int, float]]:
    """返回共享5个红球的替代组，按当时可见历史结构得分排序。"""
    base = tuple(sorted(int(number) for number in base_reds))
    candidates = []
    metadata = []
    for omitted in base:
        core = sorted(set(base) - {omitted})
        for new_number in range(1, 34):
            if new_number in base:
                continue
            alternative = sorted(core + [new_number])
            candidates.append((alternative, [representative_blue]))
            metadata.append((alternative, omitted, new_number))
    ranking = rank_tickets(candidates, history, "ssq")
    result = []
    for item in ranking:
        alternative, omitted, new_number = metadata[item["index"]]
        result.append((alternative, omitted, new_number, item["raw_score"]))
    return result


def _blue_order(ranked_v8, history: list[dict]) -> list[int]:
    order: list[int] = []
    for _, blues in ranked_v8:
        blue = int(blues[0])
        if blue not in order:
            order.append(blue)
    counts = Counter(int(draw["b1"]) for draw in history[-100:])
    for blue in sorted(range(1, 17), key=lambda value: (-counts[value], value)):
        if blue not in order:
            order.append(blue)
    return order


def _seen_blue_map(history: list[dict]) -> dict[tuple[int, ...], set[int]]:
    result: dict[tuple[int, ...], set[int]] = defaultdict(set)
    for draw in history:
        result[_reds(draw)].add(int(draw["b1"]))
    return result


def _build_dt50(
    issue: str,
    history: list[dict],
    state: EmpiricalState,
    *,
    exclude_seen: bool,
    empirical_filter: bool,
) -> tuple[list[tuple[list[int], list[int]]], dict]:
    ranked = _ranked_v8(issue, history)
    blue_order = _blue_order(ranked, history)
    seen_blues = _seen_blue_map(history) if exclude_seen else {}
    seen_reds = set(seen_blues) if exclude_seen and empirical_filter else None
    rejection_counts: Counter = Counter()
    alternate_cache = {}
    chosen = None

    for base_rank, (base_reds, base_blues) in enumerate(ranked, 1):
        base_tuple = tuple(base_reds)
        base_reasons = (
            _hard_shape_reasons(base_reds, seen_reds)
            + state.rare_reasons(base_reds)
            if empirical_filter else []
        )
        if base_reasons:
            rejection_counts.update(base_reasons)
            continue
        cache_key = (base_tuple, int(base_blues[0]))
        if cache_key not in alternate_cache:
            alternate_cache[cache_key] = _alternate_candidates(
                base_reds, int(base_blues[0]), history)
        for alternative, omitted, new_number, score in alternate_cache[cache_key]:
            reasons = (
                _hard_shape_reasons(alternative, seen_reds)
                + state.rare_reasons(alternative)
                if empirical_filter else []
            )
            if reasons:
                rejection_counts.update(reasons)
                continue
            blocked = set()
            if exclude_seen:
                blocked |= seen_blues.get(tuple(base_reds), set())
                blocked |= seen_blues.get(tuple(alternative), set())
            selected_blues = [blue for blue in blue_order if blue not in blocked][:12]
            if len(selected_blues) < 12:
                rejection_counts["历史完整组合导致蓝球不足"] += 1
                continue
            chosen = {
                "base_rank": base_rank,
                "base_reds": list(base_reds),
                "alternative_reds": list(alternative),
                "omitted": omitted,
                "new_number": new_number,
                "alternative_score": score,
                "selected_blues": selected_blues,
            }
            break
        if chosen:
            break
    if chosen is None:
        raise RuntimeError(f"{issue}: 无法构造符合筛选条件的胆拖主体")

    base_set = set(chosen["base_reds"])
    alt_set = set(chosen["alternative_reds"])
    core = sorted(base_set & alt_set)
    tuos = sorted((base_set | alt_set) - set(core))
    if len(core) != 5 or len(tuos) != 2:
        raise AssertionError("胆拖主体必须为5胆2拖")

    insurance = None
    unselected_blues = sorted(set(range(1, 17)) - set(chosen["selected_blues"]))
    insurance_options = []
    for insurance_rank, (reds, _) in enumerate(ranked, 1):
        if tuple(reds) in {tuple(chosen["base_reds"]),
                           tuple(chosen["alternative_reds"])}:
            continue
        hard_reasons = (
            _hard_shape_reasons(reds, seen_reds) if empirical_filter else [])
        if hard_reasons:
            rejection_counts.update(f"保险硬排:{reason}" for reason in hard_reasons)
            continue
        soft_reasons = state.rare_reasons(reds) if empirical_filter else []
        insurance_options.append(
            (len(soft_reasons), insurance_rank, reds, soft_reasons))

    for _, insurance_rank, reds, soft_reasons in sorted(
            insurance_options, key=lambda item: (item[0], item[1])):
        rejection_counts.update(f"保险软降权:{reason}" for reason in soft_reasons)
        candidates = unselected_blues + [
            blue for blue in range(1, 17) if blue not in unselected_blues]
        for blue in candidates:
            if exclude_seen and blue in seen_blues.get(tuple(reds), set()):
                rejection_counts["保险:历史完整组合"] += 1
                continue
            insurance = {"rank": insurance_rank, "reds": list(reds), "blue": blue}
            break
        if insurance:
            break
    if insurance is None:
        raise RuntimeError(f"{issue}: 无法构造符合筛选条件的保险单")

    tickets: list[tuple[list[int], list[int]]] = []
    for reds in (chosen["base_reds"], chosen["alternative_reds"]):
        for blue in chosen["selected_blues"]:
            tickets.append((list(reds), [blue]))
    tickets.append((insurance["reds"], [insurance["blue"]]))
    if len(tickets) != 25 or len({_ticket_key(r, b[0]) for r, b in tickets}) != 25:
        raise AssertionError("DT50必须展开为25注互不重复的基本票")
    prior_full = {_ticket_key(_reds(draw), draw["b1"]) for draw in history}
    historical_duplicates = sum(
        _ticket_key(reds, blues[0]) in prior_full for reds, blues in tickets)
    if exclude_seen and historical_duplicates:
        raise AssertionError("历史完整组合过滤未生效")

    metadata = {
        **chosen,
        "dans": core,
        "tuos": tuos,
        "insurance": insurance,
        "ticket_count": 25,
        "cost": 50,
        "historical_duplicates": historical_duplicates,
        "rejections": dict(rejection_counts),
    }
    return tickets, metadata


def _prize(red_hits: int, blue_hits: int, issue: str) -> str | None:
    standard = prize_level(red_hits, blue_hits)
    if standard:
        return standard
    if "2026014" <= issue <= "2026075" and red_hits == 3 and blue_hits == 0:
        return "福运奖"
    return None


def _settle(tickets, draw: dict, cost: int, metadata: dict | None = None) -> dict:
    actual_reds = set(_reds(draw))
    actual_blue = int(draw["b1"])
    prizes: Counter = Counter()
    max_red = 0
    for reds, blues in tickets:
        red_hits = len(set(reds) & actual_reds)
        blue_hits = int(actual_blue in blues)
        max_red = max(max_red, red_hits)
        award = _prize(red_hits, blue_hits, str(draw["issue"]))
        if award:
            prizes[award] += 1
    best = min(prizes, key=lambda name: PRIZE_RANK[name]) if prizes else None
    return {
        "issue": str(draw["issue"]),
        "best_prize": best,
        "prize_counts": dict(prizes),
        "winning_period": int(bool(prizes)),
        "third_plus": int(best in {"一等奖", "二等奖", "三等奖"}),
        "fourth_plus": int(best in {"一等奖", "二等奖", "三等奖", "四等奖"}),
        "max_red": max_red,
        "cost": cost,
        "fixed_return": sum(FIXED_PRIZE.get(name, 0) * count
                            for name, count in prizes.items()),
        "metadata": metadata or {},
    }


def _summary(rows: list[dict]) -> dict:
    prize_tickets: Counter = Counter()
    best_periods: Counter = Counter()
    rejection_counts: Counter = Counter()
    historical_duplicates = 0
    for row in rows:
        prize_tickets.update(row["prize_counts"])
        if row["best_prize"]:
            best_periods[row["best_prize"]] += 1
        metadata = row.get("metadata", {})
        rejection_counts.update(metadata.get("rejections", {}))
        historical_duplicates += metadata.get("historical_duplicates", 0)
    periods = len(rows)
    total_cost = sum(row["cost"] for row in rows)
    fixed_return = sum(row["fixed_return"] for row in rows)
    return {
        "periods": periods,
        "best_prize_period_counts": {
            name: best_periods.get(name, 0) for name in PRIZES},
        "winning_ticket_prize_counts": {
            name: prize_tickets.get(name, 0) for name in PRIZES},
        "winning_periods": sum(row["winning_period"] for row in rows),
        "winning_period_rate": sum(row["winning_period"] for row in rows) / periods,
        "third_plus_periods": sum(row["third_plus"] for row in rows),
        "third_plus_rate": sum(row["third_plus"] for row in rows) / periods,
        "fourth_plus_periods": sum(row["fourth_plus"] for row in rows),
        "fourth_plus_rate": sum(row["fourth_plus"] for row in rows) / periods,
        "red_ge4_periods": sum(row["max_red"] >= 4 for row in rows),
        "red_ge3_periods": sum(row["max_red"] >= 3 for row in rows),
        "total_cost": total_cost,
        "fixed_return": fixed_return,
        "fixed_roi": fixed_return / total_cost,
        "fixed_net": fixed_return - total_cost,
        "historical_duplicate_tickets_purchased": historical_duplicates,
        "filter_rejections": dict(rejection_counts),
    }


def _actual_history_summary(draws: list[dict]) -> dict:
    full = Counter(_ticket_key(_reds(draw), draw["b1"]) for draw in draws)
    red = Counter(_reds(draw) for draw in draws)
    return {
        "draws": len(draws),
        "full_duplicate_groups": sum(count > 1 for count in full.values()),
        "full_duplicate_extra_draws": sum(count - 1 for count in full.values()
                                          if count > 1),
        "red_duplicate_groups": sum(count > 1 for count in red.values()),
        "red_duplicate_extra_draws": sum(count - 1 for count in red.values()
                                         if count > 1),
    }


def run() -> dict:
    ssq_db.init_db()
    draws = ssq_db.get_all_draws("ASC")
    if len(draws) < 2:
        raise RuntimeError("历史数据不足")

    state = EmpiricalState()
    state.update(draws[0])
    variants = {
        "v8_5": [],
        "dt50_plain": [],
        "dt50_no_full_repeat": [],
        "dt50_empirical_filter": [],
    }
    current_example = {}

    for index in range(1, len(draws)):
        target = draws[index]
        issue = str(target["issue"])
        history = draws[:index]
        ranked = _ranked_v8(issue, history)
        variants["v8_5"].append(_settle(ranked, target, 10))

        configurations = (
            ("dt50_plain", False, False),
            ("dt50_no_full_repeat", True, False),
            ("dt50_empirical_filter", True, True),
        )
        for name, exclude_seen, empirical_filter in configurations:
            tickets, metadata = _build_dt50(
                issue, history, state,
                exclude_seen=exclude_seen,
                empirical_filter=empirical_filter,
            )
            variants[name].append(_settle(tickets, target, 50, metadata))

        state.update(target)
        if index % 250 == 0:
            print(f"已严格回测 {index}/{len(draws) - 1} 期")

    # 生成尚未开奖的当前期方案，只用于确认规则与用户已购方案一致。
    next_issue = f"{int(draws[-1]['issue']) + 1:07d}"
    current_tickets, current_metadata = _build_dt50(
        next_issue, draws, state, exclude_seen=True, empirical_filter=True)
    current_example = {
        "issue": next_issue,
        "metadata": current_metadata,
        "tickets": current_tickets,
    }

    return {
        "method": {
            "walk_forward": True,
            "no_future_data": True,
            "first_history_issue": str(draws[0]["issue"]),
            "first_predicted_issue": str(draws[1]["issue"]),
            "last_predicted_issue": str(draws[-1]["issue"]),
            "periods": len(draws) - 1,
            "dt50": "5胆+2拖+12蓝=24注，再加1注分散保险，共25注50元",
            "full_repeat_filter": "每期排除当时已经开出过的完整红球+蓝球组合",
            "empirical_filter": {
                "minimum_history": MIN_EMPIRICAL_HISTORY,
                "rare_rate": RARE_RATE,
                "tail_rate": TAIL_RATE,
                "rules": [
                    "已开红球组合", "和值<=28或>=173", "跨度<=6",
                    "AC<=1或>=11", "两组独立3连号", "6连号",
                    "5个以上同尾", "全同012路", "连续号>=4",
                    "极端奇偶/大小/质合", "单区或单路5球以上",
                    "4个以上同尾", "与上期重号>=4",
                    "和值历史两端1%", "跨度历史两端1%", "极端AC值",
                ],
            },
            "fuyun_period": "2026014-2026075，按3红0蓝且未中更高奖级计",
        },
        "actual_history": _actual_history_summary(draws),
        "summaries": {name: _summary(rows) for name, rows in variants.items()},
        "current_example": current_example,
    }


def render(report: dict) -> str:
    method = report["method"]
    summaries = report["summaries"]
    labels = {
        "v8_5": "生产V8五注(10元)",
        "dt50_plain": "DT50未过滤",
        "dt50_no_full_repeat": "DT50仅排历史完整重复",
        "dt50_empirical_filter": "DT50完整低频过滤",
    }
    keys = list(labels)
    lines = [
        "# 双色球 V8-DT50 全历史严格滚动回测",
        "",
        "## 回测口径",
        "",
        f"- 第一期 {method['first_history_issue']} 作为首个已知历史，预测 "
        f"{method['first_predicted_issue']}；一直滚动到 {method['last_predicted_issue']}，"
        f"共 {method['periods']} 个真实样本外目标期。",
        "- 每一期生成、排序、过滤只读取该期之前的开奖；目标期及未来开奖不参与选号。",
        f"- DT50结构：{method['dt50']}。",
        f"- 完整组合过滤：{method['full_repeat_filter']}。",
        "- 硬过滤包括已开红球组合、和值/跨度/AC越界、两组独立3连号、6连号、"
        "5个以上同尾、全同012路；累计100期后再对连续4号以上、极端比例、"
        "单区/单路集中、重号及和值/跨度/AC低频端进行过滤或降权。",
        "- 一等奖、二等奖为浮动奖，仅统计次数；固定奖金回报不包含这两个浮动奖。",
        "",
        "## 每期最高奖级次数",
        "",
        "同一期出现多张中奖彩票时，只按其中最高奖级计为1期。",
        "",
        "| 最高奖级 | " + " | ".join(labels[key] for key in keys) + " |",
        "|---|" + "---:|" * len(keys),
    ]
    for prize in PRIZES:
        values = [summaries[key]["best_prize_period_counts"][prize] for key in keys]
        lines.append(f"| {prize} | " + " | ".join(map(str, values)) + " |")

    lines.extend([
        "",
        "## 所有中奖彩票注数",
        "",
        "这里按展开后的每一注基本票分别计数，因此胆拖同一期可能同时中多注。",
        "",
        "| 奖级 | " + " | ".join(labels[key] for key in keys) + " |",
        "|---|" + "---:|" * len(keys),
    ])
    for prize in PRIZES:
        values = [summaries[key]["winning_ticket_prize_counts"][prize] for key in keys]
        lines.append(f"| {prize} | " + " | ".join(map(str, values)) + " |")

    lines.extend([
        "",
        "## 汇总",
        "",
        "| 指标 | " + " | ".join(labels[key] for key in keys) + " |",
        "|---|" + "---:|" * len(keys),
    ])
    rows = [
        ("三等奖以上期数", "third_plus_periods", "count"),
        ("三等奖以上期率", "third_plus_rate", "percent"),
        ("四等奖以上期数", "fourth_plus_periods", "count"),
        ("中奖期数", "winning_periods", "count"),
        ("中奖期率", "winning_period_rate", "percent"),
        ("总投入", "total_cost", "money"),
        ("固定奖金", "fixed_return", "money"),
        ("固定奖金回报率", "fixed_roi", "percent"),
        ("买到历史已开完整组合的注数", "historical_duplicate_tickets_purchased", "count"),
    ]
    for label, field_name, fmt in rows:
        values = []
        for key in keys:
            value = summaries[key][field_name]
            if fmt == "percent":
                values.append(f"{value:.3%}")
            elif fmt == "money":
                values.append(f"{value:,}元")
            else:
                values.append(f"{value:,}")
        lines.append(f"| {label} | " + " | ".join(values) + " |")

    actual = report["actual_history"]
    current = report["current_example"]
    meta = current["metadata"]
    lines.extend([
        "",
        "## 历史重复与生产V8基准方案复核",
        "",
        f"- 历史 {actual['draws']} 期完整红蓝重复组：{actual['full_duplicate_groups']}；"
        f"仅红球重复组：{actual['red_duplicate_groups']}。",
        f"- 以下仅是生产V8-DT50基准构造复核，不是本次最终追加购买号码。"
        f"待开奖 {current['issue']}：红胆 "
        f"{' '.join(f'{n:02d}' for n in meta['dans'])}；红拖 "
        f"{' '.join(f'{n:02d}' for n in meta['tuos'])}；蓝球 "
        f"{' '.join(f'{n:02d}' for n in meta['selected_blues'])}。",
        f"- 保险单：{' '.join(f'{n:02d}' for n in meta['insurance']['reds'])} + "
        f"{meta['insurance']['blue']:02d}；历史完整重复注数 "
        f"{meta['historical_duplicates']}。",
        "",
        "## 结论读取原则",
        "",
        "以‘完整低频过滤’和‘仅排历史完整重复’的真实差值判断过滤是否有效；"
        "若奖级次数没有稳定增加，就不能仅凭过滤逻辑把它视作已验证提升。",
        "",
    ])
    return "\n".join(lines)


def main() -> None:
    report = run()
    json_path = Path(DATA_ROOT) / "ssq_dantuo50_backtest_results.json"
    md_path = Path(DATA_ROOT) / "ssq_dantuo50_backtest_report.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf8")
    md_path.write_text(render(report), encoding="utf8")
    print(f"回测完成：{json_path}")
    print(f"报告完成：{md_path}")


if __name__ == "__main__":
    main()
