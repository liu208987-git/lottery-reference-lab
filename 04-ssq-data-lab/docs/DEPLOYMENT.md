# Deployment · 部署指南

## 推荐：双通道部署

| 通道 | 目标受众 | 国内访问 | 备案要求 | 当前状态 |
|---|---|---|---|---|
| [GitHub Pages](https://wanghao137.github.io/ssq-data-lab/) | 海外 / 技术用户 | 时好时坏 | ❌ | ✅ 已上线 |
| [**Cloudflare Pages**](https://ssq-data-lab.pages.dev/) | 国内用户 | 相对稳定 | ❌ | ✅ 已上线 |

## 1. GitHub Pages（自动）

已配置 `.github/workflows/pages.yml`：

1. 仓库 Settings → Pages → Build and deployment → Source 选 **GitHub Actions**
2. push 到 `main` 即触发部署
3. 访问地址：<https://wanghao137.github.io/ssq-data-lab/>

## 2. Cloudflare Pages（国内友好，推荐）

CF Pages 不需要备案，免费额度无限，在国内访问比 vercel.app / netlify.app 稳定。

**步骤（踩坑后的正确版）**：

1. 登录 <https://dash.cloudflare.com/> → **Workers & Pages**
2. 点 **Create application**，**务必选 Pages 标签页，不是 Workers**
   - 两者 UI 相似，走错会用 Worker 模式部署（拉 wrangler 二进制会超 25MB 大小限制）
   - 如果找不到 Pages 入口，直接用 URL：`https://dash.cloudflare.com/?to=/:account/pages/new`
3. 选 **Connect to Git** → 授权并选中这个仓库
4. Build 配置：
   - Project name: `ssq-data-lab`（决定 `xxx.pages.dev` 前缀）
   - Production branch: `main`
   - **Framework preset: None**（必须）
   - **Build command: 留空**
   - **Build output directory: 留空**（或填 `/`）
5. **Save and Deploy**

1-2 分钟后即自动上线，本项目实测：<https://ssq-data-lab.pages.dev/>

### 绑自定义域名

Cloudflare Pages → Custom domains → Set up a custom domain → 按提示改 DNS CNAME 即可。

## 3. 其他托管

- **Netlify** / **Vercel**：同样 connect-to-git 即可；`vercel.app` 在国内访问较差
- **腾讯云 COS / 阿里云 OSS**：更稳但**需要备案**才能开静态网站；适合自有域名的正式项目
- **GitCode Pages**：国内 Gitee 式服务，需要账号实名

## 4. 本地预览

```bash
npm run serve
# 打开 http://localhost:5173/
```

## 数据更新

`data/draws.json` 与 `data/dlt-draws.json` 会由 `.github/workflows/update-data.yml` 自动维护；workflow 每天北京时间 22:30 运行，无新开奖时自动 no-op。
部署流水线只需上传静态文件，不需要运行 Python。
