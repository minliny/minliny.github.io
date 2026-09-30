# Troubleshooting

## `Missing required environment variables`

`NOTION_TOKEN` 或 `NOTION_DATABASE_ID` 缺失或为空。检查本地 `blog-frontend/.env`，或生产仓库同名 Secrets。不要在日志中输出完整 Token。`SITE_URL` 未设置时使用站点配置主域。

## `No published Notion pages found`

检查数据库是否共享给 Integration，是否至少有一篇状态大小写完全为 `Published` 的文章。空快照保护能防止权限或数据库配置错误清空线上，生产保持 `ALLOW_EMPTY_NOTION_SYNC=0`。本地确需测试空库时可以显式设置 `1`，该结果不能直接作为生产发布候选。

## Published 文章没有生成

检查标题、正文、Integration 权限以及 `Status` 是否为完全一致的 `Published`。文章路径由页面 ID 自动生成，无需填地址字段。文章在 `notes` 分类是缺少构建层分类配置时的正常行为，不需要给 Notion 增加分类字段。

## 本地预览没有最新文章

dry-run 不写快照。确认实际执行了以下命令，并打开正确服务端口：

```bash
cd blog-frontend
npm run sync:notion
npm run build:notion
npm run validate
npm run serve
```

`npm run build` 和 `npm run check` 使用 fixtures，不能用它们验证生产内容已更新。

## 生产发布被暂停或变量无效

`BLOG_PUBLISH_PAUSED` 必须明确是 `true` 或 `false`。缺失、空值或其他值拒绝生产激活，`force=true` 也不能绕过。准备迁移和回滚时的 `true` 是正常门禁；确认候选与切换窗口允许发布后再明确设 `false`。

核对 `BLOG_SMOKE_BASE_URL`：切域前为 `https://minliny.github.io`，切域后为 `https://blog.minliny.com`。构建的 canonical `SITE_URL` 始终保持正式主域，不要为了迁移前检查改成 github.io。

## 为什么运行成功但没有新 Release

这是内容和生成器指纹相同且线上检查成功的无变化运行。同步时间变化不应触发新构建、artifact、归档或部署。需要主动重新发布当前候选时可手动开启 `force`，但它不会恢复旧 Release。

指纹相同的任务仍应核验可信归档并检查站点。线上 manifest 读取失败、旧 schema 或归档身份不匹配不能静默算无变化；查看对应步骤错误并修复，不能仅凭 HTTP 200 认定已部署。

## GitHub Actions 显示额度或账单错误

先保存失败仓库、run ID、完整错误类型和失败步骤，分清标准 runner 分钟、artifact 存储、上传能力或账户账单限制。公开仓库标准 GitHub-hosted runner 分钟免费，但其他私有仓库额度与账户限制可能仍阻止相关操作。Pages-only 减少 job 与长期 artifact，并不能解除所有账户限制。

检查当前站点对应 run 是否确实失败。临时 Pages artifact 保留 1 天，Release 是恢复归档，不再每轮新增 90 天 `site-snapshot-*`。旧 artifact 清理前必须有已核验基线和保护记录，逐项处理，不删除整个 run 或其他项目产物。依据见 [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。

## 归档存在但部署或 smoke 失败

先区分同步、测试、构建、归档、Pages 激活和公网检查阶段：

- 归档阶段失败：核对产物路径、大小、SHA-256、Release/tag 来源与权限；同 tag 不覆盖资产或移动到其他 commit。
- Pages 激活失败：检查 Pages Source、`github-pages` 环境、暂停值、最新 `main` 和部署权限。过期候选退出不能通过重试旧 run 强行覆盖当前 main。
- Pages 成功、smoke 失败：网站可能已经切换，核对期望 Release、站点 manifest、逐文件 hash、MIME、canonical、404 与缓存。相同指纹的下一轮也必须继续检查或修复。

Release 在激活前公开，部署失败时 Published 候选仍可能已被下载。不能将“工作流失败”等同“文章从未公开”。不要使用 Release `latest` 作为线上版本证明；不要把 GitHub 自动源码附件当网站恢复产物。

## 自定义域 HTTPS 或入口跳转异常

先核对仓库 Pages Custom domain，再核对 Cloudflare Blog 同名记录。初期使用 `CNAME blog → minliny.github.io`、DNS-only，删除同名冲突 A/AAAA。GitHub 账户域名验证使用页面提供的真实 TXT 名称和值；添加 CNAME 文件不能替代 Pages Settings。

证书签发和 DNS 传播可能延迟；检查 DNS 状态、CAA 和仅对该主机生效的旧 redirect/origin 规则。不得关闭 TLS 校验或修改全区 SSL 模式。恢复 Cloudflare 代理时另行验证有效证书、Full (strict)、缓存和 HTML 改写。

`minliny.github.io` 在自定义域配置后可能重定向到正式域，应保留路径。两个地址此时是同一站点入口，不能继续当独立镜像互相证明正确版本。正式域未通过验收时，观察期按已保存的原 DNS 和代理恢复旧源站。

## 回滚被拒绝或回滚后又出现错误内容

检查是否先设 `BLOG_PUBLISH_PAUSED=true`、禁用 `deploy-blog.yml`、处理 queued/in_progress 运行并确认 Pages deployment 已结束。回滚从当前可信 `main` 执行，输入来自独立核验记录的 tag 和 `expected_archive_sha256`，不使用旧源码或重新同步 Notion。

归档路径、链接、特殊文件、hash、身份或容量检查失败时停止该候选，保留错误证据；不要跳过验证。旧迁移 baseline 只在外部 manifest 明确标记且 hash 独立核验时使用 legacy 严格模式，普通 Release 不允许降级。

恢复后仍保持暂停和正常 workflow 禁用。先修复 Notion/代码并核验候选，再解除暂停、启用正常 workflow。完整操作见 [回滚协议](../BLOG_PUBLISHING.md#精确回滚与暂停协议)。

## 文章改回 Draft 后还能下载

下一版正常站点会移除该文章，但历史 Release、旧 Actions artifact、观察期源站备份和读者已下载副本可能保留内容。彻底撤稿需按文章路径调查这些历史产物，再明确处理保留边界；下线不会自动删除历史版本。

## 迁移后服务器能否直接关闭

正式域验收后至少观察 7 天，含实际更新、无变化检查和恢复演练，再退出 Blog 专用部署 key、vhost、健康监听与旧定时器。`/srv/blog/current`、`/opt/releases/blog`、`.incoming` 至少保留 30 天，并保存离线包。

恢复工具仍在 [`ops/static-blog/`](../ops/static-blog/README.md)。不得停止共享 Nginx、SSH、Reader 或删除其他项目和用户数据。GitHub 服务故障时回滚也可能不可用，退出旧源站后没有永久独立镜像。实际退出状态以部署记录为准。
