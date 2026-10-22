# Lottery Lab

一个双色球 / 大乐透模型实验系统，包含冻结历史快照、P0 零模型审计、P1 概率审计、时间留出回测、下一期实验排序，以及仅供本机使用的数据同步、手工录入和重新训练入口。公共 Docker 模式是不可写的试玩快照，只开放预测。

> 这个系统用于研究“历史数据中是否存在可复现信号”，不承诺提高中奖概率。公平独立开奖下，任何只依赖历史记录的方法都不会改变单注理论中奖率。

## 已实现内容

- 正式实验快照（`2026-07-21T08:29:39Z`）共 6,378 个完整历史唯一期次：双色球 3,479 期，大乐透 2,899 期。这些数字是冻结实验版本的记录数，不是网站截至任意当前日期的永久总量；私人模式启动自动补数后的实时数量以首页或 `GET /api/status` 为准。
- 该实验快照的建模口径：双色球使用完整历史；大乐透从 `2014-01-01` 开始形成模型状态，使用 1,885 期，早期 1,014 期保留审计但不进入新模型计算。
- 60% / 20% / 20% 时间切分：历史形成、GA 验证、最终留出集。
- 12 个模型臂：
  - 等概率随机
  - 全历史贝叶斯
  - 滚动窗口贝叶斯
  - 指数衰减贝叶斯
  - 冷热差
  - 遗漏值
  - 一阶 Markov 转移
  - 共现网络
  - Logistic map 混沌实验
  - 梅花易数实验
  - 小六壬实验
  - 遗传算法集成
- Brier、边际 log loss、固定大小组合 NLL、平均命中、置信区间和多重检验。
- P0 统计审计：whole-draw shuffle、号码对 BH-FDR / max-T、顺序统计量 Q、max-CUSUM 变化点、年度 / 球组时期复核和完整公平模型选择管线。
- P1 概率审计：条件 Bernoulli / 最大熵组合概率、先验 / 窗口 / 半衰期嵌套滚动选择、moving-block bootstrap、校准分箱和 Brier 分解。
- 网页系统：概览、统计审计、预测实验、数据录入、模型对比；公共模式会隐藏并在服务端禁用录入、同步与训练能力。
- 预测页通过异步任务运行真实计算流水线，按实际阶段展示正在处理的区域、模型组和计算内容，不用单一“计算中”占位。
- 预测完成后展示全部 12 个模型的完整号码卡，前区/红球与后区/蓝球在同一卡片中对应呈现。
- 分享覆盖全部 12 个模型：文本按固定模型顺序输出 12 行纯号码，PNG 卡片按一行一个模型生成适合手机阅读的纵向版式。
- 私人模式启动后自动从 HTTPS `Date` header 校准时间，并扫描本地最新记录到可信当前日期之间的缺失开奖；公共容器不会联网补数或写入数据。
- 人工录入数据单独保存在 `data/manual_entries.csv`，不会覆盖公开来源历史 CSV。
- 自动补入数据单独保存在 `data/synced_entries.csv`，不会覆盖公开来源历史 CSV。

## 启动方式

### 公共 Docker 试玩版

Compose 默认只监听 `127.0.0.1:8765`，应由服务器现有的 Caddy 或 Nginx 提供 HTTPS。容器以非 root 用户运行，根文件系统只读，不挂载任何私人数据目录。

```bash
docker compose up -d
curl http://127.0.0.1:8765/readyz
```

服务器首次安装：

服务器需先安装 Docker Engine 与 Compose v2；安装脚本只管理 Lottery Lab，不代替系统包管理器安装 Docker。

```bash
curl -fsSL https://raw.githubusercontent.com/Coco422/lottery-model-lab/main/deploy/install.sh \
  | sudo sh -s -- install
```

后续更新和运维：

```bash
sudo lottery-lab update
sudo lottery-lab status
sudo lottery-lab logs
sudo lottery-lab rollback
```

安装器将版本固定到 GHCR 镜像 digest，等待 `/readyz` 成功后才切换当前版本；健康检查失败会自动恢复上一版。公开镜像内置同一提交对应的历史快照、历法缓存、模型权重和审计结果，不在服务器上临时下载不匹配的模型。

