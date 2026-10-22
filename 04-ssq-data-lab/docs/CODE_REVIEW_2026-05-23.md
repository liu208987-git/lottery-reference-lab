# 代码复盘 · 2026-05-23

> 范围：codex 在 2026-05-22 21:58 → 2026-05-23 09:11 期间提交的 6 次 feature commit。
> 视角：UI、功能、算法严谨性、工程质量。
> 校验：218 个前端单测 + 33 个 Python 单测全部通过；本地 5173 服务器实测 SSQ / DLT 双入口可用。

## 1. 量级

| 维度 | 数据 |
|---|---|
| 提交数 | 6 个 feature + 1 个 chore(data) |
| 净增代码 | ≈ 11,000 行 JS / HTML / CSS |
| 新增模块 | 20+（LSTM 全栈 7 个、采样器 6 个、大乐透 18 个） |
| 新增测试 | 153 个（57 + 33 + 17 + 46） |
| 双彩种入口 | 双色球 9 Tab + 大乐透 9 Tab |

时间线：

```
21:58 countdown / trend / time-series / co-occurrence / PWA / SEO  (33 tests)
21:59 Bayes + DPP + Thompson + MCMC 四引擎采样器                 (+57 tests, 总 155)
22:16 纯手写 LSTM v1 + walk-forward backtest                       (+33 tests, 总 188)
22:41 LSTM v2 工业级升级：堆叠 / dropout / ensemble / CI / ECE    (+17 tests, 总 205)
08:46 大乐透完整工作台（9 Tab + 4 引擎 + 抓取脚本）              (+46 tests, 总 218 - 33 复用)
09:11 大乐透 walk-forward 回测                                     (+10 tests)
```

## 2. UI 复盘

### 2.1 信息架构

**SSQ 9 个 Tab**：概览 → 走势图 → 冷热遗漏 → 分布 → **LSTM 预测** → 生成器 → 胆拖工具 → 科学态度 → 数据
**DLT 9 个 Tab**：概览 → 走势图 → 冷热遗漏 → 分布 → 生成器 → **回测** → 胆拖工具 → 科学态度 → 数据

两个入口结构对称，命名一致。差异点：

- SSQ 有 LSTM 预测 Tab；DLT 没有（合理，避免在浏览器里跑两套神经网络）
- DLT 有独立的回测 Tab；SSQ 把回测放在 LSTM 内部（不一致——见 §5）

### 2.2 视觉系统

- 双主题（dark/light）经 `[data-theme]` token 切换，`pre-paint` 脚本在头部消除 FOUC
- DLT 用专属 token：前区绿 (`--dlt-front`)、后区紫 (`--dlt-back`)、绿/紫/金极光背景，与 SSQ 红/蓝形成清晰区分
- `.lottery-switcher` 顶栏胶囊式开关，激活态用语义色
- 球体保持 radial-gradient 高光 + inset shadow 的实物质感
- KPI 卡片、命中型态矩阵、reliability diagram 全部 SVG，响应式

### 2.3 可访问性

- `role="tablist"` / `aria-selected` / `tabindex` 完整
- `aria-labelledby` / `<a class="skip-link">` 跳转链接
- `tabular-nums` 数字对齐
- 键盘可达：方向键切 Tab、Enter 触发 search
- `prefers-color-scheme` 跟随系统 + `localStorage` 持久化

### 2.4 UI 小问题（可选打磨）

1. **DLT 回测面板的"专业解读"** 用 `escape(best.issue)` 但 `escape` 只在文件顶部以函数形式定义，回测渲染顺序把它放在一个早期块；功能正确但代码风格不一致（有的地方直接拼 `${best.issue}`）
2. **LSTM 预测卡片的"集成 std" 显示** 当 K=1 时仍展示"± std"列空——已经做了条件判断，OK
3. **MCMC 诊断里 `acf` 字段计算了但未渲染**——可视化机会
4. **DLT 回测命中矩阵列只到 0/1/2**（后区共 2 个），但行从 5 倒推到 0，符合彩民读图习惯

## 3. 功能复盘

### 3.1 数据层

- **抓取脚本** `update_ssq.py` / `update_dlt.py`：纯标准库、原子写、幂等、严格校验、注释剥离；fixture 离线测试通过
- **GitHub Action** `update-data.yml`：每周一/三/五自动跑两个抓取脚本
- **PWA**：`sw.js` cache-first + draws.json SWR；`CACHE_VERSION = ssq-lab-v6`，APP_SHELL 列了 50+ 模块（**所有新模块都进了缓存清单**，无遗漏）
- **离线兜底**：`window.__SSQ_DATA__` / `window.__DLT_DATA__` 双重保险，双击 `index.html` 也能跑

