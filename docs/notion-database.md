# Notion 数据库

本项目使用一个 Notion 数据库作为博客内容源。作者只需填写文章名称和页面正文；发布状态、默认分组由数据库模板预设，其余公开信息由同步程序自动生成。

## 最小字段

| 字段名 | Notion 类型 | 模板默认值 | 用途 |
| --- | --- | --- | --- |
| 名称 | `title` | 空 | 文章标题，作者填写 |
| Status | `select` | `Draft` | `Published` 时才发布 |
| Group | `select` | `notes` | 文章分组 |

文章正文直接写在 Notion 页面中，不需要额外的数据库字段。

`Status` 只需两个选项：

- `Draft`：草稿，不发布
- `Published`：发布

`Group` 至少包含 `notes`。以后需要新分组时，直接在 Notion 中增加新的选项并选中它；下一次发布后，网站会自动显示该分组。未选择分组时也按 `notes` 处理。

## 单一文章模板

在数据库中创建一个名为“新文章”的默认模板：

- `Status`：`Draft`
- `Group`：`notes`
- 页面正文：留空

不需要公式、额外状态或专用视图。作者使用模板新建页面后，只填写名称和正文；完成后将 `Status` 改为 `Published`。

## 自动生成的信息

- 文章 URL：根据 Notion 页面 ID 稳定生成，修改名称不会改变 URL
- 创建时间：读取页面的 `created_time`
- 更新时间：读取页面的 `last_edited_time`
- 摘要：从正文自动提取，不调用 AI，也不写回 Notion

除此之外暂不约定其他字段，也不需要创建。

## 创建步骤

1. 在 Notion 中创建数据库，保留默认标题字段并命名为 `名称`
2. 创建 `Status` select 字段，添加 `Draft` 和 `Published`
3. 创建 `Group` select 字段，添加 `notes`
4. 创建上面的“新文章”模板，并设为数据库默认模板
5. 将数据库共享给 Notion Integration
6. 将数据库 ID 填入 `NOTION_DATABASE_ID`

## 同步行为

- 同步程序只读取 `Status = Published` 的页面
- 没有名称或没有正文的 Published 页面会被拒绝，已有线上版本保持不变
- 每次同步生成完整快照并原子替换 `.content/notion/`
- 页面改回 `Draft` 后，不再进入下一份发布快照
