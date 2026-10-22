# -*- coding: utf-8 -*-
"""体彩大乐透 可视化窗口（Tkinter + matplotlib）

功能：
  - 启动自动增量同步历史数据并重新训练量化门控
  - 预测推荐：展示推荐号码、推理原因、走势预测(和值/跨度/区间比/奇偶比)
  - 走势图：和值、跨度、区间比、奇偶比、号码频率
  - 历史数据表
  - 手动录入历史期号
"""
import threading
import tkinter as tk
from tkinter import ttk, messagebox

import matplotlib
matplotlib.use("TkAgg")
matplotlib.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
matplotlib.rcParams["axes.unicode_minus"] = False
from matplotlib.figure import Figure
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg

import dlt_db as db
from dlt_analyzer import Analyzer
from history_sources import sync_game
from model_training import train_and_save
from dlt_prediction_audit import next_issue, record_prediction, settle_available

RED_COLOR = "#E63946"
BLUE_COLOR = "#1D6FB8"
BG = "#F5F6FA"


class BallLabel(tk.Label):
    """球形号码标签。"""
    def __init__(self, master, number, color, size=44):
        super().__init__(master, text=f"{number:02d}", bg=color, fg="white",
                         font=("Microsoft YaHei", 16, "bold"),
                         width=2, height=1, relief="flat", bd=0)
        self.configure(padx=6, pady=6)


