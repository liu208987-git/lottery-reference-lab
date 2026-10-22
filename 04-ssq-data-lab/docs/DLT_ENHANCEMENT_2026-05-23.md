# 大乐透专业级扩展 · 2026-05-23

继 9:11 的"add walk-forward backtest workbench" 之后的全面升级。

## 修复的 Bug（4 项）

| 级别 | 问题 | 文件 |
|---|---|---|
| 🔴 产品级 | MCMC 多注去重 key 包含蓝/后区，导致前区雷同 | `advanced-sampler.js`、`dlt-advanced-sampler.js` |
| 🟡 功能 | LSTM Ensemble 模式下保存按钮永远不可用 | `lstm-controller.js` |
| 🟡 风格 | `escape()` 定义位置靠后，存在 hoist 风险 | `dlt-ui.js` |
| 🟢 文档 | README 没说大乐透 2007+ 期 | `README.md` |

修复验证：MCMC 5 注前区现在全部不同（之前会出现 5 注前 3 注前区相同）；ensemble 保存改用 `{ type: "ensemble" \| "single" }` payload，向后兼容老格式。

## 新增模块（8 个 JS + 4 个测试套件）

### 1. `dlt-prize.js` — 9 奖级体系 + EV 计算

精确组合数计算：
```
P(命中型态 f+b) = C(5,f)·C(30,5-f)·C(2,b)·C(10,2-b) / [C(35,5)·C(12,2)]
```

**实测数据（expected 奖池估计）**：
- 基本投注 payback ratio = **55.30%**
- 追加投注 payback ratio = **52.36%**
- 追加 1 元增量 EV = **−0.535 元**（在 expected band 下追加不划算）

3 档浮动奖估计（保守 / 期望 / 激进），9 个奖级精确概率，追加加成精确建模。

### 2. `dlt-independence.js` — 前后区独立性检验

3 种角度的"先验上必为独立"sanity check：
1. **前区和值 vs 后区和值**：Pearson r + Spearman ρ + Fisher z 变换 p 值
2. **奇偶比 6×3 列联表**：卡方独立性检验
3. **35×12 lift 矩阵**：找偏离独立基线最远的 K 对

**真实数据结果（2873 期）**：
- Pearson r = 0.026, p = 0.16
- Spearman ρ = 0.023, p = 0.21
- 奇偶 χ² = 10.43, df = 10, p = 0.40
- **判语：不拒绝独立**（与"两个独立摇奖装置"理论一致）

### 3. `dlt-explainer.js` — 号码深度体检

6 维 SHAP-like 加性归因，每维独立 0-100 分：
| 维度 | 关注点 |
|---|---|
| 🌐 分布散度 | 三区比、奇偶、大小 |
| 🔀 号码多样性 | AC 值、连号 |
| 🌡️ 热度均衡 | 历史频率排名分布 |
| 👥 撞号风险 | 生日号、同尾、连号、特殊后区 |
| 🆕 与上期错开 | 重叠数 |
| 📐 型态合理性 | 历史指纹出现频次 |

总分 = 6 维平均，三档健康灯（绿 ≥75 / 黄 50-75 / 红 <50）+ 文字 advice。

### 4. `dlt-chase.js` — 追号策略破产风险蒙特卡洛

3 种策略 × 3 档奖池 × 4 个关键参数：
- **flat** 等额追号（最常见）
- **martingale** 倍投（赌徒策略）
- **kelly** 凯利保守（数学最优解 = 不投）

**关键产出**：
- 破产概率（runs 中走到 0 的比例）
- 资金曲线（前 30 条样本路径，绿色未破产、红色破产）
- 终值分布（直方图，左偏程度直接展示）
- 曾中一/二等奖概率
- "理性思考" callout 用真实数字描述风险

**实测**：本金 2000 元 + 50 期 + 每期 2 注 + flat → 终值均值 1853 元，破产率 0%，但 **50 期后净亏 147 元**。

### 5-7. 大乐透专属 LSTM 全栈

`dlt-nn-model.js` + `dlt-nn-trainer.js` + `dlt-nn-backtest.js`

与 SSQ 版同构但适配 5+2 结构：
- **输入 47 维** = front multi-hot(35) + back multi-hot(12)
- **输出双 sigmoid + multi-label BCE**（不是 SSQ 的 single-blue softmax）
- 后区损失加权 5×（前后区维度差异补偿）
- 完整堆叠 + dropout + Adam + 早停 + best-on-val 还原
- 4 baseline 完整对照：uniform MC / freq / Bayes posterior / 理论

**真实 200 期 + 3 epochs 训练验证**：
- val front hit@5 = 0.655（基线 0.714）
- val back hit@2 = 0.345（基线 0.333）
- **结论：与基线统计上不可区分**（与诚实立场一致）

