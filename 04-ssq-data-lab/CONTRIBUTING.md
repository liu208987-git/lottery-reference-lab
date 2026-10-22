# 贡献指南 · Contributing Guide

欢迎提 Issue / PR。先读完下面这几条再动手，能省大家时间。

## 原则底线（不会因为 PR 被改）

1. **这不是预测工具，也永远不会是**。任何声称能提高中奖概率的特征、模型、口号，都不会被合入。我们接受的是"统计可视化 / 审美过滤 / 组合数学工具"，不接受"机器学习预测下一期"这类 PR。
2. **不接受涉及未成年人引导购彩的功能**。
3. **不接受封闭式爬虫**。数据源要可替换、失败要有清晰日志。
4. **避免依赖膨胀**。前端不要 npm 依赖，坚持 0-build；抓取脚本坚持 Python 标准库（xlsx 除外）。

## 开发环境

- Node.js ≥ 18（前端测试需要）
- Python ≥ 3.10（抓取/解析脚本）
- 任何静态 HTTP 服务器（推荐 `python -m http.server 5173`）

起服务器：

```bash
npm run serve
# 打开 http://localhost:5173/
```

跑测试：

```bash
npm test              # 前端模块（node --test）
npm run test:py       # 抓取脚本（unittest）
```

## 提 PR 前

- [ ] 相关模块有单测覆盖，`npm test` 和 `npm run test:py` 都绿
- [ ] 在 5173 本地启服务后，手动走一遍相关 Tab
- [ ] 若改了数据源逻辑，用 `--fixture` 走过一次离线路径
- [ ] 不要修改 `data/draws.json` / `data/draws.js`（这两个文件由抓取脚本自动生成）
- [ ] commit 使用 `type(scope): subject` 风格：`feat(chart) / fix(generator) / docs(readme) / chore(ci)`

## 代码风格

- 前端使用原生 ES modules，**禁止**引入构建工具
- 保持模块职责单一：`stats.js` 纯函数 / `chart.js` 只做 SVG / `ui.js` 只操 DOM
- 不要引入 jQuery / Lodash 这类 runtime 依赖
- 变量命名用英文；UI 文案用中文（未来会通过 i18n 拆分）

## 新功能参与建议（按优先级）

想参与但没方向的话，可以从这些开始：

- [ ] 移动端走势图的横向滑动改进
- [ ] 深色/浅色主题切换
- [ ] 英文 i18n（文案抽成 JSON 字典）
- [ ] 蒙特卡洛模拟面板（"如果你按 X 策略买 10 年，期望回报？"）
- [ ] PWA：Service Worker 缓存，离线可用
- [ ] API 模式：把 `data/draws.json` 包装成轻量 REST 响应（可以是 `/latest` / `/by-issue/:id`）
- [ ] 导出 CSV / PNG 截图

## 报 Bug

请在 Issue 里提供：
1. 复现步骤（点了哪些按钮、输入了什么）
2. 期望 vs 实际行为
3. 浏览器 / OS
4. 如果是数据问题，贴出对应的期号

## 联系

- Issue 区是首选，PR 欢迎
- 敏感问题（安全漏洞等）请走 GitHub 的私有 security advisory 渠道
