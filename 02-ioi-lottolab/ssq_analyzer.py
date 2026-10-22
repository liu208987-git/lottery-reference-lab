# -*- coding: utf-8 -*-
"""福彩双色球 规则、走势特征计算与概率预测

中奖规则（前区6个号码01-33，后区1个号码01-16）：
    一等奖 6+1   浮动(最高1000万)
    二等奖 6+0   浮动
    三等奖 5+1   3000元
    四等奖 5+0 / 4+1   200元
    五等奖 4+0 / 3+1   10元
    六等奖 2+1 / 1+1 / 0+1   5元

区间划分：一区01-11 / 二区12-22 / 三区23-33（各11个号码）。
奇偶比：前区6个号码中奇:偶，和为6。

说明：彩票为独立随机事件，历史走势不改变未来概率。本模块仅基于历史频率/遗漏
做统计参考，不构成任何中奖保证。单注6+1理论命中概率约 1/17,721,088。
"""
from collections import Counter
from itertools import combinations
from lottery_predictor import build_prediction

# ---------------- 规则 ----------------
RED_POOL = list(range(1, 34))      # 01-33
BLUE_POOL = list(range(1, 17))     # 01-16
PICK_RED = 6
PICK_BLUE = 1


def prize_level(reds_hit, blues_hit):
    """根据命中前区/后区个数返回奖级字符串。"""
    r, b = reds_hit, blues_hit
    if (r, b) == (6, 1):
        return "一等奖"
    if (r, b) == (6, 0):
        return "二等奖"
    if (r, b) == (5, 1):
        return "三等奖"
    if (r, b) in [(5, 0), (4, 1)]:
        return "四等奖"
    if (r, b) in [(4, 0), (3, 1)]:
        return "五等奖"
    if (r, b) in [(2, 1), (1, 1), (0, 1)]:
        return "六等奖"
    return "未中奖"


# ---------------- 单期特征 ----------------
def features(reds):
    """返回单期前区特征 dict。"""
    reds = sorted(reds)
    s = sum(reds)
    span = reds[-1] - reds[0]
    zone = [0, 0, 0]
    for x in reds:
        if x <= 11:
            zone[0] += 1
        elif x <= 22:
            zone[1] += 1
        else:
            zone[2] += 1
    odd = sum(1 for x in reds if x % 2 == 1)
    return {
        "sum": s,
        "span": span,
        "zone_ratio": f"{zone[0]}:{zone[1]}:{zone[2]}",
        "odd_even": f"{odd}:{6 - odd}",
        "has_consec": any(reds[i + 1] - reds[i] == 1 for i in range(5)),
    }