### 私人本地模式

建议使用 Python 3.12 虚拟环境安装项目依赖：

```bash
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r requirements-runtime.txt -r requirements-dev.txt

# 正式默认：999 次统计代理、99 次完整公平管线、1999 次区块 bootstrap
python3 run_experiments.py

# 启动本地系统
python3 web/server.py --open
```

默认访问地址：

```text
http://127.0.0.1:8765
```

开发时可先运行较快版本：

```bash
python3 run_experiments.py --quick
```

确认性 P0 运行使用更大的 Monte Carlo 预算：

```bash
# 9999 次统计代理、999 次完整公平管线
python3 run_experiments.py --confirm-p0
```

也可以通过 `--audit-permutations`、`--pipeline-null-repetitions`、`--pipeline-null-workers`、`--pipeline-null-backend` 和 `--p1-bootstrap-repetitions` 单独覆盖预算与并行方式。

## 数据更新流程

公开来源的冻结历史 CSV 位于 `model_data/ssq_history.csv` 和 `model_data/dlt_history.csv`；固定历法表位于 `model_data/lunar_calendar.csv`。`data/...` 只保存私人模式下自动补入和手工录入的增量记录，并被 Git、Docker 构建上下文和公共容器排除。

1. 服务启动后并行访问三个 HTTPS 时间源，取成功 `Date` header 的中位数；全部失败时明确标记为本机时间降级。
2. 系统分别查询双色球和大乐透接口，从本地最新开奖日扫描到可信中国日期。
3. 接口数据通过期号、日期、号码范围、固定数量、唯一性和本地冲突校验后，先写同目录临时文件，再用 `Path.replace` 单步替换 `data/synced_entries.csv`。在本项目同一文件系统的本地运行前提下，该重命名通常具备原子可见性；这里不宣称跨文件系统或断电级事务保证。
4. 页面显示可信日期、扫描范围、接口记录数、补入数量和错误；也可点击“立即扫描”。
5. 自动接口暂不可用时，仍可在同一页面手工录入；手工数据写入 `data/manual_entries.csv`。
6. 页面在历史数据、自动 / 手工记录、训练代码或已发布结果哈希与当前 `results/experiment_manifest.json` 不一致时提示“数据有更新，待训练”。
7. 点击“重新训练”，完成后模型指标和预测结果自动刷新，并重新生成 `experiment_manifest.json`。manifest 已经是当前训练流程的一部分，不是后续规划项；其中保存输入数据、训练代码、切分、P1 选择、GA 配置、历法来源和结果文件哈希。

公开来源抓取文件、自动补入和手工记录三层保存；同一期完全一致时去重，内容冲突时拒绝合并。

## 回测协议

每种彩票按日期升序：

- 先应用预注册模型起点：双色球不截断；大乐透默认从 2014 年开始。
- 前 60%：历史和特征形成区间。
- 贝叶斯先验强度、滚动窗口和指数半衰期只在前 60% 内通过嵌套时间滚动折叠选择并冻结。
- 中间 20%：仅供遗传算法学习基础模型非负权重。
- 最后 20%：一次性留出集，不参与模型权重或规则选择。
- 每一期预测只能读取严格早于该期的历史记录。

主指标是概率评分；命中数量只作为辅助展示。遗传算法不直接编码一注号码，而是组合已经定义好的基础模型，避免把搜索能力误当成信息来源。

## P1 概率模型与校准审计

- 把每个模型的包含概率转为 log odds，在恰好选 `k` 个号码的条件下构造条件 Bernoulli / 最大熵集合分布：`q(S) ∝ ∏(i∈S) w_i`。
- 通过 log-space elementary symmetric polynomial 动态规划计算合法组合归一化常数，输出严格的整注组合 NLL 与组合 perplexity。
- 全历史贝叶斯选择先验强度；滚动贝叶斯联合选择先验强度和 `60 / 120 / 240` 窗口；指数衰减模型联合选择先验强度和 `30 / 60 / 120` 半衰期。
- 参数选择只读取历史形成区中的内层滚动验证折叠。完整公平模拟中的每份代理历史都会重新执行相同选择，再训练 GA 和评估留出集。
- 最终留出集按开奖期形成“模型 Brier 减均匀基线 Brier”的差序列，使用 moving-block bootstrap 保留短程时间相关；同时输出等宽校准分箱、ECE、最大校准误差和 Murphy Brier 分解。

