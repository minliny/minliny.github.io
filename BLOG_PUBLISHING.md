# 博客更新与发布

## 日常更新

1. 使用 Notion 数据库的默认文章模板新建页面。模板会自动设置 `Status = Draft`。
2. 填写名称和页面正文。这是日常写作唯一必须填写的内容。
3. 写完后将 `Status` 改为 `Published`。保持 `Draft` 的页面不会发布。
4. 保存后等待 `Deploy Blog` 工作流自动执行。定时任务在每小时的第 17、47 分钟检查一次，GitHub Actions 忙时可能延迟。
5. 需要立即发布时，在 GitHub Actions 的 `Deploy Blog` 页面点击 **Run workflow**。
6. 发布完成后检查主域 [blog.minliny.com](https://blog.minliny.com) 和 Pages 镜像 [minliny.github.io](https://minliny.github.io)。

文章地址根据 Notion 页面 ID 自动生成，修改名称不会改变地址。创建时间和更新时间读取 Notion 的页面时间，摘要从正文自动提取，这些信息都不需要手工填写。Notion 不配置分类；分类由 Git 和构建层处理，未指定时统一归入站点默认分类 `notes`。删除或下线文章时，先改为 `Draft`，不要直接删除 Notion 页面。

## 自动发布链路

生产发布仓库的 `main` 分支推送、手动触发、`notion_publish` 事件和定时检查都会启动工作流。生产仓库从 Notion 生成快照；模板仓库只构建公开 fixtures。每轮只构建一次，通过校验后由 Pages 和主站服务器共同使用该不可变快照。

GitHub 仓库需要配置 Secrets `NOTION_TOKEN`、`NOTION_DATABASE_ID`、`BLOG_DEPLOY_SSH_KEY`，以及仓库 Variables `BLOG_SSH_HOST`、`BLOG_SSH_USER`、`BLOG_SSH_KNOWN_HOSTS`。服务器 SSH 公钥应绑定只接受 `deploy <commit> <run_id> <sha256>` 的 forced command；工作流不会在仓库文件中保存私钥或 host key。

构建使用 `https://blog.minliny.com` 作为 `SITE_URL`。同一份不可变构建快照会部署到主站服务器和 GitHub Pages；只有两边部署都成功后才执行双域 smoke。`minliny.github.io` 页面中的 canonical、Open Graph、RSS、sitemap、manifest 和 robots 都指向主域。`site.config.json` 中的 `repository` 仍指向 `minliny/MoZhu_Blog`，作为开源项目入口。

## 回滚

- 文章内容错误：在 Notion 恢复正确版本，或把文章改回 `Draft`，然后手动运行 `Deploy Blog`。
- 代码错误：对错误提交执行 `git revert <commit>`，审查后推送到 `main`。不要强制改写 `main` 历史。
- 需要取证或恢复旧产物时：从对应 Actions 运行下载 `site-snapshot-<commit>-<run>`；快照保留 90 天。当前工作流不会自动部署下载的旧快照，恢复前仍需人工核对其内容、SHA-256 和来源。

工作流失败时先查看 `Test content and build code`、`Build site once`、`Validate publish artifact` 或双域 smoke 的失败步骤。双域 smoke 会等待缓存传播，并校验 JSON/XML、首篇文章、CSS、JavaScript 以及两域核心文件的 SHA-256；持续不一致通常表示一侧仍是旧版本。新的 Pages 部署成功前，线上通常仍保留上一版可用产物。
