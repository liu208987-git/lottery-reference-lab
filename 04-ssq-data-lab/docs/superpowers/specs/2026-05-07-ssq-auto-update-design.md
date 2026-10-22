# 双色球站点：自动补“最新一期”数据（中国福彩网抓取 + GitHub Actions）设计

## 背景现状

当前仓库为纯静态站点：

- 前端入口：`index.html` + `assets/js/*.js`（ES modules） + `assets/styles.css`
- 数据来源：`data/draws.json`
- `file://` 直接打开兜底：`data/draws.js`（注入 `window.__SSQ_DATA__`）
- 历史数据最初来自本地上传的 xlsx/txt，通过 `tools/parse_ssq.py` 离线解析生成 `data/draws.json`

> **2026-05-13 更新**：本文档初版方案（PowerShell + 中国福彩网 API/HTML）已弃用 —— `cwl.gov.cn` 全量被阿里云盾拦截（403 Forbidden，haplat.net WAF）。现行实现改为 Python + 500.com，详见 `tools/update_ssq.py`。

## 目标

- 每日自动补齐“最新一期”双色球开奖数据，并更新站点数据文件
- 全流程可在 GitHub 上自动执行并发布（GitHub Actions + GitHub Pages）
- 若当日无新开奖数据，不产生提交、不触发不必要的发布
- 数据更新失败时不破坏已有数据文件（失败即退出，保留旧版本）

## 非目标

- 不做“预测必然性/中奖承诺”相关功能
- 不做历史数据全量重抓（仅补最新一期）
- 不引入后端服务与数据库

## 总体方案（方案A）

抓取入口优先使用中国福彩网开奖数据接口（避免网页反爬导致 403）：

- 最新一期接口（返回 JSON）：`https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice?name=ssq&issueCount=1&systemType=PC`
  - 可直接拿到：期号（code）、开奖日期（date）、红球（red）、蓝球（blue）
  - 若接口不可用/被风控拦截，再降级到中彩网（`jc.zhcw.com`）公开接口（JSONP）
  - 如仍失败，再降级到抓取页面 `https://www.cwl.gov.cn/ygkj/kjgg/`（不保证在 CI 环境可用）

自动化由 GitHub Actions 触发：

- 每日定时运行（北京时间）
- 执行抓取脚本
- 仅当生成的数据文件发生变化时提交回仓库
- 由 GitHub Pages 自动发布站点

## 数据模型与约束

### 既有数据结构（保持不变）

`data/draws.json`：

```json
{
  "meta": {
    "source": "xxx",
    "count": 3443,
    "generatedAt": "2026-04-28T09:22:10Z"
  },
  "draws": [
    {
      "issue": "2026046",
      "year": 2026,
      "date": "2026-04-26",
      "reds": [2, 9, 10, 24, 31, 33],
      "blue": 16
    }
  ]
}
```

`data/draws.js`：

- 内容为：`window.__SSQ_DATA__=<与 draws.json 等价的 JSON 对象>`

### 新增/更新时的校验规则

对抓取到的最新一期数据进行严格校验：

- `issue`：7 位数字字符串（例如 `2026050`）
- `year`：`int(issue[:4])`
- `reds`：长度 6、互不重复、范围 1..33、升序
- `blue`：范围 1..16
- `date`：优先解析为 `YYYY-MM-DD`，解析失败可置空但不得导致写入崩溃

### 去重与追加规则

- 以 `issue` 为主键去重
- 若抓取到的 `issue` 已存在于 `draws` 数组中：视为“无更新”，直接退出
- 若抓取到的 `issue` 大于当前最后一期（字符串比较即可，因为固定 7 位）：追加到末尾并重新计算 `meta.count` 与 `generatedAt`

## 组件设计

### 1) 抓取与更新脚本

新增脚本：`tools/update_latest_ssq.ps1`

职责：

- 读取 `data/draws.json` 获取当前最新一期 `issue`
- 请求接口 `findDrawNotice` 获取最新一期：
  - 解析 `code/date/red/blue`
  - 组装为站点数据结构
- 若中国福彩网接口失败，先降级到中彩网接口；如仍失败，再降级到抓取 `https://www.cwl.gov.cn/ygkj/kjgg/` + 详情页方式
- 校验数据合法性
- 仅当 `issue` 为新增时：
  - 追加到 `data/draws.json` 的 `draws` 末尾
  - 同步生成 `data/draws.js`

实现约束：

- 避免引入第三方依赖，使用 PowerShell 内置能力（`Invoke-WebRequest` + 正则 + `ConvertFrom-Json/ConvertTo-Json`）
- 禁止打印包含敏感信息（本方案默认无需密钥）

### 2) 生成 draws.js 的规则

`draws.js` 内容由 `draws.json` 直接导出，保证 file:// 兜底永远与线上数据一致：

- 输出格式保持单行，减少 diff 噪声
- 头部固定为 `window.__SSQ_DATA__=`

### 3) GitHub Actions 工作流

新增：`.github/workflows/update-data.yml`

触发方式：

- `schedule`：每日一次（北京时间）
- `workflow_dispatch`：手动触发（用于验证与应急）

核心步骤：

- checkout
- 执行 `tools/update_latest_ssq.ps1`（用 `pwsh` 作为 shell）
- `git diff --quiet` 判断是否有变更
  - 无变更：退出
  - 有变更：配置 bot 用户信息并提交、推送到默认分支

保护策略：

- 抓取/解析失败时脚本返回非 0，workflow 失败并停止，不写入数据文件
- 对写入采取“先生成临时文件再原子替换”的方式，避免中途失败写坏 JSON（脚本实现时落地）

### 4) 部署（GitHub Pages）

保持静态站点形态：

- Pages 从仓库默认分支发布（根目录）
- `index.html` 通过相对路径加载 `./data/draws.json`，无需额外配置

## 可观测性与运维

- Actions 日志输出：
  - 当前最新一期 issue
  - 抓取到的最新一期 issue
  - 是否更新、更新后的总期数
- 若连续失败：
  - 优先检查抓取页面结构变化
  - 通过修改脚本解析规则修复后，手动触发 `workflow_dispatch` 验证

## 风险与对策

- 页面结构变更：解析逻辑尽量用“锚点文本 + 宽松正则 + 数量校验”降低脆弱性
- 反爬/限制：加入合理的 `User-Agent`，必要时降低频率（当前每日一次通常足够温和）
- 数据异常：强校验 + 不通过则不落盘，避免污染历史数据

## 验证计划

本地验证（可选）：

- 运行更新脚本一次，确认无新开奖时不修改文件
- 模拟追加：将本地 `draws.json` 人为回退一期开启验证追加逻辑

CI 验证：

- `workflow_dispatch` 手动运行一次，观察是否能解析到最新一期并正确判断是否更新