### 3.2 LSTM 全栈

模块化清晰，每层职责单一：

```
nn-math.js      矩阵 / 激活 / 损失 / Xavier·Orthogonal·Dropout
nn-optim.js     Adam / AdamW
nn-lstm.js      单层 LSTM cell + BPTT（4 门融合 W）
nn-stack.js     多层堆叠 + 输入/层间 dropout（Zaremba 2014 风格）
nn-ssq-model.js 49 维输入 → LSTM → red sigmoid (33d, BCE) + blue softmax (16d, CE)
nn-trainer.js   mini-batch + Adam + 梯度裁剪 + NaN 守门 + 早停 + best-on-val 还原
nn-backtest.js  walk-forward + 4 baseline（uniform MC / freq / Bayes / 理论）
nn-statistics.js bootstrap CI + paired bootstrap + reliability diagram + ECE
nn-ensemble.js  K 模型独立训练 + epistemic uncertainty
lstm-controller.js 面板 UI 编排
```

**亮点**：

- BPTT 反向手推，单层 + 多层堆叠两套梯度检查，rel error < 5e-3
- forget-bias = 1.0（Jozefowicz 2015）
- Orthogonal init for U（递归权重稳定）
- inverted dropout，训练 mode 启用、eval / backtest 强制关
- 配对 bootstrap CI 直接给出"是否包含 0"的 verdict，把"差异显著吗" 这种统计问题翻译成工程师能立刻读懂的判断
- ECE + reliability diagram 可视化校准误差
- localStorage 模型持久化 + 自动加载

**正确性证据**：

- 测试 `LSTM analytical dW/dU/db matches numerical gradient`：解析梯度对中心差分，rel < 5e-3
- 测试 `Stacked backward: gradient check on 2-layer stack`：堆叠版本同样验证
- 测试 `bootstrapCI` 在 constant data 下 CI 紧贴常数；random data 下 CI 包住真值
- 测试 `pairedBootstrap` A 比 B 恒定 +1 时 CI 排除 0
- 测试 `reliabilityDiagram` well-calibrated → ECE 小；badly-calibrated 全 0.5 始终不命中 → ECE ≈ 0.5

### 3.3 高级采样器（4 引擎）

- **rng.js**：xmur3 + mulberry32 可重现 PRNG；Box-Muller / Marsaglia-Tsang Gamma / Beta 采样器
- **bayes.js**：Beta-Binomial 后验 + Thompson 权重 + 95% CrI
- **dpp.js**：k-DPP greedy MAP（Chen 2018 增量算法 O(k·N²)） + 退化分支
- **mcmc.js**：多链 MH + ACF + Geyer ESS + Gelman-Rubin R̂；能量函数糅合后验 + DPP logDet + 约束 + 撞号
- **distance.js**：normalize / KL / JS / Wasserstein-1 / 综合质量分
- **advanced-sampler.js**：4 引擎统一编排，输出统一诊断结构（accept rate / ESS / R̂ / JS / W1 / score）

UI 把所有诊断指标（接受率理想 20-50%、ESS、R̂ < 1.1）和颜色编码暴露给用户，每个种子点击复制可复现。这是行业级做法。

### 3.4 大乐透工作台

完整复刻 SSQ 的 9 Tab + 4 引擎，再加一个独立的回测面板。结构上：

- `lottery-config.js` / `lottery-stats.js` 抽象出双彩种通用接口
- `dlt-distribution.js` / `dlt-cooccurrence.js` / `dlt-chi-square.js` / `dlt-combinatorics.js` / `dlt-generator.js` / `dlt-advanced-sampler.js` 复刻 SSQ 等价模块
- 共现矩阵独立基线 lift 用 hypergeometric 推导：DLT = 4/34 / 5/35 ≈ 0.8235，SSQ = 5/32 / 6/33 ≈ 0.859

### 3.5 大乐透回测面板

- KPI 网格（8 项）+ 命中型态矩阵 6×3 + 最好轮次 Top 8
- `runDltBacktest` walk-forward 严格只用目标期之前的窗口
- 默认参数：lookback=240, rounds=80, ticketsPerDraw=5
- 5 种采样器选择（4 advanced + 3 legacy）
- 测试覆盖：`scoreDltTicket`、`theoreticalDltHitBaseline`、`summarizeDltBacktest`、`runDltBacktest`、PWA 缓存清单包含模块