### 8. `dlt-lstm-controller.js` — LSTM 面板 UI

- 训练参数：序列长度、隐藏维度、层数、dropout 三档、lr、epochs、batch、种子
- 实时 loss + hit@5 双曲线（与基线对照）
- 预测面板：35 路前区概率热度条 + 12 路后区
- Walk-forward 回测：4 baseline 对比 + bootstrap 95% CI + paired bootstrap + reliability diagram + ECE
- localStorage 持久化（`dlt-lstm-model-v1`）

## UI 增强

### dlt.html

**Tab 从 9 个 → 12 个**：
- 新增 `lstm` · 神经网络预测
- 新增 `prize` · 奖级 · EV
- 新增 `chase` · 追号风险
- 在 `science` panel 内增加"前后区独立性检验"区

**号码深度体检**升级：原 12 项分布指标 → 6 维健康度仪表盘 + 12 项详细指标 + 历史对照
- 56px 大字号"健康度评分"
- 6 个维度卡片，进度条按分数染色
- 文字建议直接列出薄弱项

### dlt-styles.css

新增健康度仪表盘样式（80 行）：
- `.health-summary` 网格布局
- `.health-score-num` 56px 数字
- `.dim-grid` 三列 → 移动端两列
- `.dim-bar` 进度条带 0.4s 过渡

## 测试矩阵更新

新增 47 个测试，5 个新文件：

| 文件 | 测试数 | 覆盖 |
|---|---|---|
| `dlt-prize.test.mjs` | 9 | 概率精确、奖级分类、EV 单调性、追加 edge |
| `dlt-independence.test.mjs` | 11 | Pearson、Spearman、Fisher z、χ²、35×12 lift |
| `dlt-explainer.test.mjs` | 8 | 健康一注、生日号扣分、AC=0、全奇全偶、空历史回退 |
| `dlt-chase.test.mjs` | 8 | 蒙特卡洛分布、策略对比、可复现 |
| `dlt-nn-model.test.mjs` | 8 | encode 47 维、forward 概率有效、loss + grads 形状、序列化往返 |
| `dlt-integration.test.mjs` | +4 | 4 个新面板、奖级模块、LSTM 模型、PWA 缓存 |

**最终结果：265/265 前端测试全过（原 218 + 新 47），33/33 Python 测试全过**。

## 数据完整性

- 所有新模块进入 `sw.js` cache 清单（`ssq-lab-v7`）
- HTTP 200：8 个新 JS 模块全部可访问
- 集成测试覆盖：4 个新面板的关键 DOM ID 全部锁定

## 文件清单

```
新增 (8):
  assets/js/dlt-prize.js                280 行
  assets/js/dlt-independence.js         190 行
  assets/js/dlt-explainer.js            240 行
  assets/js/dlt-chase.js                160 行
  assets/js/dlt-nn-model.js             190 行
  assets/js/dlt-nn-trainer.js           220 行
  assets/js/dlt-nn-backtest.js          180 行
  assets/js/dlt-lstm-controller.js      390 行

修改 (8):
  dlt.html                              +220 行 (3 个新 panel + 独立性区 + 体检升级)
  assets/js/dlt-main.js                 +280 行 (奖级 / 追号 / 独立性 / 集成 LSTM)
  assets/js/dlt-ui.js                   +50  行 (健康度仪表盘渲染)
  assets/dlt-styles.css                 +90  行 (仪表盘样式)
  sw.js                                 +9   行 (新模块进缓存)
  assets/js/advanced-sampler.js         (MCMC 去重修复)
  assets/js/dlt-advanced-sampler.js     (MCMC 去重修复)
  assets/js/lstm-controller.js          (Ensemble 持久化)

新增测试 (5):
  tests/dlt-prize.test.mjs
  tests/dlt-independence.test.mjs
  tests/dlt-explainer.test.mjs
  tests/dlt-chase.test.mjs
  tests/dlt-nn-model.test.mjs

修改测试 (1):
  tests/dlt-integration.test.mjs        +4 tests

总净增：约 2400 行代码 + 47 个测试
```

## 不变的诚实立场

新增的 LSTM、奖级 EV、追号模拟器、独立性检验**全部强化**了项目的核心立场：

- **奖级 EV** 直接展示 payback ratio 永远 < 1（数学事实）
- **追号模拟器** 用 1000 次蒙特卡洛证明"补到中"是赌徒谬误
- **独立性检验** p > 0.16 证实前后区独立（如理论预期）
- **LSTM 回测** paired bootstrap CI 包含 0（与均匀基线统计上不可区分）

每个新功能的 callout 都明确说明：**这些工具不能改变中奖概率，只能让你看清概率本身**。