class App:
    def __init__(self, root):
        self.root = root
        self.root.title("体彩大乐透 历史分析与预测")
        self.root.geometry("1180x760")
        self.root.configure(bg=BG)
        self.prediction = None
        self.analyzer = None

        self._build_toolbar()
        self._build_notebook()
        self.refresh_status()
        # 启动后自动补全遗漏
        self.root.after(300, self.auto_update)

    # ---------------- 顶栏 ----------------
    def _build_toolbar(self):
        bar = tk.Frame(self.root, bg="#2C3E50", height=56)
        bar.pack(side="top", fill="x")
        tk.Label(bar, text="大乐透 分析预测系统", bg="#2C3E50", fg="white",
                 font=("Microsoft YaHei", 16, "bold")).pack(side="left", padx=16, pady=10)

        self.status_var = tk.StringVar(value="就绪")
        tk.Label(bar, textvariable=self.status_var, bg="#2C3E50", fg="#BDC3C7",
                 font=("Microsoft YaHei", 10)).pack(side="left", padx=10)

        btns = tk.Frame(bar, bg="#2C3E50")
        btns.pack(side="right", padx=12)
        ttk.Button(btns, text="更新数据", command=self.on_update).pack(side="left", padx=4)
        ttk.Button(btns, text="生成预测", command=self.on_predict).pack(side="left", padx=4)

    def _build_notebook(self):
        self.nb = ttk.Notebook(self.root)
        self.nb.pack(fill="both", expand=True, padx=8, pady=8)
        self.pred_tab = tk.Frame(self.nb, bg=BG); self.nb.add(self.pred_tab, text="预测推荐")
        self.trend_tab = tk.Frame(self.nb, bg=BG); self.nb.add(self.trend_tab, text="走势图")
        self.hist_tab = tk.Frame(self.nb, bg=BG); self.nb.add(self.hist_tab, text="历史数据")
        self.input_tab = tk.Frame(self.nb, bg=BG); self.nb.add(self.input_tab, text="手动录入")

        self._build_pred_tab()
        self._build_trend_tab()
        self._build_hist_tab()
        self._build_input_tab()

    # ---------------- 预测页 ----------------
    def _build_pred_tab(self):
        top = tk.Frame(self.pred_tab, bg=BG)
        top.pack(fill="x", padx=16, pady=12)

        tk.Label(top, text="本期推荐号码", bg=BG, fg="#2C3E50",
                 font=("Microsoft YaHei", 13, "bold")).pack(anchor="w")

        self.ball_row = tk.Frame(top, bg=BG)
        self.ball_row.pack(anchor="w", pady=8)
        self.ball_widgets = []
        for i in range(7):
            color = RED_COLOR if i < 5 else BLUE_COLOR
            lab = BallLabel(self.ball_row, 0, color)
            lab.grid(row=0, column=i, padx=4)
            self.ball_widgets.append(lab)
        tk.Label(self.ball_row, text="  前5红 + 后2蓝", bg=BG, fg="#7F8C8D",
                 font=("Microsoft YaHei", 9)).grid(row=0, column=7, padx=6)

        # 走势预测摘要
        fc = tk.Frame(self.pred_tab, bg="#FFFFFF", relief="groove", bd=1)
        fc.pack(fill="x", padx=16, pady=4)
        self.forecast_vars = {}
        labels = [("和值预测区间", "sum"), ("跨度预测区间", "span"),
                  ("区间比众数", "zone"), ("奇偶比众数", "oe")]
        for i, (text, key) in enumerate(labels):
            tk.Label(fc, text=text, bg="white", fg="#555",
                     font=("Microsoft YaHei", 10)).grid(row=0, column=i * 2, padx=(12, 4), pady=10, sticky="w")
            v = tk.StringVar(value="—")
            tk.Label(fc, textvariable=v, bg="white", fg="#E63946",
                     font=("Microsoft YaHei", 12, "bold")).grid(row=0, column=i * 2 + 1, padx=4, pady=10, sticky="w")
            self.forecast_vars[key] = v

        body = tk.Frame(self.pred_tab, bg=BG)
        body.pack(fill="both", expand=True, padx=16, pady=8)
        tk.Label(body, text="预测推理原因", bg=BG, fg="#2C3E50",
                 font=("Microsoft YaHei", 12, "bold")).pack(anchor="w")
        self.reason_txt = tk.Text(body, wrap="word", relief="groove", bd=1,
                                  font=("Microsoft YaHei", 10), bg="white")
        self.reason_txt.pack(fill="both", expand=True, pady=6)
        self.reason_txt.configure(state="disabled")

    def _set_balls(self, reds, blues):
        for i, n in enumerate(reds):
            self.ball_widgets[i].configure(text=f"{n:02d}", bg=RED_COLOR)
        for i, n in enumerate(blues):
            self.ball_widgets[5 + i].configure(text=f"{n:02d}", bg=BLUE_COLOR)

    def _show_prediction(self, p):
        self.prediction = p
        self._set_balls(p["reds"], p["blues"])
        self.forecast_vars["sum"].set(p["forecast"]["sum_range"])
        self.forecast_vars["span"].set(p["forecast"]["span_range"])
        self.forecast_vars["zone"].set(p["forecast"]["zone_mode"])
        self.forecast_vars["oe"].set(p["forecast"]["odd_even_mode"])
        self.reason_txt.configure(state="normal")
        self.reason_txt.delete("1.0", "end")
        for line in p["reasons"]:
            self.reason_txt.insert("end", line + "\n")
        self.reason_txt.configure(state="disabled")

    # ---------------- 走势图页 ----------------
    def _build_trend_tab(self):
        self.trend_fig = Figure(figsize=(11, 7), dpi=100)
        self.trend_canvas = FigureCanvasTkAgg(self.trend_fig, master=self.trend_tab)
        self.trend_canvas.get_tk_widget().pack(fill="both", expand=True)
        ctrl = tk.Frame(self.trend_tab, bg=BG)
        ctrl.pack(fill="x")
        tk.Label(ctrl, text="显示期数:", bg=BG).pack(side="left", padx=(8, 4), pady=4)
        self.trend_n_var = tk.IntVar(value=100)
        ttk.Spinbox(ctrl, from_=20, to=500, increment=10, width=6,
                    textvariable=self.trend_n_var).pack(side="left")
        ttk.Button(ctrl, text="刷新走势", command=self.draw_trends).pack(side="left", padx=8)

    def draw_trends(self):
        draws = db.get_all_draws("ASC")
        if not draws:
            return
        a = Analyzer(draws)
        n = min(self.trend_n_var.get(), len(draws))
        recent = draws[-n:]
        fig = self.trend_fig
        fig.clear()
        gs = fig.add_gridspec(3, 2, hspace=0.55, wspace=0.3)

        # 1 和值走势
        ax1 = fig.add_subplot(gs[0, 0])
        sums = [d["red_sum"] for d in recent]
        ax1.plot(range(n), sums, color=RED_COLOR, linewidth=1.2)
        ax1.axhline(sum(sums) / len(sums), color="gray", linestyle="--", linewidth=1, label="均值")
        ax1.set_title(f"前区和值走势（近{n}期）", fontsize=10)
        ax1.legend(fontsize=8)
        ax1.grid(alpha=0.3)

        # 2 跨度走势
        ax2 = fig.add_subplot(gs[0, 1])
        spans = [d["red_span"] for d in recent]
        ax2.plot(range(n), spans, color=BLUE_COLOR, linewidth=1.2)
        ax2.set_title(f"前区跨度走势（近{n}期）", fontsize=10)
        ax2.grid(alpha=0.3)

        # 3 区间比分布
        ax3 = fig.add_subplot(gs[1, 0])
        zd = a.zone_ratio_dist()
        items = list(zd.items())[:8]
        ax3.bar(range(len(items)), list(zd.values())[:8], color="#27AE60")
        ax3.set_xticks(range(len(items)))
        ax3.set_xticklabels([k for k, _ in items], rotation=30, fontsize=8)
        ax3.set_title("区间比分布", fontsize=10)
        ax3.grid(alpha=0.3, axis="y")

        # 4 奇偶比分布
        ax4 = fig.add_subplot(gs[1, 1])
        od = a.odd_even_dist()
        ax4.bar(list(od.keys()), list(od.values()), color="#8E44AD")
        ax4.set_title("奇偶比分布", fontsize=10)
        ax4.grid(alpha=0.3, axis="y")

        # 5 前区号码频率
        ax5 = fig.add_subplot(gs[2, :])
        freq = a.red_frequency()
        xs = list(range(1, 36))
        ax5.bar(xs, [freq[x] for x in xs], color=RED_COLOR)
        ax5.set_xticks(xs)
        ax5.set_xticklabels([f"{x:02d}" for x in xs], fontsize=7)
        ax5.set_title("前区号码出现频率（全部历史）", fontsize=10)
        ax5.grid(alpha=0.3, axis="y")

        self.trend_canvas.draw()

    # ---------------- 历史数据页 ----------------
    def _build_hist_tab(self):
        cols = ("期号", "前区", "后区", "和值", "跨度", "区间比", "奇偶比")
        self.tree = ttk.Treeview(self.hist_tab, columns=cols, show="headings")
        widths = [90, 160, 90, 60, 60, 80, 80]
        for c, w in zip(cols, widths):
            self.tree.column(c, width=w, anchor="center")
            self.tree.heading(c, text=c)
        vsb = ttk.Scrollbar(self.hist_tab, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        vsb.pack(side="right", fill="y")
        self.tree.pack(fill="both", expand=True)

    def refresh_history(self):
        for item in self.tree.get_children():
            self.tree.delete(item)
        draws = db.get_all_draws("DESC")
        for d in draws:
            reds = f"{d['r1']:02d} {d['r2']:02d} {d['r3']:02d} {d['r4']:02d} {d['r5']:02d}"
            blues = f"{d['b1']:02d} {d['b2']:02d}"
            self.tree.insert("", "end", values=(d["issue"], reds, blues,
                                                d["red_sum"], d["red_span"],
                                                d["zone_ratio"], d["odd_even"]))

    # ---------------- 手动录入页 ----------------
    def _build_input_tab(self):
        f = tk.Frame(self.input_tab, bg=BG)
        f.pack(padx=20, pady=30, anchor="w")
        tk.Label(f, text="期号(7位):", bg=BG).grid(row=0, column=0, sticky="w", pady=6)
        self.in_issue = tk.StringVar()
        ttk.Entry(f, textvariable=self.in_issue, width=12).grid(row=0, column=1, padx=8)

        tk.Label(f, text="前区(01-35, 5个):", bg=BG).grid(row=1, column=0, sticky="w", pady=6)
        self.in_reds = tk.StringVar()
        ttk.Entry(f, textvariable=self.in_reds, width=30).grid(row=1, column=1, padx=8)
        tk.Label(f, text="例: 03 11 18 25 34", bg=BG, fg="#95A5A6").grid(row=1, column=2)

        tk.Label(f, text="后区(01-12, 2个):", bg=BG).grid(row=2, column=0, sticky="w", pady=6)
        self.in_blues = tk.StringVar()
        ttk.Entry(f, textvariable=self.in_blues, width=30).grid(row=2, column=1, padx=8)
        tk.Label(f, text="例: 04 09", bg=BG, fg="#95A5A6").grid(row=2, column=2)

        ttk.Button(f, text="保存到数据库", command=self.on_manual_save).grid(row=3, column=1, pady=16, sticky="w")

    def on_manual_save(self):
        issue = self.in_issue.get().strip()
        try:
            reds = sorted(int(x) for x in self.in_reds.get().replace(",", " ").split())
            blues = sorted(int(x) for x in self.in_blues.get().replace(",", " ").split())
            if len(issue) != 7 or not issue.isdigit():
                raise ValueError("期号需为7位数字")
            if len(reds) != 5 or len(set(reds)) != 5 or not all(1 <= x <= 35 for x in reds):
                raise ValueError("前区需为5个01-35的不重复号码")
            if len(blues) != 2 or len(set(blues)) != 2 or not all(1 <= x <= 12 for x in blues):
                raise ValueError("后区需为2个01-12的不重复号码")
            db.upsert_draw(issue, reds, blues)
            messagebox.showinfo("成功", f"已保存 {issue} 期")
            self.in_issue.set(""); self.in_reds.set(""); self.in_blues.set("")
            self.refresh_status(); self.refresh_history()
        except Exception as e:
            messagebox.showerror("输入错误", str(e))

    # ---------------- 通用 ----------------
    def refresh_status(self):
        lo, hi = db.get_issue_range()
        cnt = db.get_count()
        self.status_var.set(f"数据库 {cnt} 期 | 范围 {lo}-{hi}")

    def _run_async(self, task, on_done_msg=None):
        """后台线程执行 task()，完成后回主线程刷新。"""
        self.status_var.set("正在处理...")

        def worker():
            try:
                result = task()
                msg = on_done_msg(result) if on_done_msg else "完成"
                self.root.after(0, lambda: self._after_task(True, msg, result))
            except Exception as e:
                self.root.after(0, lambda: self._after_task(False, str(e), None))

        threading.Thread(target=worker, daemon=True).start()

    def _after_task(self, ok, msg, result):
        if ok:
            self.refresh_status()
            self.refresh_history()
            self.draw_trends()
            self.status_var.set(msg)
        else:
            self.status_var.set("出错: " + msg)
            messagebox.showerror("错误", msg)

    def auto_update(self):
        """启动后同步新数据，并将完整样本重新纳入模型训练。"""
        self._run_async(
            lambda: self._do_scrape(500),
            lambda r: self._sync_message("自动更新完成", r))

    def on_update(self):
        self._run_async(
            lambda: self._do_scrape(500),
            lambda r: self._sync_message("更新完成", r))

    def _do_scrape(self, count):
        report = sync_game("dlt", db)
        rows = db.get_all_draws("ASC")
        report["settled_predictions"] = settle_available(rows)
        state = train_and_save("dlt", rows)
        report["models"] = (state["red"]["selected_model"],
                            state["blue"]["selected_model"])
        return report

    @staticmethod
    def _sync_message(prefix, report):
        models = "/".join(report["models"])
        return (f"{prefix}：新增 {report['added']} 期，共 {report['total']} 期；"
                f"自学习模型 {models}")

    def on_predict(self):
        draws = db.get_all_draws("ASC")
        if len(draws) < 10:
            messagebox.showwarning("数据不足", "历史数据不足10期，请先更新数据。")
            return
        self.analyzer = Analyzer(draws)
        p = self.analyzer.predict()
        if p is None:
            messagebox.showwarning("无法预测", "数据不足。")
            return
        self._show_prediction(p)
        target_issue = next_issue(draws[-1]["issue"])
        record_prediction(
            target_issue, p["model"], draws[-1]["issue"], p["tickets"],
            model_info={
                "red": p["quant_diagnostics"]["red"]["selected_model"],
                "blue": p["quant_diagnostics"]["blue"]["selected_model"],
            },
        )
        self.draw_trends()
        self.status_var.set(f"预测已生成（基于 {p['sample_size']} 期，近期窗口 {p['recent_window']} 期）")


def launch():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    launch()