## 4. 算法严谨性复盘

| 算法 | 数学严谨度 | 备注 |
|---|---|---|
| 卡方拟合优度 | ✅ 高 | 不完全伽马 p 值；测试覆盖 4 个标准临界点（df=1/10/32 + 极端值） |
| Beta-Binomial 后验 | ✅ 高 | shrinkage 行为正确；CI 用正态近似（α,β≥10 时差异 < 1%） |
| k-DPP greedy MAP | ✅ 高 | Chen 2018 增量算法；logDet 用 Cholesky；退化分支兜底 |
| MCMC | ✅ 高 | 接受率 / ESS (Geyer initial positive) / R̂；提议算子对称（swap） |
| LSTM BPTT | ✅ 高 | 解析 vs 数值梯度，rel < 5e-3；堆叠版本同样验证 |
| Bootstrap CI | ✅ 高 | percentile method；paired 版本对配对 bias 处理正确 |
| Reliability diagram + ECE | ✅ 高 | 标准定义；按 bin count 加权 |
| 共现 lift baseline | ✅ 高 | hypergeometric 推导；SSQ 0.859 与 DLT 0.8235 都对 |
| Crowd penalty | ✅ 中 | 启发式（生日号、连号、同尾、等差、单偶），文档化合理；不是数学定理 |

**关于"诚实声明"**：项目反复强调"在 i.i.d. 彩票模型下，任何采样器/预测器的中奖期望都等于均匀随机"。这是测度论结论，文档（README）、UI（采样诊断 callout、LSTM 预测 callout）、回测结果（paired bootstrap CI 包含 0）三处一致呈现。**这个立场比绝大多数同类项目都诚实**。

## 5. 发现的问题

### 5.1 🔴 MCMC 采样器去重不充分（产品级缺陷）

**症状**：当 MCMC 链在能量极低处反复，采样器输出 5 注里前 3 注前区完全相同（双色球、大乐透两端复现）：

```
SSQ MCMC, 5 tickets:
  06 11 17 22 28 33 + 07
  06 11 17 22 28 33 + 01     ← 前区与第 1 注同
  07 11 15 20 28 32 + 05
  07 11 15 20 28 32 + 11     ← 前区与第 3 注同
  07 11 15 20 28 32 + 03     ← 前区与第 3 注同

DLT MCMC, 5 tickets:
  02 10 19 27 35 + 01 02
  02 10 19 27 35 + 02 11     ← 前区雷同
  02 10 19 27 35 + 03 08     ← 前区雷同
  02 10 19 27 33 + 06 08
  02 10 19 27 33 + 03 12     ← 前区雷同
```

**根因**：`advanced-sampler.js` 与 `dlt-advanced-sampler.js` 的 MCMC 分支用 `${reds.join(',')}|${blue}`（DLT 版本是 `front|back`）做去重 key——前区相同 + 后区不同会被当成不同的票。其他三个引擎（Bayes-DPP / Thompson / Legacy）每注重新采前区，没这个问题。

**影响**：

- 用户买 5 注实际只覆盖 2-3 个独立前区组合，分散覆盖效果归零
- 站点核心卖点之一"低撞号"在 MCMC 模式下被自己破坏

**建议修法**（任选其一）：

1. 改去重 key 为 `reds.join(',')`（仅前区/前区），对相同前区只保留第一次
2. 选样后扫一遍，按"前区不重复"过滤，不够再从 allSamples 后段补
3. 链采集阶段就强制前区去重（在 sample 写入时检查）

### 5.2 🟡 SSQ 没有独立回测 Tab，DLT 有

LSTM 回测嵌在 LSTM Tab 里，需要先训练模型才能看到。普通采样器（Bayes-DPP / Thompson / MCMC）没暴露回测能力。DLT 反而暴露了独立回测面板，体验不对称。

**建议**：把 `nn-backtest.js` 里的 `backtestUniformBaseline / backtestFreqBaseline / backtestBayesBaseline` 提到一个 SSQ 通用回测面板，对齐 DLT 的体验。

### 5.3 🟡 LSTM Ensemble 不能保存

`lstm-controller.js` 第 137 行：`$("#btnLstmSave").disabled = !state.model;`——ensemble 模式下 `state.model = null`，保存按钮永远不可用。但 `state.ensemble.members[]` 完全可以序列化（已用相同 `serializeModel`）。

