# Fixture content

这里的文章只用于模板仓库的本地预览、测试和 GitHub Pages 演示。

生产站点不读取本目录。生产工作流从 Notion 生成无状态快照到
`.content/notion/`，再由同一个静态构建器生成 `dist/`。

Fixture frontmatter 模拟的是构建层使用的内部快照格式，不是作者需要在 Notion 中填写的数据库字段。Notion 作者日常只填写名称和页面正文。分类也在 Git 和构建层处理，缺失时使用站点默认分类 `notes`。
