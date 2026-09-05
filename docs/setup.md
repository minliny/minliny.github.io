# Setup

## 前置要求

- Node.js 20 或更高版本
- npm 10 或更高版本
- 一个可访问目标数据库的 Notion Integration
- 一个按 [Notion 数据库说明](notion-database.md) 配置的数据库

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

## 配置 Notion 写作模板

数据库只需要两个属性：

- `名称`：title
- `Status`：select，包含 `Draft` 和 `Published`

创建一个默认文章模板，将 `Status` 设为 `Draft`。作者新建文章后只需填写名称和正文，完成后将状态改为 `Published`。Notion 无需配置分类；分类由 Git 和构建层处理，缺失时使用站点默认分类 `notes`。完整步骤见 [Notion 数据库说明](notion-database.md)。

## 首次验证

```bash
cd blog-frontend
npm run sync:notion:dry
npm run build:notion
npm run validate
npm run serve
```

如果以上命令都正常完成，说明本地环境基本可用。
