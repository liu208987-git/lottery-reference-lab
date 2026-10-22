# 双色球 / 大乐透数据实验室 · Lottery Data Lab

[![GitHub Pages](https://img.shields.io/badge/demo-github%20pages-brightgreen?style=flat-square&logo=github)](https://wanghao137.github.io/ssq-data-lab/)
[![Cloudflare Pages](https://img.shields.io/badge/镜像-cloudflare%20pages-f38020?style=flat-square&logo=cloudflare&logoColor=white)](https://ssq-data-lab.pages.dev/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-node%20%2B%20python-success?style=flat-square)](./tests)
[![No build step](https://img.shields.io/badge/build-zero--config-informational?style=flat-square)](./index.html)
[![PWA](https://img.shields.io/badge/PWA-offline%20ready-635bff?style=flat-square)](./manifest.webmanifest)
[![LSTM](https://img.shields.io/badge/LSTM-from--scratch-ff4a6b?style=flat-square)](./assets/js/nn-lstm.js)

[English](./README.en.md) · **中文**

一个**诚实**的彩票历史数据分析站点：用 3400+ 期双色球数据与 2800+ 期大乐透数据做可视化、分布分析、卡方检验与娱乐性号码推荐。**不预测、不承诺中奖、不引导购彩**。

> 彩票是独立同分布的随机事件。历史频率无法预测未来——这个项目就是要用数据本身证明这一点。

## Live Demo

- **GitHub Pages**（海外友好）：<https://wanghao137.github.io/ssq-data-lab/>
- **Cloudflare Pages**（国内友好镜像）：<https://ssq-data-lab.pages.dev/>
- **大乐透入口**：<https://ssq-data-lab.pages.dev/dlt.html>

## 截图

> 暗色主题（默认）+ 亮色主题，编辑级排版 · 玻璃态顶栏 · 系统化色板。
> 顶栏右上角的月亮/太阳按钮可一键切换主题，URL hash 同步当前 Tab。

## 特性

### 数据与可视化
- **双彩种入口**：顶部可在 双色球 / 大乐透 间切换；大乐透页使用前区绿、后区紫的独立视觉系统
- **开奖倒计时**：双色球按周二/四/日 21:15，大乐透按周一/三/六 20:30，实时倒数下期开奖与销售截止
- **走势图**：近 30/50/100 期红蓝点阵，球体加高光、当期 6 球低饱和连线
- **走势图右侧 4 列**：出现次数 / 平均遗漏 / 最大遗漏 / 当前遗漏（500.com 标准走势版式）
- **冷热 / 遗漏分析**：频次柱状图 + 距上次出现的期数
- **分布分析**：奇偶比、大小比、质合比、012 路、三区比、AC 值、和值、跨度
- **时序演化**：和值/跨度/AC/奇偶/蓝球随期数走势 + 移动均线（直观证明无规律）
- **红球同伴号 / 极端共现对**：3450 期 33×33 共现矩阵 + lift 偏离独立基线分析
- **卡方拟合优度检验**：实时 p 值，验证「均匀分布」假设（差异化功能）

### 大乐透
- **规则模型**：前区 5 选 35 + 后区 2 选 12，基本投注一等奖理论概率 1 / 21,425,712
- **大乐透完整工作台**：概览、前后区走势图、冷热/遗漏、前区分布、后区奇偶/和值、时序演化、前区共现矩阵、滚动回测、卡方检验
- **大乐透高级生成器**：经典加权随机、Bayes + DPP、Thompson Sampling、MCMC，多注低撞号、可重现种子、采样质量诊断与历史回测
- **大乐透工具**：前后区胆码/排除、胆拖/复式注数试算、号码体检、CSV 导出
- **数据维护**：`tools/update_dlt.py` 从 500.com 抓取大乐透历史开奖并同步生成 `data/dlt-draws.json` 与 `data/dlt-draws.js`，2007 年至今 2800+ 期已入库

### 工具
- **加权随机生成器**：热 / 冷 / 混合 / 均匀策略 × 和值 / 奇偶 / 跨度 / 分区 / AC / 连号约束
- **高级采样器**（4 个引擎，全部带可重现种子 + 实时诊断）：
    - `Bayes + DPP`：Beta-Binomial 共轭先验估计号码概率，行列式点过程贪心 MAP 选号，自动多样化
    - `Thompson Sampling`：每注从 Beta 后验独立抽 p̂ 做权重，反映"小样本不确定性"
    - `MCMC（Metropolis-Hastings）`：多链组合空间采样，提供接受率 / ESS / Gelman-Rubin R̂ 收敛诊断
    - `经典加权随机`：保留原行为，作为基线
- **LSTM 神经网络预测**（纯手写，零依赖）：
    - **多层堆叠 LSTM**（1-4 层可配），i/f/g/o 门融合 W；输入/隐藏/输出三档 dropout（inverted）
    - Adam 优化器 + 全局梯度裁剪 + Xavier/Orthogonal 初始化 + AdamW weight decay
    - 训练 / 推理 mode 分离，evaluate 与 backtest 强制 inference mode
    - 在浏览器本地训练，~30s/epoch（300 期 × H=64 × L=2）
    - **完整 walk-forward 回测**：与均匀随机 / 频率 / 贝叶斯后验 baseline 并排对比
    - **Bootstrap 95% CI**（B=500 重采样）+ **配对显著性检验**：自动给出"差异是否包含 0"的 verdict
    - **Reliability diagram + ECE**：可视化预测概率是否校准
    - **Deep Ensemble (K=1-8)**：多个不同初始化模型取均值，每个号码带 epistemic uncertainty
    - **梯度检查测试**：单层 + 多层堆叠的解析梯度都对中心差分数值梯度做了验证（rel 误差 < 5e-3）
- **采样质量度量**：JS 距离 / Wasserstein-1 与贝叶斯后验对比，0–100 综合质量分
- **胆码 / 排除**：胆码必含、排除号码、避开上一期号码
- **低撞号 + 分散覆盖**：多注之间降低撞号风险（不提高单注命中率）
- **胆拖 / 复式注数试算**：实时 C(n, k) 与金额
- **号码体检**：任意一注红蓝号码，输出 10 项分布指标 + 历史完全重合查询

> **关于这些算法（包括 LSTM）**：它们是**统计学上更严谨的随机采样器与预测器**，但在**独立同分布的彩票模型下**，任何采样器/预测器的中奖期望概率都等于均匀随机（双色球一等奖 ≈ 1 / 17,721,088；大乐透一等奖基本投注 ≈ 1 / 21,425,712）。LSTM 在 walk-forward 回测里的 Top-6 命中数与均匀基线统计上不可区分——这不是模型缺陷，是测度论结论。算法的真正价值是：(1) 让多注之间天然分散，降低撞号风险；(2) 用诊断指标（ESS / R̂ / backtest）让过程透明可验证；(3) 用种子机制实现完全可复现。

### 数据
- **开奖记录**：搜索（期号 / 日期 / 红球/前区组合 / 蓝/后 NN）+ CSV 导出
- **数据源**：500.com 历史接口，每周一/三/五 GitHub Actions 自动拉取最近 30 期合并

### 设计与交互
- **双主题**：暗色 / 亮色一键切换，本地持久化
- **响应式**：从 360px 手机到 4K 显示器自适应
- **键盘可访问**：Tab / 方向键导航，跳到主要内容链接，ARIA tabpanel
- **零构建零依赖**：纯 ES Modules + SVG，加载即用
- **PWA**：manifest + service worker，安装到桌面、离线可用
- **离线兜底**：双击 `index.html` 也能跑（通过 `data/draws.js` 内置兜底数据）
- **打印样式**：可直接打印任意分析页
- **SEO 完备**：sitemap.xml / robots.txt / WebApplication + Dataset structured data

**技术栈**：原生 ES Modules + SVG，零构建；Python stdlib 抓取；Node.js / unittest 测试。**无任何 runtime 依赖**。

## 快速开始

```bash
# 克隆
git clone https://github.com/wanghao137/ssq-data-lab
cd ssq-data-lab

# 起服务器
npm run serve
# → http://localhost:5173/

# 跑测试
npm test           # 前端单测（65 个）
npm run test:py    # 抓取脚本（15 个）

# 抓最新数据（双色球 + 大乐透）
npm run update-data

# 只抓大乐透
npm run update:dlt
```

> 要求：Node.js ≥ 18、Python ≥ 3.10。

## 设计语言

**编辑级排版**：标题 serif、正文 sans-serif、数字 JetBrains Mono / 系统等宽字体回退，所有数字 `tabular-nums` 对齐。

**Token 化色板**：`--bg-*` / `--surface-*` / `--stroke-*` / `--muted-*` 三层；`--red` / `--blue` / `--acid` / `--gold` / `--plum` 五种语义色；通过 `[data-theme="light|dark"]` 切换整套 Token。

**玻璃拟态顶栏**：`backdrop-filter: blur + saturate`，配合三层径向极光背景与可见网格。

**球体**：radial-gradient 高光 + inset shadow，逼近实物质感；红/蓝两色与单一蓝球前的「+」分隔均由 CSS 完成。

## 目录结构

```
ssq-data-lab/
├── index.html                  双色球单页入口，8 个 Tab
├── dlt.html                    大乐透单页入口，9 个 Tab
├── assets/
│   ├── styles.css              Token 化设计系统（dark + light 双主题）
│   └── js/
│       ├── main.js             生命周期 + 事件
│       ├── data.js             fetch + window.__SSQ_DATA__ 兜底
│       ├── stats.js            频次 / 遗漏 / TopN
│       ├── distribution.js     分布分析（奇偶/大小/012路/AC 值...）
│       ├── chi-square.js       卡方检验 + 不完全伽马 p 值
│       ├── combinatorics.js    胆拖 / 复式 / C(n,k)
│       ├── trend.js            走势矩阵
│       ├── trend-chart.js      走势点阵 SVG（含右侧统计列）
│       ├── miss-stats.js       出现次数 / 平均遗漏 / 最大遗漏 / 当前遗漏
│       ├── cooccurrence.js     33×33 共现矩阵 / lift / topPartners
│       ├── timeseries.js       指标时序折线 + 移动均线
│       ├── countdown.js        下期开奖倒计时（中国时区）
│       ├── chart.js            频次柱状图 SVG
│       ├── generator.js        加权采样（经典引擎）
│       ├── rng.js              可重现 PRNG (xmur3 + mulberry32) + Gamma/Beta 采样器
│       ├── bayes.js            Beta-Binomial 共轭先验 / Thompson 权重
│       ├── dpp.js              k-DPP 行列式点过程 greedy MAP（多样化采样）
│       ├── mcmc.js             Metropolis-Hastings + ESS + Gelman-Rubin
│       ├── distance.js         KL / JS / Wasserstein-1 / 质量分
│       ├── advanced-sampler.js 高级采样器编排（4 引擎统一接口）
│       ├── nn-math.js          矩阵运算 / Xavier·Orthogonal 初始化 / 激活函数 / 梯度裁剪
│       ├── nn-optim.js         Adam / AdamW 优化器
│       ├── nn-lstm.js          LSTM cell + 单/全序列 BPTT
│       ├── nn-ssq-model.js     双色球编码 + LSTM 主体 + 双输出头（red sigmoid / blue softmax）
│       ├── nn-trainer.js       Mini-batch 训练 + 早停 + 学习率调度
│       ├── nn-backtest.js      Walk-forward 回测 + baseline 对比
│       ├── dlt-backtest.js     大乐透滚动回测 + 命中型态矩阵
│       ├── lstm-controller.js  LSTM 面板 UI 控制器
│       ├── ui.js               DOM 渲染 / 主题 / Toast
│       └── utils.js            $ / pad2 / clamp / ...
├── data/
│   ├── draws.json              双色球 3450+ 期主数据
│   ├── draws.js                window.__SSQ_DATA__ 等价副本（file:// 兜底）
│   ├── dlt-draws.json          大乐透 2800+ 期主数据
│   └── dlt-draws.js            window.__DLT_DATA__ 等价副本（file:// 兜底）
├── manifest.webmanifest        PWA manifest
├── sw.js                       service worker（cache-first + SWR）
├── sitemap.xml / robots.txt    SEO
├── tools/
│   ├── parse_ssq.py            txt / xlsx → draws.json
│   ├── update_ssq.py           500.com 抓取双色球 + 合并
│   ├── parse_dlt.py            txt / xlsx → dlt-draws.json
│   ├── update_dlt.py           500.com 抓取大乐透 + 合并
│   └── fixtures/               离线测试 HTML
├── tests/
│   ├── stats.test.mjs
│   ├── generator.test.mjs
│   ├── distribution.test.mjs
│   ├── chi-square.test.mjs
│   ├── combinatorics.test.mjs
│   ├── utils.test.mjs
│   ├── test_update_ssq.py
│   └── test_update_dlt.py
├── docs/
│   └── DEPLOYMENT.md
└── .github/
    ├── workflows/
    │   ├── update-data.yml     数据自动更新
    │   └── pages.yml           GitHub Pages 部署
    ├── ISSUE_TEMPLATE/
    └── PULL_REQUEST_TEMPLATE.md
```

## 开发

```bash
# 前端测试
npm test

# 抓取脚本测试
npm run test:py

# 手动抓一次
python tools/update_ssq.py --count 30
python tools/update_dlt.py --count 30

# 离线跑（不发网络请求）
python tools/update_ssq.py --fixture tools/fixtures/500_history.html

# 重新解析历史 txt/xlsx
python tools/parse_ssq.py 历史.txt data/draws.json
```

## 部署

见 [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)。推荐 **GitHub Pages + Cloudflare Pages 双通道**（覆盖海外 + 国内）。

## 这个项目和别的「双色球分析工具」哪里不一样

GitHub 上的「双色球分析」基本只有两类：

1. **走势图玩具** — 抄 500.com 的版式，没有任何统计严谨度
2. **「AI 预测」黑盒** — LSTM 调包预测，模型架构 / 训练过程 / backtesting 全藏起来

本项目两类都做，但都做到学术级透明：
- **统计层**：3450 期数据上的卡方检验、Beta-Binomial 后验、k-DPP 多样化采样、多链 MCMC（带 ESS / R̂ 收敛诊断）
- **神经网络层**：纯手写 LSTM（无 TensorFlow.js / PyTorch 依赖），BPTT 反向传播 + Adam 优化器 + 梯度裁剪 + 梯度检查测试，完整公开训练曲线和 walk-forward backtest 结果

无论是哪一层，**所有数学细节都在源码里**，没有黑盒。

## 贡献

欢迎 PR。先读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

**会被拒绝的 PR**：
- 任何引导未成年人购彩的功能
- 封闭式爬虫（数据源必须可替换）

## 免责声明

- 彩票为随机事件，历史统计**无法**预测未来
- 本工具仅输出「加权随机」建议，**不提高**中奖概率
- 理性消费、量力而行；**未成年人禁止参与**
- 本项目不从购彩行为中获取任何直接或间接收益

## License

[MIT](./LICENSE)
