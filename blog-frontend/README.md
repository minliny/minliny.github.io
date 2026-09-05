# blog-frontend

这个目录是站点前端和构建脚本的实际实现目录。

## Notion 写作约定

Notion 数据库只需配置 `名称`、`Status` 和 `Group` 三个属性。默认文章模板把 `Status` 设为 `Draft`、`Group` 设为 `notes`。作者填写名称和页面正文，完成后把状态改为 `Published`。

文章 URL、创建时间、更新时间和摘要由同步程序根据页面 ID、Notion 系统时间和正文自动生成。新增 `Group` 选项会随下一次发布自动出现在网站中。

## 常用命令

```bash
npm install
npm run sync:notion
npm run sync:notion:dry
npm run build:fixtures
npm run validate
npm run serve
```

## 环境变量

运行时会读取当前目录下的 `.env` 文件。

请参考：

- `./.env.example`
- `../README.md`
- `../docs/setup.md`
- `../docs/notion-database.md`
- `../docs/deployment.md`

## 目录说明

- `scripts/sync-notion.js`: 生成 `.content/notion/` 全量内容快照
- `scripts/build-site.js`: 将 fixtures 或 Notion 快照生成到 `dist/`
- `scripts/validate-dist.js`: 检查文件、HTML、链接和内容 manifest
- `content/fixtures/`: 无凭据本地预览用文章
- `dist/`: 最终发布目录（本地生成，不提交）
