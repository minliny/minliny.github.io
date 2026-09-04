# Deployment

## 当前真实部署状态

- GitHub Actions：已实现
- GitHub Pages：已实现
- 主站服务器部署：工作流已实现，启用前需完成服务器 forced command 和仓库凭据配置
- Vercel：待配置
- Netlify：待配置

## GitHub Actions + GitHub Pages + 主站服务器

仓库包含工作流文件 [deploy-blog.yml](../.github/workflows/deploy-blog.yml)。

当前流程：

1. 推送到 `main`，每 30 分钟定时检查，或由 `repository_dispatch` 触发
2. 在 `blog-frontend/` 执行 `npm ci`
3. 根据仓库名选择 Notion 或公开 fixtures 内容源
4. Notion 模式生成 `.content/notion/` 无状态全量快照
5. 空 Excerpt 通过 GitHub Models 生成摘要并写回 Notion 作为缓存
6. 使用 `https://blog.minliny.com` 作为 `SITE_URL`，单次构建并校验 `blog-frontend/dist/`
7. 保存精确命名的不可变快照，同时部署到 GitHub Pages
8. 下载同一快照，打包并计算 SHA-256，通过受限 forced-command SSH 部署到主站服务器
9. 两边部署成功后检查 canonical 主域和 Pages 镜像的首页及 `content-manifest.json`

## 需要的 GitHub Secrets

在 GitHub 仓库设置中添加：

- `NOTION_TOKEN`
- `NOTION_DATABASE_ID`
- `BLOG_DEPLOY_SSH_KEY`

还需要配置仓库 Variables：

- `BLOG_SSH_HOST`
- `BLOG_SSH_USER`
- `BLOG_SSH_KNOWN_HOSTS`（服务器公开主机密钥）

说明：

- 当前 Pages 工作流固定使用 `https://blog.minliny.com` 作为 canonical `SITE_URL`。
- GitHub Models 使用 Actions 自带的 `github.token` 和 `models: read`，不需要新增 API Key Secret。
- 只有 `minliny.github.io` 仓库读取 Notion Secrets；模板仓库使用 `content/fixtures`。
- 不要把真实 Token 写入代码库或提交到 `.env.example`。
- `site.config.json` 中的 `repository` 保持为 `https://github.com/minliny/MoZhu_Blog`，它是开源入口，不参与 canonical 地址推导。
- 部署公钥必须由服务器绑定受限 forced command，只接收 `deploy <commit> <run_id> <sha256>`；不要把私钥或 known_hosts 内容提交到仓库。

## GitHub Pages 设置建议

1. 打开仓库 `Settings`
2. 进入 `Pages`
3. 确认 Source 使用 GitHub Actions
4. 首次推送到 `main` 后检查 Actions 是否成功

## 预期访问地址

- 仓库地址：[https://github.com/minliny/MoZhu_Blog](https://github.com/minliny/MoZhu_Blog)
- canonical 主域：[https://blog.minliny.com](https://blog.minliny.com)
- GitHub Pages 镜像：[https://minliny.github.io](https://minliny.github.io)

Notion 更新、手动发布和回滚步骤见 [BLOG_PUBLISHING.md](../BLOG_PUBLISHING.md)。

## 其他平台

### Vercel

待配置。

### Netlify

待配置。
