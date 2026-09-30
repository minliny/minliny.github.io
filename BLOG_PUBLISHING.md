# 博客更新与发布

生产仓库是 `minliny/minliny.github.io`，源码来自 `main`。GitHub Pages 托管静态站点，Actions 同步 Notion、判断变化并发布，Releases 保存精确恢复产物。模板仓库只运行 fixtures 检查，不发布生产站点。

## 日常更新

1. 使用 Notion 默认文章模板新建页面，模板设置 `Status = Draft`。
2. 填写名称和页面正文。写完后把状态改成 `Published`。
3. 等待 `Deploy Blog`。定时器在每小时第 17、47 分钟检查；GitHub 调度可能延迟。
4. 需要立即检查时，在 Actions 的 `Deploy Blog` 页面点击 **Run workflow**，选择 `main`。通常保持 `force=false`。
5. 根据 Actions 结果确认这是通过站点检查的无变化运行，或归档、Pages 激活和公网检查都成功的新版本。
6. 打开 [blog.minliny.com](https://blog.minliny.com) 检查文章。迁移期间检查地址以仓库变量 `BLOG_SMOKE_BASE_URL` 为准。

文章路径由 Notion 页面 ID 稳定生成，修改标题不改地址。创建时间和更新时间读取 Notion 系统时间，摘要从正文提取。分类由 Git 和构建层处理，缺失时用 `notes`。日常写作无需填写这些信息。

内容、媒体或生成器没有变化时不重新构建、不新增归档或 Pages artifact，也不重新部署；工作流仍下载可信归档并检查正在提供的站点。`force=true` 用于内容未变时主动重新发布当前候选，它仍要使用经验证的生成器并通过归档和部署检查，不能绕过暂停变量或恢复旧版本。

## 配置与发布门禁

| 类型 | 名称 | 要求 |
| --- | --- | --- |
| Repository secret | `NOTION_TOKEN` | 只给生产同步步骤使用 |
| Repository secret | `NOTION_DATABASE_ID` | 生产内容数据库 |
| Repository variable | `BLOG_PUBLISH_PAUSED` | 明确设为 `true` 或 `false`；缺失、空值或其他值拒绝生产激活 |
| Repository variable | `BLOG_SMOKE_BASE_URL` | 切域前 `https://minliny.github.io`，切域后 `https://blog.minliny.com` |
| Workflow env | `SITE_URL` | 固定 `https://blog.minliny.com`，与验收请求地址独立 |
| Workflow env | `ALLOW_EMPTY_NOTION_SYNC` | 生产保持 `0`，错误空快照不能清空网站 |
| GitHub environment | `github-pages` | 限定可信生产 `main` 的发布及回滚 |
| Pages source | GitHub Actions | 自定义域与 HTTPS 另在仓库 Pages 设置中配置 |

不需要 SSH 发布凭据或长期 GitHub PAT。Actions 内置 `GITHUB_TOKEN` 按 job 权限访问归档和 Pages。Notion Token、`.env`、原始同步目录与私钥不得放入站点或 Release。

工作流同步 Published 集合，核对内容 manifest 与真实 Markdown、媒体文件，然后生成三个稳定指纹。抓取时间和 run ID 不参与变化判断；正文、标题、日期、分类、aliases、媒体字节以及生产脚本、运行时、配置、依赖和 Node 版本变化会影响指纹。代码测试失败后，后续定时任务不能绕过尚未验证的生成器版本。

正常发布与回滚共享 `blog-pages-production-${{ github.repository }}` 串行组，激活前再次检查当前 `main` 和暂停状态。网站 manifest、精确归档、部署成功和公网检查通过分别表示不同阶段，不能把 Release 存在当成上线验收成功。

## 发布归档和撤稿

实际发布生成唯一 tag `site-<run_id>-<run_attempt>`，指向真实源码 commit，上传以下资产：

- `site.tar.gz`：该次生产 `dist/` 的原始字节，包括 `.nojekyll`。
- `release-manifest.json`：仓库、commit、tag、canonical、指纹、环境、归档 SHA-256 与逐文件 hash。
- `SHA256SUMS`：归档和外部 manifest 的 SHA-256。

先完整上传并核验归档，再激活 Pages。Release 在激活前公开，Published 候选文章可能已通过归档被下载，即使随后部署失败。Draft 不进入归档。GitHub 自动生成的源码 zip/tarball 不是站点恢复包；恢复只使用上述明确上传的资产，不使用 Release `latest` 判断当前网站版本。

下线文章时先改回 `Draft`，再运行正常发布。空快照保护会拒绝下线后无任何 Published 文章的情况；确需清空站点须单独审查，不能关闭门禁来绕过错误同步。下线只影响下一版站点，历史 Releases、旧站点快照和已下载副本仍可能包含文章。需要彻底撤稿时，必须按文章路径核对相关历史归档和备份，另行处理保留边界。

Pages 传输 artifact 只保留 1 天。迁移后 30 天内不清理 Release；此后清理前保留最近 20 个成功版本，并保护迁移 baseline、当前版本、上一稳定版本及手工固定版本。清理动作需依据已核验的成功记录和保护集执行，不以 `latest` 或创建时间单独判断，也不删除整个 Actions run 或其他项目产物。

## 修复内容或代码

- 内容错误：在 Notion 恢复正确内容，或改回 `Draft`；候选通过检查后运行正常发布。
- 代码错误：审查 `git revert <commit>` 后推送 `main`；不要强制改写历史。
- 需要立刻恢复已知网站字节：执行下面的精确回滚。回滚不运行 Notion 同步，也不重建旧源码。

## 精确回滚与暂停协议

先设置暂停、禁用正常 workflow 并处理未完成运行。只设变量不能停止已运行或排队的任务：

```bash
gh variable set BLOG_PUBLISH_PAUSED --repo minliny/minliny.github.io --body true
gh workflow disable deploy-blog.yml --repo minliny/minliny.github.io
gh run list --repo minliny/minliny.github.io --workflow deploy-blog.yml --limit 100 --json databaseId,status,headSha,event
```

核对清单后逐个取消确认为 queued/in_progress 的正常运行，等它们进入终态，并确认 Pages deployment 已结束。不要取消无关项目。然后选择已独立核验的 Release 和归档 SHA-256，在 Actions 的 **Rollback Pages** 输入 `release_tag`、`expected_archive_sha256`，可填回滚说明；必须从当前可信 `main` 执行。

也可以使用来自核验记录的变量：

```bash
gh workflow run rollback-pages.yml --repo minliny/minliny.github.io --ref main \
  -f release_tag="$BLOG_RELEASE_TAG" \
  -f expected_archive_sha256="$BLOG_ARCHIVE_SHA256"
```

回滚核对仓库、域名、tag、源码、归档 hash 与展开大小，拒绝越界路径、重复项、链接和特殊文件。安全解包后逐文件检查，上传短期 Pages artifact，恢复原网站字节，再按所选归档检查正式域。失败时查看具体阶段，不改用关闭 TLS 或忽略 hash 的方式通过检查。

迁移前基线保留旧网站字节，外部 manifest 明确标记 `legacyBaseline` 和旧 schema。只有经独立核验 hash 的指定基线可使用 legacy 严格验证；普通 Release 必须带完整的新身份和指纹。不得修改旧网站 manifest 伪造新字段。

回滚成功后保持 `BLOG_PUBLISH_PAUSED=true`，正常 workflow 保持禁用。修复 Notion 或 main 并核验候选后，才明确设为 `false`、启用正常 workflow 并手动检查。否则下一次定时器可能重新发布错误内容。

## 迁移与服务器观察期

域名和 HTTPS 的切换步骤见 [部署说明](docs/deployment.md)。正式切换通过后至少观察 7 天，包含一次实际更新发布、一次无变化检查和一次精确恢复演练，再退出服务器上的 Blog 专用部署 key、vhost、回环健康检查和旧定时入口。旧服务器 `/srv/blog/current`、`/opt/releases/blog` 与 `.incoming` 至少保留 30 天，并保存本机离线恢复包。

迁移观察期如 Pages 或域名无法验收，可以恢复记录好的 Blog DNS 原记录和代理状态，继续使用保留源站。GitHub 故障时回滚 workflow 也可能不可用；源站退出后不再有永久独立镜像。不要停用共享 Nginx、SSH、Reader 环境或销毁整台服务器。

本文件描述仓库中的发布和恢复流程。实际 DNS、首次正式发布、恢复演练及观察期完成情况须以对应运行和配置记录确认。
