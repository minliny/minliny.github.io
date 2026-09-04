# Troubleshooting

## `Missing required environment variables`

原因：

- `NOTION_TOKEN`
- `NOTION_DATABASE_ID`

至少有一个 Notion 必填变量未配置。`SITE_URL` 未设置时会使用 `site.config.json` 的主域。

处理：

1. 检查 `blog-frontend/.env` 是否存在
2. 检查变量名是否拼写正确
3. 检查值是否为空

## `No published Notion pages found`

原因：

- 数据库里没有 `Status = Published` 的文章
- Integration 没有访问数据库权限

处理：

1. 确认数据库共享给 Integration
2. 确认至少有一篇文章的 `Status` 为 `Published`
3. 如确实需要空库运行，可设置 `ALLOW_EMPTY_NOTION_SYNC=1`

## `Invalid slug`（仅手工填写 Slug 时）

原因：

- `Slug` 中包含大写字母、空格、下划线或中文

处理：

- 清空 Slug，让系统根据 Notion 页面 ID 自动生成；或
- 使用仅包含小写字母、数字和连字符的自定义 Slug

## `Slug conflict`

原因：

- 不同 Notion 页面使用了相同 `Slug` 或 `Aliases`
- 某个历史 Alias 与当前文章 Slug 冲突

处理：

1. 回到 Notion 检查重复 slug
2. 检查 `.content/notion/manifest.json` 中的 route 列表

## GitHub Actions 部署失败

重点检查：

- GitHub Secrets 中是否已配置 `NOTION_TOKEN`
- GitHub Secrets 中是否已配置 `NOTION_DATABASE_ID`
- 仓库 Pages Source 是否设置为 GitHub Actions
- `npm ci` 是否能正常安装依赖

## `AI summary request failed`

原因通常是 GitHub Models 未对仓库启用，或 Actions token 没有 `models: read` 权限。

处理：

1. 在仓库 Settings 中启用 GitHub Models
2. 确认工作流包含 `permissions: models: read`
3. 如果需要立即发布，可先手工填写 `Excerpt`

## 本地预览看不到文章

原因通常是：

- 尚未执行 `npm run build:notion`
- `dist/posts.json` 未更新
- 打开的是错误的端口或路径

处理：

```bash
cd blog-frontend
npm run build:notion
npm run validate
npm run serve
```
