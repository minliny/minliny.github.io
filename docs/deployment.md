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
5. 从正文自动提取摘要，并读取 Notion 的创建时间和更新时间
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
- 只有 `minliny.github.io` 仓库读取 Notion Secrets；模板仓库使用 `content/fixtures`。
- 不要把真实 Token 写入代码库或提交到 `.env.example`。
- `site.config.json` 中的 `repository` 保持为 `https://github.com/minliny/MoZhu_Blog`，它是开源入口，不参与 canonical 地址推导。
- 部署公钥必须由服务器绑定受限 forced command，只接收 `deploy <commit> <run_id> <sha256>`；不要把私钥或 known_hosts 内容提交到仓库。

## 主站服务器发布器

受限发布器的完整源码和自测位于 [`ops/static-blog/`](../ops/static-blog/README.md)。服务器将这些文件安装在 `/opt/scripts/static-blog/`，部署账号只接收构建产物，不在服务器运行 Node.js，也不接触 Notion Token。

服务器还需要加载 [`nginx-health.conf`](../ops/static-blog/nginx-health.conf) 中的回环监听。它只绑定 `127.0.0.1:8080` 并只提供五个发布校验文件；原子切换后，发布器逐文件比较 HTTP 响应和 release 文件的 SHA-256。公网 HTTPS 由工作流的双域 smoke 独立验证。

上线前在服务器执行：

```bash
cd /opt/scripts/static-blog
./test-static-blog-release.sh
sudo nginx -t
```

`authorized_keys` 必须把专用 Actions 公钥绑定到绝对路径，并关闭 SSH 侧通道：

```text
restrict,command="/opt/scripts/static-blog/github-blog-deploy-entrypoint.sh" ssh-ed25519 AAAA... github-actions:minliny/minliny.github.io
```

发布器固定仓库、域名、目录和资源上限，忽略 SSH 客户端提供的同名环境变量。每个 release 以 `commit-runId` 命名，完成后不会自动删除，以便人工回滚。

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
