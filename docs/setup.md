# Setup

## 前置要求

- Node.js 20 或更高版本
- npm 10 或更高版本
- 一个可访问目标数据库的 Notion Integration
- 一个包含标题字段和 `Status` select 字段的 Notion 数据库

## 安装步骤

```bash
cd blog-frontend
npm install
cp .env.example .env
```

然后在 `blog-frontend/.env` 中填写：

- `NOTION_TOKEN`
- `NOTION_DATABASE_ID`
- `SITE_URL`（可选；默认使用 `site.config.json` 中的 `https://blog.minliny.com`）

## 首次验证

```bash
cd blog-frontend
npm run sync:notion:dry
npm run build:notion
npm run validate
npm run serve
```

如果以上命令都正常完成，说明本地环境基本可用。
