# MoZhu_Blog

一个基于 Notion 作为内容源、纯静态页面作为前端的开源博客项目，同时也可以作为可复用模板继续定制。

## 项目链接

- [minliny/MoZhu_Blog](https://github.com/minliny/MoZhu_Blog)

## 项目截图

![MoZhu_Blog 首页截图](assets/screenshots/homepage.png)

## 适用场景

- 想用 Notion 作为博客 CMS
- 想把博客发布到 GitHub Pages
- 想保留纯静态站点的简单部署方式
- 想基于现成仓库快速改造成自己的个人博客

仓库当前实现位于 [blog-frontend](blog-frontend/)，核心流程是：

1. 从 Notion 数据库读取 `Published` 文章；作者只需填写名称和正文
2. 将正文、内容寻址媒体和 `manifest.json` 原子写入 `.content/notion/`
3. 在构建期把 Markdown 转成安全 HTML、索引、RSS、sitemap 和历史 Slug 重定向
4. 把同一份经过校验的 `blog-frontend/dist/` 发布到主站服务器和 GitHub Pages

## 核心功能

- Notion 数据库驱动内容发布
- 仅发布 `Status = Published` 的文章
- `Draft` 状态文章不会进入静态站点
- Notion 正文自动转换为 Markdown，并在构建期转成 HTML
- Notion 图片和文件镜像到内容寻址的本地媒体目录
- 生成文章索引 `posts.json`
- 生成 RSS `feed.xml`
- 生成 `content-manifest.json` 和 `sitemap.xml`
- 构建产物包含 CSP、HTML 消毒、协议白名单和完整性校验
- 通过 GitHub Actions 自动构建，并从同一快照部署主站服务器和 GitHub Pages
- 支持本地静态预览

## 设计说明

本项目的视觉方向、个人博客气质和部分信息结构设计，明确参考了 [xiaogai.fun](https://xiaogai.fun/)。

参考主要体现在以下层面：

- 极简个人博客首页结构
- 首页文章列表 + 文章详情页的双页组织
- 轻量的主题切换体验
- 偏中文写作场景的排版取向

同时，这个仓库在实现方式上做了明确区分，不是对原站点的代码复制：

- 内容来源改为以 Notion 数据库为发布后台
- 通过 Node.js 脚本将 Notion 页面同步为本地 Markdown
- 额外生成 `posts.json` 和 `feed.xml` 作为静态分发产物
- 使用 GitHub Actions 自动构建，并发布到主站服务器和 GitHub Pages
- 仓库结构、同步逻辑、发布链路和开源文档均按模板项目场景重新整理

如果你打算基于本项目继续定制，建议把站点文案、品牌名、配色、页眉页脚信息和示例文章替换为你自己的版本。

## 技术栈

- Node.js 20+
- 原生 HTML / CSS / JavaScript
- [@notionhq/client](https://www.npmjs.com/package/@notionhq/client)
- [gray-matter](https://www.npmjs.com/package/gray-matter)
- [dotenv](https://www.npmjs.com/package/dotenv)
- GitHub Actions
- GitHub Pages

## 项目结构

```text
.
├── .github/workflows/deploy-blog.yml
├── blog-frontend/
│   ├── content/fixtures/       # 模板预览内容，不是生产源
│   ├── scripts/sync-notion.js  # 生成 .content/notion 全量快照
│   ├── scripts/build-site.js   # 生成 dist/
│   ├── runtime/                # 渐进增强（主题、复制、旧链接）
│   ├── site.config.json
│   └── dist/                   # 本地构建产物（不提交）
├── docs/
└── examples/
```

## Notion 发布方式

日常写作只需要填写名称和正文。文章模板会自动把状态设为 `Draft`、分组设为 `notes`；写完后把状态改为 `Published` 即可发布。

| 字段名 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 名称 | `title` | 空 | 作者填写的文章标题 |
| Status | `select` | `Draft` | `Published` 时才发布 |
| Group | `select` | `notes` | 文章分组；可在 Notion 中新增选项 |

### Status 选项

- `Draft`
- `Published`

### 发布规则

- `Draft` 不发布，`Published` 才发布
- 名称和页面正文是作者唯一需要填写的内容
- 文章 URL 根据 Notion 页面 ID 稳定生成，修改标题不会改变地址
- 创建时间读取 Notion `created_time`，更新时间读取 `last_edited_time`
- 摘要自动从正文提取，不依赖 AI，也不需要 Notion 字段
- 未选择分组时使用 `notes`；在 Notion 新增分组选项后，网站会自动显示新分组
- 每 30 分钟自动检查一次 Notion 更新

更多字段说明见 [docs/notion-database.md](docs/notion-database.md)。

## 快速开始

### 1. 安装依赖

```bash
cd blog-frontend
npm install
```

### 2. 配置环境变量

复制 [blog-frontend/.env.example](blog-frontend/.env.example) 到 `blog-frontend/.env`，然后填入你自己的配置。

环境变量必须通过 `.env` 或 GitHub Secrets 配置，不要提交真实 Token。

本地需要显式覆盖 canonical 主域时，可在 `.env` 中配置：

```bash
SITE_URL=https://blog.minliny.com
```

### 3. 从 Notion 同步文章

```bash
cd blog-frontend
npm run sync:notion
```

### 4. 生成并校验静态产物

```bash
cd blog-frontend
npm run build:notion
npm run validate
```

没有 Notion 凭据时可使用模板 fixtures：

```bash
npm run build:fixtures
npm run validate
```

### 5. 本地运行

```bash
cd blog-frontend
npm run serve
```

默认访问地址：

- `http://127.0.0.1:4321/index.html`
- `http://127.0.0.1:4321/posts/hello-world/`

## 环境变量说明

| 变量名 | 必填 | 说明 |
| --- | --- | --- |
| `NOTION_TOKEN` | 是 | Notion Integration Token |
| `NOTION_DATABASE_ID` | 是 | Notion 数据库 ID |
| `SITE_URL` | 否 | canonical 主域，用于 Open Graph、RSS、sitemap、manifest 和 robots；默认读取 `site.config.json` |
| `ALLOW_EMPTY_NOTION_SYNC` | 否 | 设为 `1` 时允许数据库为空（默认拒绝空快照） |
| `CONTENT_DIR` | 否 | Notion 快照目录，默认 `.content/notion` |
| `STRICT_UNSUPPORTED_BLOCKS` | 否 | 高级严格模式；默认不因个别未支持 Block 阻止发布 |
| `NOTION_MEDIA_MAX_BYTES` | 否 | 单个媒体文件大小上限，默认 15 MiB |
| `NOTION_MEDIA_TIMEOUT_MS` | 否 | 媒体下载超时，默认 20 秒 |
| `GITHUB_TOKEN` | 否 | 仅在你自定义 GitHub API 调用时使用，当前 Actions Pages 部署流程不直接读取该值 |

## 本地运行方式

常用命令：

```bash
cd blog-frontend
npm run sync:notion
npm run build:notion
npm run validate
npm run serve
```

如果只想检查同步结果而不落盘：

```bash
cd blog-frontend
npm run sync:notion:dry
```

## GitHub Actions / 自动发布说明

当前仓库已经包含 GitHub Actions 工作流 [deploy-blog.yml](.github/workflows/deploy-blog.yml)。

真实逻辑如下：

1. `minliny.github.io` 仓库从 Notion 生成生产快照；模板仓库使用 `content/fixtures`
2. 每 30 分钟检查一次，也支持 `workflow_dispatch` 和 `repository_dispatch`（`notion_publish`）
3. 执行测试、单次构建和主域 URL 一致性校验
4. 上传 `blog-frontend/dist/`，同时保留带 Commit SHA 的 90 天快照
5. 从同一快照部署 Pages 和主站服务器，两边成功后检查双域首页与 `content-manifest.json`

需要在 GitHub 仓库 Secrets 中配置：

- `NOTION_TOKEN`
- `NOTION_DATABASE_ID`
- `BLOG_DEPLOY_SSH_KEY`

还需要配置仓库 Variables `BLOG_SSH_HOST`、`BLOG_SSH_USER` 和 `BLOG_SSH_KNOWN_HOSTS`。详情见 [BLOG_PUBLISHING.md](BLOG_PUBLISHING.md)。

当前站点地址：

- 主域：[https://blog.minliny.com](https://blog.minliny.com)
- Pages 镜像：[https://minliny.github.io](https://minliny.github.io)

日常更新和回滚步骤见 [BLOG_PUBLISHING.md](BLOG_PUBLISHING.md)。

## 部署方式

当前真实已实现部署方式：

- GitHub Pages：已实现
- GitHub Actions 自动部署：已实现
- 主站服务器部署：工作流已实现，启用前需配置受限 forced command、Secrets 和 Variables
- Vercel：待配置
- Netlify：待配置

详细说明见 [docs/deployment.md](docs/deployment.md)。

## 常见问题

常见问题与排查见：

- [docs/setup.md](docs/setup.md)
- [docs/troubleshooting.md](docs/troubleshooting.md)

## License

本项目使用 MIT License，见 [LICENSE](LICENSE)。