`moving_block_bootstrap.csv` 中的双侧 p 值检验“平均 Brier 差为 0”：置信区间使用普通未中心化区块 bootstrap，p 值使用中心化差序列构造零分布并带 `+1` Monte Carlo 修正。负差表示模型更好，正差表示模型更差；该 p 值不是“模型获胜概率”，也不替代完整模型选择管线的公平代理 p 值。页面优先展示同一区域 12 个模型内的 Bonferroni 校正结果。

结果文件包括 `p1_hyperparameter_selection.csv`、`moving_block_bootstrap.csv`、`calibration_audit.csv` 和 `brier_decomposition.csv`。

## P0 零模型与统计审计

当前 P0 管线包含：

- 对完整期开奖行做 999–9999 次 whole-draw shuffle，保留每期内部固定选取结构，只破坏时间顺序。
- 对全部号码对计算共现偏差，并同时输出 BH-FDR 与 Monte Carlo max-T 校正。
- 按公平 `k/N` 模型审计升序号码位置均值，并用 Monte Carlo 计算顺序统计量 Q 的 p 值。
- 用最大 CUSUM 在日期和号码两个维度上搜索变化点，代理分布同时校正搜索范围。
- 大乐透按年份、2014 前后时期和官方球组编号字段分组复核。
- 在每份完整公平历史上重新执行 P1 嵌套调参、重建所有历史依赖模型、用正式预注册 seed 重新优化 GA，并统计全部候选中的最大验证 / 留出 Brier Skill。
- 对双色球 / 大乐透的前后区结果再做一次四区域 Monte Carlo max-T，避免把四张表中的最小经验 p 值误读成全系统显著。

大乐透前区在 2007–2013 年存在非常强的边际与顺序位置偏斜，而 2014 年后的整体分布与公平模型相容。这个证据支持把 `2014-01-01` 作为可复现、粗粒度的训练截断，但不能据此断言某一期发生了具体设备更换。早期数据没有被删除，仍完整参与来源、时期和变化点审计。

在该冻结实验快照内，中彩网数据源与国家体彩官方接口的 2,899 期开奖号码逐期一致，只有两个开奖日期冲突：`08151` 和 `09107`。因此在使用星期、节假日或历法特征前，应优先采用经过复核的规范日期。

当前正式 999/99 结果中，双色球前区的最大留出 Brier Skill 单区经验 p 为 `0.02`，但四区域 Monte Carlo max-T 校正后为 `0.30`；其余区域校正 p 均为 `1.00`。因此完整模型搜索流程没有显示可复现的全系统预测优势。

P1 嵌套选择在四个区域都把全历史贝叶斯推向候选网格中最强的收缩先验 `96`；指数模型也都选择先验 `48` 与最长半衰期 `120`。这更符合“历史差异需要被压回公平基线”，而不是存在强近期信号。双色球前区全历史贝叶斯相对均匀基线的逐期 Brier 差为 `-0.0000169`，95% moving-block bootstrap 区间 `[-0.0000990, 0.0000739]`，双侧 p=`0.6925`；其余区域没有稳定改善。严格组合 NLL 得出相同方向的结论。

## 传统术数模型的工程定义

两种模型均使用农历年月日和固定亥时序数 `12`。仓库提交了 `2000-01-01` 至 `2050-12-31` 的固定历法缓存，生成实现使用 `lunar_python==1.4.8`，并已与 macOS Foundation Chinese Calendar 在全部 18,628 个日期上逐日比对，差异为 0。缓存缺失或目标日期不在表内时会明确失败，不会退化为公历代理。

- 梅花易数：采用常见的年月日为上卦、年月日加时为下卦、总数除六取动爻公式；卦数与爻数再映射为号码余数特征。
- 小六壬：采用大安、留连、速喜、赤口、小吉、空亡的月日起时六宫轮转；宫位再映射为号码余数特征。