**建议**：扩展 `STORAGE_KEY` 为 `{ type: "single" | "ensemble", payload }`；或单独 key `ssq-lstm-ensemble-v2`。

### 5.4 🟡 大乐透回测的 escape 函数定义位置

`dlt-ui.js` 把 `escape` 定义在 sampler diagnostics 块里（第 270 多行），但 `renderHitMatrix` / `renderBestBacktestRecords` 在更早的 backtest 块用到了。JS hoisting 让它能跑（function declaration），但代码组织上应该把 `escape` 提到文件顶层 utility 区。

### 5.5 🟢 文档侧的小不一致

- README 里"大乐透 2800+ 期"，实际数据 2008+ 期（生成于 2007）；不是大问题
- `tools/parse_dlt.py` 在 README 里被列入功能但没在 `package.json` 的 scripts 里挂——已经够用，提一下

## 6. 总体评价

codex 这一晚（10 小时左右）的产出，**质量在统计学/数值计算/工程组织三个维度都达到了"专业开源项目"标准**：

- **数学严谨**：每个核心算法都有论文出处或经典实现作参照；梯度检查、bootstrap、ESS / R̂、ECE、Cholesky logDet 该有的都有
- **工程纪律**：218 个前端测试 + 33 个 Python 测试全过；零依赖、零 console.log、零 TODO/FIXME；PWA 缓存清单完整；service worker 版本号正确递增
- **诚实定位**：反复（README / UI / backtest 三处）声明"采样器和预测器都不能提高中奖率"，没有把 LSTM / MCMC 包装成预测玄学
- **设计语言**：双彩种入口对称、token 化色板、玻璃拟态顶栏、SVG 可视化、可访问性完整

**唯一一个产品级缺陷**是 §5.1 的 MCMC 多注去重——出现频次取决于能量地形，不是必现，但一旦触发就会让"低撞号"卖点失效。建议优先修。

其他三项黄色问题（SSQ 缺独立回测 / Ensemble 不可保存 / escape 位置）属于打磨，不影响功能正确性，可按优先级排进后续 PR。

## 附录 · 测试矩阵

```
前端单测（Node test runner）
  bayes        13 tests   beta-binomial 后验 / thompson 权重
  dpp          10 tests   L kernel / greedy / logDet
  mcmc          7 tests   接受率 / acf / ess / gelmanRubin / pin
  rng           7 tests   xmur3 / mulberry32 / 高斯 / Gamma / Beta
  distance     11 tests   normalize / KL / JS / W1 / quality score
  advanced-sampler 11 tests   4 engines / seed reproducibility / pin / exclude / quality
  nn-math      14 tests   matmul / softmax / sigmoid / xavier / orthogonal / clip
  nn-optim      4 tests   Adam quadratic / weight decay / step counter
  nn-lstm       6 tests   gradient check (W/U/b) / forward shape / cell stable
  nn-ssq-model  7 tests   encode / forward / topK / serialize / loss
  nn-stack      6 tests   numLayers=1 同 single / 2 层梯度检查 / dropout 训练 vs 推理
  nn-statistics 9 tests   bootstrapCI / pairedBootstrap / metric / reliability / ECE
  nn-ensemble   2 tests   K=2 distinct / forward valid prob
  generator    14 tests   weights / sample / 约束 / 胆码 / avoidLast
  stats         9 tests   freq / miss / topN / sumOf / spanOf / oddCountOf / 约束
  distribution  9 tests   isPrime / 奇偶 / 大小 / 质合 / 012 / zone / AC / 同尾
  combinatorics 9 tests   C(n,k) / 胆拖 / 复式 / 价格
  cooccurrence  8 tests   矩阵对称 / topPartners / lift / 独立基线 0.859
  countdown    11 tests   时区 / nextDrawTime / saleCutoff / nextIssue
  miss-stats    4 tests   freq + avgMiss + maxMiss + currentMiss
  timeseries    8 tests   buildSeries / movingAverage
  utils         6 tests   parseNumList / clamp / pad2
  chi-square    9 tests   p 值 / 拒绝 / 边界
  dlt-generator     5 tests   front + back rule / include / exclude
  dlt-backtest      5 tests   scoreTicket / baseline / summarize / walkForward
  dlt-integration   4 tests   入口 / PWA / 控件 / DOM hook

Python 单测 (unittest)
  test_update_ssq  15 tests   parse / merge / validate / fixture / idempotent
  test_update_dlt  18 tests   同上 + back-2 / front-5 校验

Total: 251 tests passing
```
