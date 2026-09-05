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

## Published 文章没有生成

原因：

- 文章名称为空
- 页面正文为空
- `Status` 的值不是大小写完全一致的 `Published`

处理：

1. 填写文章名称和页面正文
2. 发布时把 `Status` 改为 `Published`
3. 文章地址由页面 ID 自动生成，无需填写地址字段

## GitHub Actions 部署失败

重点检查：

- GitHub Secrets 中是否已配置 `NOTION_TOKEN`
- GitHub Secrets 中是否已配置 `NOTION_DATABASE_ID`
- 仓库 Pages Source 是否设置为 GitHub Actions
- `npm ci` 是否能正常安装依赖

## 文章进入了默认分组

原因：

- 文章没有选择 `Group`

处理：

- 这是预期行为，未选择时使用 `notes`
- 需要新分组时，直接在 Notion 的 `Group` 字段新增选项并选择；网站会在下一次发布后自动显示

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
