# Blog Frontend

纯静态博客前端，可直接部署到普通静态服务器或 GitHub Pages。

## 本地运行

在项目目录执行：

```bash
python3 -m http.server 4173
```

然后访问：

- `http://127.0.0.1:4173/index.html`
- `http://127.0.0.1:4173/post.html?slug=doing-interesting-things`

如果需要从当前目录直接服务 `blog-frontend`：

```bash
python3 -m http.server 4173 --directory blog-frontend
```

## GitHub Pages 部署

1. 将 `blog-frontend` 目录内容推到仓库根目录，或把仓库 Pages Source 指向该目录对应的构建产物目录。
2. 使用 `main` 分支或 `gh-pages` 分支作为 Pages 发布源。
3. 如果站点不是部署在根域名，而是部署在 GitHub Pages 的仓库子路径下，发布前先生成 RSS：

```bash
SITE_URL="https://<your-name>.github.io/<repo-name>" node scripts/generate-rss.js
```

4. 部署后访问：

- `https://<your-name>.github.io/<repo-name>/index.html`
- `https://<your-name>.github.io/<repo-name>/post.html?slug=...`

## 普通服务器部署

1. 把整个目录上传到 Nginx / Caddy / Apache 的静态站点根目录。
2. 确保以下文件可被公开访问：
   - `index.html`
   - `post.html`
   - `style.css`
   - `app.js`
   - `post.js`
   - `posts.json`
   - `posts/*.md`
   - `feed.xml`

## RSS 生成

RSS 文件由脚本生成，不是运行时动态生成。

发布前请执行：

```bash
node scripts/generate-rss.js
```

如果要生成适用于 GitHub Pages 子路径的绝对链接：

```bash
SITE_URL="https://<your-name>.github.io/<repo-name>" node scripts/generate-rss.js
```

脚本会：

- 读取 `posts.json`
- 取最近 20 篇文章
- 输出 `feed.xml`

每次发布前都需要重新执行一次该脚本。