“卦象 / 宫位 → 彩票号码评分”是本项目明确添加的现代特征工程，不是古籍中已有的彩票预测方法。它们与现代数学混沌理论没有同一理论基础，只作为预注册的确定性实验组。

## UI 设计来源

视觉系统通过 OpenDesign 获取真实设计 token：

- 主参考：Ramp，使用白色与浅灰平面、黑色文字、`#DFFF00` 单一强调色、4px 网格和轻边框。
- 次参考：Linear，借鉴紧凑数据密度、状态反馈和快速微交互。

界面不使用渐变、玻璃拟态、厚重阴影或大量装饰图标。

## 主要文件

公开来源历史、历法和模型结果都在仓库内以只读快照发布：

```text
lottery_model_lab/
├── Dockerfile
├── compose.yaml
├── deploy/
│   ├── entrypoint.sh
│   └── install.sh
├── run_experiments.py
├── model_data/
│   ├── ssq_history.csv
│   ├── dlt_history.csv
│   └── lunar_calendar.csv
├── src/
│   ├── lottery_lab.py
│   ├── model_selection.py
│   ├── p1_analysis.py
│   ├── data_sync.py
│   ├── null_audit.py
│   ├── p0_reporting.py
│   ├── pipeline_adapter.py
│   └── pipeline_null.py
├── scripts/
│   ├── audit_dlt_sources.py
│   ├── build_lunar_calendar.py
│   ├── check_public_bundle.py
│   └── chinese_calendar.swift
├── tests/
├── data/
│   ├── synced_entries.csv   # 自动补入，按需创建
│   └── manual_entries.csv   # 手工录入，按需创建
├── web/server.py
├── web/static/
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── share.js
└── results/
    ├── model_metrics.csv
    ├── holdout_predictions.csv
    ├── randomness_diagnostics.csv
    ├── p0_audit_summary.csv
    ├── pair_cooccurrence_audit.csv
    ├── order_statistic_audit.csv
    ├── change_point_audit.csv
    ├── dlt_era_audit.csv
    ├── cutoff_comparison.csv
    ├── p1_hyperparameter_selection.csv
    ├── moving_block_bootstrap.csv
    ├── calibration_audit.csv
    ├── brier_decomposition.csv
    ├── pipeline_null_summary.csv
    ├── pipeline_null_replicates.csv
    ├── pipeline_null_report.json
    ├── dlt_source_crosscheck.csv
    ├── dlt_source_crosscheck.json
    ├── ga_weights.json
    └── experiment_manifest.json
```

## API

```text
GET  /api/status
GET  /api/metrics
GET  /api/audit
GET  /api/draws?lottery_code=ssq&limit=12
GET  /api/training-status
GET  /api/sync-status
GET  /api/predict-status?job_id=...
POST /api/predict
POST /api/draws
POST /api/sync
POST /api/train
```

网页预测默认向 `POST /api/predict` 发送 `{"async": true, ...}`。服务返回 `202 Accepted` 和任务快照后，前端轮询 `GET /api/predict-status?job_id=...`；任务状态为 `queued`、`running`、`completed` 或 `failed`，并返回真实的 `progress`、`stage`、`zone`、`models`、标题与计算说明，完成时结果位于 `result`。不传 `async: true` 时仍保留原同步响应，供已有调用兼容使用；同一时刻只接受一个活动预测任务。

公共模式只允许只读 GET 和异步 `POST /api/predict`；`POST /api/draws`、`POST /api/sync`、`POST /api/train` 均返回 `403`，同步预测返回 `400`。这些限制由后端执行，不依赖前端隐藏按钮。

服务与 Compose 默认只监听 `127.0.0.1`。公开部署应保留该绑定，由同机 HTTPS 反向代理转发并配置访问日志、请求频率和超时限制；不要把私人模式直接暴露到互联网。

## 下一阶段建议

- 为完整公平管线增加更高预算的周期性确认运行，并保存跨版本对照。
- 加入浅层 Random Forest / GBDT；不优先上 LSTM。
- 为 GA 增加多个固定随机种子与早停，并测试只组合低方差模型的版本。
- 若未来需要把私人录入和训练能力开放给远程管理员，再引入独立鉴权、SQLite、操作审计和备份；公共试玩容器继续保持只读。
