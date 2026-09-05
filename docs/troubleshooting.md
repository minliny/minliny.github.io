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

## 文章显示在 `notes` 分类

原因：

- Notion 不负责配置文章分类
- 构建层没有为文章指定其他分类

处理：

- 这是预期行为，缺失分类时使用站点默认分类 `notes`
- 需要调整分类时，在 Git 或构建层修改分类配置，不要在 Notion 中添加分类字段

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
