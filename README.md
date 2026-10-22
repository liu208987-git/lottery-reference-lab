# Lottery Reference Lab

五个开源彩票研究项目的**只读参考快照**，用于 Lottery Research Lab 的方法研究与资产盘点。

## 用途

- 供人工与 AI 逐文件阅读、比较、提取算法与字段设计
- 不作为运行环境，不修改上游代码
- 本项目自身的实现位于另一个仓库，参考代码一律重写而非复制

## 目录

| 目录 | 上游项目 | 内容 | 规模 |
|---|---|---|---|
| `01-lottery-model-lab/` | Coco422/lottery-model-lab | 概率模型、随机基线、P0/P1 审计、Walk-forward | 67 files / 4.5 MB |
| `02-ioi-lottolab/` | ioi-studio/IOI-LottoLab | 预测台账、审计、回测（含 2 个 exe 与多个 db） | 173 files / 77.6 MB |
| `03-lottopilot/` | Xwordsman/LottoPilot | 后端/前端工程结构与文档体系 | 209 files / 0.9 MB |
| `04-ssq-data-lab/` | wanghao137/ssq-data-lab | 统计指标、图表、测试 | 209 files / 2.7 MB |
| `05-open-lottery-ai/` | ai-zxl/open-lottery-ai | FastAPI + PyTorch + Vue 训练系统 | 116 files / 1.8 MB |

合计 774 个文件，约 87.5 MB。

## 阅读建议

- 文本源码可直接读；`.exe`、`.db`、图片为二进制，只能下载不能解析。
- `02-ioi-lottolab/` 根目录混有八字分析、天气分析、v8–v12 多版本脚本，属于上游历史遗留，不建议作为参考。
- `04-ssq-data-lab/assets/js/draws.js` 与 `dlt-draws.js` 是数据文件（约 500KB），不是逻辑代码。
- `05-open-lottery-ai/sql/open-lottery.sql` 是 1.4MB 的数据库导出。

## 许可证

各子项目保留原始 `LICENSE`。汇总说明见 `NOTICE.md`。本项目为未修改的快照，版权归各原作者所有。