# ---------------- 历史统计分析 ----------------
class Analyzer:
    def __init__(self, draws):
        """draws: list[dict]，每条含 r1..r6,b1，按期号升序。"""
        self.draws = draws
        self.reds_seq = []
        self.blues_seq = []
        for d in draws:
            r = sorted([d["r1"], d["r2"], d["r3"], d["r4"], d["r5"], d["r6"]])
            b = [d["b1"]]
            self.reds_seq.append(r)
            self.blues_seq.append(b)
        self.n = len(draws)

    # ----- 号码频率/遗漏 -----
    def red_frequency(self, recent=None):
        seq = self.reds_seq[-recent:] if recent else self.reds_seq
        freq = Counter()
        for r in seq:
            freq.update(r)
        return {n: freq.get(n, 0) for n in RED_POOL}

    def blue_frequency(self, recent=None):
        seq = self.blues_seq[-recent:] if recent else self.blues_seq
        freq = Counter()
        for b in seq:
            freq.update(b)
        return {n: freq.get(n, 0) for n in BLUE_POOL}

    def red_omission(self):
        """每个前区号码的当前遗漏期数(0表示最近一期命中)。"""
        om = {n: self.n for n in RED_POOL}
        for i in range(self.n - 1, -1, -1):
            hit = set(self.reds_seq[i])
            for n in list(om.keys()):
                if n in hit and om[n] == self.n:
                    om[n] = self.n - 1 - i
        return om

    def blue_omission(self):
        om = {n: self.n for n in BLUE_POOL}
        for i in range(self.n - 1, -1, -1):
            hit = set(self.blues_seq[i])
            for n in list(om.keys()):
                if n in hit and om[n] == self.n:
                    om[n] = self.n - 1 - i
        return om

    def red_mean_gap(self):
        idx = {n: [] for n in RED_POOL}
        for i, r in enumerate(self.reds_seq):
            for x in set(r):
                idx[x].append(i)
        gap = {}
        for n in RED_POOL:
            pos = idx[n]
            if len(pos) < 2:
                gap[n] = self.n / max(len(pos), 1)
            else:
                diffs = [pos[k + 1] - pos[k] for k in range(len(pos) - 1)]
                gap[n] = sum(diffs) / len(diffs)
        return gap

    def blue_mean_gap(self):
        idx = {n: [] for n in BLUE_POOL}
        for i, b in enumerate(self.blues_seq):
            for x in set(b):
                idx[x].append(i)
        gap = {}
        for n in BLUE_POOL:
            pos = idx[n]
            if len(pos) < 2:
                gap[n] = self.n / max(len(pos), 1)
            else:
                diffs = [pos[k + 1] - pos[k] for k in range(len(pos) - 1)]
                gap[n] = sum(diffs) / len(diffs)
        return gap

    # ----- 走势分布 -----
    def sum_distribution(self, bin_size=10):
        sums = [sum(r) for r in self.reds_seq]
        return self._bin_dist(sums, bin_size, lo=21)

    def span_distribution(self, bin_size=5):
        spans = [max(r) - min(r) for r in self.reds_seq]
        return self._bin_dist(spans, bin_size, lo=5)

    @staticmethod
    def _bin_dist(values, bin_size, lo):
        bins = Counter()
        for v in values:
            start = ((v - lo) // bin_size) * bin_size + lo
            bins[start] += 1
        return dict(sorted(bins.items()))

    def zone_ratio_dist(self):
        c = Counter(features(r)["zone_ratio"] for r in self.reds_seq)
        return dict(c.most_common())

    def odd_even_dist(self):
        c = Counter(features(r)["odd_even"] for r in self.reds_seq)
        return dict(c.most_common())

    def repeat_rate(self):
        if self.n < 2:
            return 0.0
        cnt = 0
        for i in range(1, self.n):
            if set(self.reds_seq[i]) & set(self.reds_seq[i - 1]):
                cnt += 1
        return cnt / (self.n - 1)

    def consec_rate(self):
        if self.n == 0:
            return 0.0
        return sum(1 for r in self.reds_seq if features(r)["has_consec"]) / self.n

    # ---------------- 预测 ----------------
    def predict(self, recent=50, use_quant_gate=True):
        """生成无偏单注及低重叠的完整多注组合。"""
        return build_prediction(
            self, game="ssq", red_pool=33, red_pick=6,
            blue_pool=16, blue_pick=1, feature_func=features,
            recent=recent, ticket_count=5, use_quant_gate=use_quant_gate)

    def legacy_predict(self, recent=50):
        """旧版热度、近期频率与遗漏回补启发式，仅供回测比较。"""
        if self.n < 10:
            return None

        n_all = self.n
        n_rec = min(recent, n_all)
        red_freq_all = self.red_frequency()
        red_freq_rec = self.red_frequency(n_rec)
        red_om = self.red_omission()
        red_gap = self.red_mean_gap()

        blue_freq_all = self.blue_frequency()
        blue_freq_rec = self.blue_frequency(n_rec)
        blue_om = self.blue_omission()
        blue_gap = self.blue_mean_gap()

        def norm(d):
            lo, hi = min(d.values()), max(d.values())
            return {k: (v - lo) / (hi - lo) if hi > lo else 0.5 for k, v in d.items()}

        red_all_n = norm(red_freq_all)
        red_rec_n = {k: red_freq_rec[k] / (n_rec * PICK_RED / 33) for k in RED_POOL}
        red_rec_n = norm(red_rec_n)
        red_due = {n: min(red_om[n] / red_gap[n], 2.0) if red_gap[n] > 0 else 0.5
                   for n in RED_POOL}
        red_due_n = norm(red_due)
        red_scores = {n: 0.35 * red_all_n[n] + 0.35 * red_rec_n[n] + 0.30 * red_due_n[n]
                      for n in RED_POOL}

        blue_all_n = norm(blue_freq_all)
        blue_rec_n = {k: blue_freq_rec[k] / (n_rec * PICK_BLUE / 16) for k in BLUE_POOL}
        blue_rec_n = norm(blue_rec_n)
        blue_due = {n: min(blue_om[n] / blue_gap[n], 2.0) if blue_gap[n] > 0 else 0.5
                    for n in BLUE_POOL}
        blue_due_n = norm(blue_due)
        blue_scores = {n: 0.35 * blue_all_n[n] + 0.35 * blue_rec_n[n] + 0.30 * blue_due_n[n]
                       for n in BLUE_POOL}

        # 走势分布众数
        sum_dist = self.sum_distribution()
        sum_mode_lo = max(sum_dist, key=sum_dist.get)
        sum_mode_center = sum_mode_lo + 5
        span_dist = self.span_distribution()
        span_mode_lo = max(span_dist, key=span_dist.get)
        zone_dist = self.zone_ratio_dist()
        zone_mode = next(iter(zone_dist))
        oe_dist = self.odd_even_dist()
        oe_mode = next(iter(oe_dist))
        rep_rate = self.repeat_rate()
        cons_rate = self.consec_rate()

        # 候选池：得分前12，枚举 C(12,6)=924
        pool = sorted(RED_POOL, key=lambda n: red_scores[n], reverse=True)[:12]

        best = None
        best_score = -1
        all_combos = []
        for combo in combinations(pool, 6):
            combo = tuple(sorted(combo))
            f = features(combo)
            base = sum(red_scores[n] for n in combo) / 6
            sum_bonus = max(0.0, 1.0 - abs(f["sum"] - sum_mode_center) / 25.0)
            zone_bonus = 1.0 if f["zone_ratio"] == zone_mode else 0.3
            oe_bonus = 1.0 if f["odd_even"] == oe_mode else 0.4
            cons_bonus = 0.6 if f["has_consec"] else 0.4
            score = base + 0.6 * sum_bonus + 0.5 * zone_bonus + 0.5 * oe_bonus + cons_rate * cons_bonus
            all_combos.append((combo, score, f))
            if score > best_score:
                best_score = score
                best = (combo, score, f)

        all_combos.sort(key=lambda x: x[1], reverse=True)
        alts = []
        for combo, score, f in all_combos:
            if any(len(set(combo) & set(a[0])) >= 5 for a in alts):
                continue
            alts.append((combo, score, f))
            if len(alts) >= 4:
                break

        reds = list(best[0])
        blues = [sorted(BLUE_POOL, key=lambda n: blue_scores[n], reverse=True)[0]]

        # 推理说明
        reasons = self._build_reasons(
            reds, blues, red_scores, blue_scores,
            red_freq_all, red_freq_rec, red_om, red_gap,
            blue_freq_all, blue_om, blue_gap,
            best[2], sum_mode_lo, span_mode_lo, zone_mode, oe_mode,
            sum_dist, span_dist, zone_dist, oe_dist,
            rep_rate, cons_rate, n_rec)

        # 备选组合说明
        alt_lines = ["【备选前区组合】"]
        for i, (combo, score, ff) in enumerate(alts, 1):
            alt_lines.append(
                f"  备选{i}：{' '.join(f'{n:02d}' for n in combo)} "
                f"和值{ff['sum']} 跨度{ff['span']} 区间{ff['zone_ratio']} 奇偶{ff['odd_even']}"
                f"（综合分{score:.3f}）")

        forecast = {
            "sum_range": f"{sum_mode_lo}-{sum_mode_lo + 9}",
            "span_range": f"{span_mode_lo}-{span_mode_lo + 4}",
            "zone_mode": zone_mode,
            "odd_even_mode": oe_mode,
            "sum_dist": sum_dist,
            "span_dist": span_dist,
            "zone_dist": zone_dist,
            "oe_dist": oe_dist,
        }

        return {
            "reds": reds,
            "blues": blues,
            "alternatives": alts,
            "red_scores": red_scores,
            "blue_scores": blue_scores,
            "red_omission": red_om,
            "blue_omission": blue_om,
            "forecast": forecast,
            "reasons": reasons + alt_lines,
            "sample_size": n_all,
            "recent_window": n_rec,
        }

    def _build_reasons(self, reds, blues, red_scores, blue_scores,
                       red_freq_all, red_freq_rec, red_om, red_gap,
                       blue_freq_all, blue_om, blue_gap,
                       f, sum_mode_lo, span_mode_lo, zone_mode, oe_mode,
                       sum_dist, span_dist, zone_dist, oe_dist,
                       rep_rate, cons_rate, n_rec):
        rs = []
        rs.append(f"【样本】历史 {self.n} 期，近期窗口 {n_rec} 期。")
        rs.append("【方法】前区单号得分 = 0.35×历史频率 + 0.35×近期频率 + 0.30×遗漏回补；"
                  "组合再按和值/区间比/奇偶比贴近历史众数加权。")
        rs.append("声明：彩票为独立随机事件，以下仅为统计参考，不保证中奖。")

        scored = sorted(reds, key=lambda n: red_scores[n], reverse=True)
        top5 = sorted(RED_POOL, key=lambda n: red_scores[n], reverse=True)[:5]
        rs.append(f"【前区推荐】{' '.join(f'{n:02d}' for n in reds)}")
        detail = "、".join(
            f"{n:02d}(得分{red_scores[n]:.2f},遗漏{red_om[n]}期/均值{red_gap[n]:.1f}期)"
            for n in scored)
        rs.append(f"  号码依据：{detail}")
        rs.append(f"  全局得分前5：{' '.join(f'{n:02d}' for n in top5)}")

        sum_pct = sum_dist.get(sum_mode_lo, 0) / self.n * 100
        rs.append(f"【和值】{f['sum']}，历史高频区间 {sum_mode_lo}-{sum_mode_lo+9}（占比{sum_pct:.1f}%），"
                  f"本期{'命中' if sum_mode_lo <= f['sum'] <= sum_mode_lo+9 else '偏离'}该区间。")
        sp_pct = span_dist.get(span_mode_lo, 0) / self.n * 100
        rs.append(f"【跨度】{f['span']}，历史高频跨度 {span_mode_lo}-{span_mode_lo+4}"
                  f"（占比{sp_pct:.1f}%）。")
        z_pct = zone_dist.get(zone_mode, 0) / self.n * 100
        rs.append(f"【区间比】{f['zone_ratio']}，历史最常见 {zone_mode}（占比{z_pct:.1f}%），"
                  f"本期{'一致' if f['zone_ratio'] == zone_mode else '不同'}。"
                  f"（一区01-11 / 二区12-22 / 三区23-33）")
        oe_pct = oe_dist.get(oe_mode, 0) / self.n * 100
        rs.append(f"【奇偶比】{f['odd_even']}，历史最常见 {oe_mode}（占比{oe_pct:.1f}%），"
                  f"本期{'一致' if f['odd_even'] == oe_mode else '不同'}。")
        rs.append(f"【连号】{'含连号' if f['has_consec'] else '无连号'}；"
                  f"历史连号率 {cons_rate*100:.1f}%，重号率 {rep_rate*100:.1f}%。")

        rs.append(f"【后区推荐】{blues[0]:02d}")
        b = blues[0]
        rs.append(f"  号码依据：{b:02d}(得分{blue_scores[b]:.2f},"
                  f"遗漏{blue_om[b]}期/均值{blue_gap[b]:.1f}期)")
        return rs
