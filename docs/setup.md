# Setup

## 前置要求

- Node.js 24，与生产 workflow 保持一致
- npm 和仓库 `package-lock.json`，使用 `npm ci` 安装锁定依赖
- 生产内容同步需要一个可访问目标数据库的 Notion Integration
- 数据库按 [Notion 数据库说明](notion-database.md) 配置；模板预览无需 Notion 凭据

## 无凭据模板预览

```bash
cd blog-frontend
npm ci
npm run check
npm run serve
```

默认 `npm run build` 也使用公开 fixtures。模板检查不进入生产发布，不读取生产数据库或配置生产环境。将 fixtures 构建成功当成 Notion 同步或正式部署成功是不成立的。

## 本地 Notion 配置

```bash
cd blog-frontend
npm ci
cp .env.example .env
```

在本机私有的 `blog-frontend/.env` 中填写 `NOTION_TOKEN` 和 `NOTION_DATABASE_ID`。`SITE_URL` 可显式配置为 `https://blog.minliny.com`，未设置时使用 `site.config.json` 的主域。真实 Token 不得提交，也不得复制到静态产物或 Release。

数据库只需要 `名称`（title）和 `Status`（select，包含 `Draft`、`Published`）两个属性。默认文章模板把状态设为 `Draft`。作者填写标题和正文，完成后设为 `Published`；分类由 Git/构建层管理，缺失时用 `notes`。

## 本地生产候选验证

```bash
cd blog-frontend
npm run doctor:notion
npm run sync:notion:dry
npm run sync:notion
npm test
npm run build:notion
npm run validate
npm run serve
```

dry-run 只查看同步结果，不生成 `.content/notion`。必须执行实际 `sync:notion` 后再构建新的生产快照。保留 `ALLOW_EMPTY_NOTION_SYNC=0` 的生产空快照保护。

这些检查证明当前本地源码和快照可构建，不证明 Release 上传、Pages 部署、自定义域 HTTPS 或线上检查已通过。正式候选的指纹、归档和线上身份由发布 workflow 继续核验。

## 生产仓库设置

生产入口只接受公开仓库 `minliny/minliny.github.io` 的可信 `main`。在仓库 `Settings → Secrets and variables → Actions` 配置：

| 类型 | 名称 | 初始值或要求 |
| --- | --- | --- |
| Secret | `NOTION_TOKEN` | 目标数据库 Integration Token |
| Secret | `NOTION_DATABASE_ID` | 生产数据库 ID |
| Variable | `BLOG_PUBLISH_PAUSED` | 准备阶段明确设 `true`；解除暂停时设 `false`；空值或其他值拒绝激活 |
| Variable | `BLOG_SMOKE_BASE_URL` | 切域前 `https://minliny.github.io`，正式验收后改成 `https://blog.minliny.com` |

在 `Settings → Environments` 核对 `github-pages` 只允许可信 `main`，在 `Settings → Pages` 使用 GitHub Actions。自定义域设置和 DNS 变更按 [部署说明](deployment.md) 的切换顺序执行；配置文件存在不代表域名已切换。

新流程不需要 SSH Secrets，也无需长期 GitHub PAT。旧服务器凭据仅在至少 7 天观察通过并关闭旧入口后移除；旧源站产物至少保留 30 天。

正常运行 `Deploy Blog` 时 `force` 默认关闭；开启会重新发布当前候选，但仍服从暂停与检查。手动恢复旧产物使用 `Rollback Pages`，必须先暂停、禁用正常 workflow 并处理未完成任务，成功后保持暂停。详见 [发布与回滚](../BLOG_PUBLISHING.md)。
