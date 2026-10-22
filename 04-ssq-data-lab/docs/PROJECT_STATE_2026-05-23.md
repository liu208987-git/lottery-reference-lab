# 项目当前状态 · 2026-05-23

## 概览
**双色球 / 大乐透数据实验室**：纯静态站点，零构建，零依赖。三大核心：
1. **统计层** — 卡方 / Beta-Bin / DPP / MCMC / 共现 lift / 时序
2. **神经网络层** — 纯手写 LSTM (BPTT)，多层堆叠 + dropout + ensemble + label smoothing + temperature scaling + LCB
3. **数据层** — Python 抓 500.com，GitHub Action 周期更新

**部署**：GitHub Pages + Cloudflare Pages 双通道。

## 项目结构

```
assets/
  styles.css                  + dlt-styles.css
  js/
    [双色球 SSQ]               main.js, data.js, ui.js, generator.js, advanced-sampler.js
    [大乐透 DLT]               dlt-main.js, dlt-data.js, dlt-ui.js, dlt-generator.js,
                              dlt-advanced-sampler.js, dlt-prize.js, dlt-chase.js,
                              dlt-explainer.js, dlt-independence.js
    [神经网络核心]             nn-math.js, nn-optim.js, nn-lstm.js, nn-stack.js,
                              nn-ssq-model.js, dlt-nn-model.js,
                              nn-trainer.js, dlt-nn-trainer.js,
                              nn-backtest.js, dlt-nn-backtest.js,
                              nn-statistics.js, nn-ensemble.js, dlt-nn-ensemble.js,
                              nn-calibration.js, nn-features.js, nn-schedule.js
    [LSTM 控制器]              lstm-controller.js, dlt-lstm-controller.js
    [Worker 训练]              nn-trainer-worker.js, nn-worker-client.js
    [模型存储]                 model-storage.js (IndexedDB), model-manager-ui.js (dialog)
    [其他统计]                 chi-square.js, distribution.js, distance.js,
                              cooccurrence.js, mcmc.js, dpp.js, bayes.js, rng.js,
                              countdown.js, timeseries.js, miss-stats.js, ...
  dlt-styles.css

data/
  draws.json + draws.js          (SSQ 3450+ 期)
  dlt-draws.json + dlt-draws.js  (DLT 2873+ 期)
  demo-models/
    ssq-lstm.json                (~196 KB 预训练 SSQ LSTM)
    dlt-lstm.json                (~190 KB 预训练 DLT LSTM)

tools/
  serve.mjs / update_ssq.py / update_dlt.py / parse_*.py
  generate_demo_models.mjs
  check_*.mjs                    (端到端测试用 puppeteer)

tests/
  *.test.mjs                     (315 个测试，node --test 跑)
  test_update_*.py

.github/workflows/
  pages.yml                      (推送 main 自动部署)
  update-data.yml                (周一/三/五自动抓数据)

sw.js                            (PWA cache v14)
manifest.webmanifest
```

## 已完成里程碑（最近→最早）

| Commit | 主题 |
|---|---|
| 1a0fc42 | BSS + permutation 接入回测 UI · LR 曲线 + ETA · PWA update banner |
| 29ee910 | Web Worker 训练 · 模型管理器对话框 · cosine LR · BSS/permutation 函数 |
| a3ec8d7 | DLT ensemble · 14 维手工特征 · reliability raw/cal 双线 · demo 模型 |
| 2214b54 | Label smoothing · temperature scaling · LCB ranking |
| dc30bee | SW v10：navigation network-only（修第二次切换 ERR_FAILED） |
| b9c04dc | SW v9：dedup redirected response（首次修） |
| 5cf5b7e | 移动端响应式 deep-fix（4 视口 audit，100 → 0 问题） |
| 4dc70a8 | IndexedDB 模型存储 + 文件备份 + iOS 触摸 |
| d07456f | 大乐透专业级套件（LSTM、奖级 EV、独立性、追号、号码体检） |
| 44dd2f6 | MCMC 多注去重 fix · LSTM ensemble 持久化 |
| 3cfa576 | 大乐透 walk-forward 回测工作台 |
| ec9840d | 大乐透完整数据实验室 |
| 69d2dc5 | LSTM 工业级（堆叠 / dropout / ensemble / bootstrap CI / calibration） |
| ead244e | LSTM 从零造（BPTT / Adam / 梯度检查） |
| a25b02e | Bayes + DPP + MCMC + Thompson 4 引擎 |

## 测试 / 部署

- **315 / 315 测试全过**（node --test tests/*.test.mjs）
- **Python 33 / 33 通过**（抓取脚本）
- **PWA cache** = `ssq-lab-v14`
- **生产部署**：CF Pages 自动构建 main，1-2 分钟上线

## 关键设计决策

1. **Service Worker 不预缓存 HTML** — 上次 308 重定向被缓存进 cache 导致 "ERR_FAILED 在第二次切换"。
   现在 navigation 走 network-only，HTML 永不进 cache。
2. **`nn-trainer-worker.js` 不进 sw 缓存** — sw 包装的 module worker response 偶尔加载失败。
3. **模型存储用 IndexedDB**（之前 localStorage 5 MB 限）；自动迁移老 key。
4. **LSTM 默认 cosine LR + 1 epoch warmup + ε=0.05 label smoothing + 训练后 fit T**。
5. **诚实立场不变** — 所有 UI 都呈现"hit@K 与 baseline 不可区分"。

## LSTM 完整 pipeline

```
原始 draws → buildSamples (with rolling history)
  → encode 49+14=63 维 (SSQ) / 47+14=61 维 (DLT)
    手工特征：sum/span/oddRatio/zone[3]/AC/consec/missMax/freqEntropy/...
  → Worker 训练：
    cosine LR + 1ep warmup → AdamW → grad clip → LSTM(stack) →
    sigmoid (red/front) + softmax (blue) / sigmoid (back)
    label smoothing ε=0.05 + BCE/CE
    早停（val patience=6）→ best-on-val 还原
    fit temperature T (val 黄金分割搜索) → model.calibration
  → 预测：forward 自动 apply T → topK / LCB（ensemble + λ）
  → 回测：backtest + 4 baseline (uniform/freq/Bayes/理论)
    + bootstrap CI + paired bootstrap + permutation test (B=1000)
    + Brier Skill Score vs climatology
    + reliability diagram (raw vs calibrated 双线 + ECE)
  → 持久化：IndexedDB save/load + 文件 import/export
    + 模型管理器对话框（多 key 切换 / 配额显示）
  → 可视化：训练时 Loss + Hit + LR 三条曲线 + ETA
  → demo 模型：⚡ 一键 fetch JSON 立即体验
```

## 已知边界 / 注意

- iOS Safari < 15 不支持 module worker — 自动 fallback 主线程训练
- `permutationTest` 自动适配 per-record / batch metricFn（修过的 bug）
- DLT 后区是 multi-label sigmoid，不是 single-label softmax（与 SSQ 蓝球不同）
- demo 模型 ~190 KB 进 sw 缓存，离线也能用

## 候选下一轮方向

1. **A/B 模型对比工作台** — 模型管理器选两个，并排回测看 BSS/hit
2. **训练历史可视化对比** — 多模型 loss/hit 曲线叠加
3. **数据 CSV 导入** — 让用户用自己的彩票数据
4. **完整文档 / LSTM 教学** — docs/LSTM_GUIDE.md
5. **E2E 测试套件正规化** — tools/check_*.mjs → tests/e2e/*.spec.mjs
6. **WASM SIMD** — LSTM matmul 加速 5-10x（工作量大）
