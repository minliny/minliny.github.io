---
notionId: fixture-hello-world
title: Welcome to MoZhu_Blog
date: 2026-04-25
updatedAt: 2026-04-25T00:00:00.000Z
excerpt: A sample post used to exercise the static blog build pipeline.
group: notes
tags:
  - sample
  - mozhu-blog
cover: ""
aliases: []
---

Welcome to this sample blog repository.

This post exists so the project can be cloned, built, and previewed without requiring an immediate Notion sync.

## What this post demonstrates

- Generated fixture metadata consumed by the build pipeline
- Build-time Markdown rendering
- A clean `dist/` publishing boundary
- Participation in `posts.json`, RSS, and the sitemap

## Next step

Use the fixtures for a template preview, or sync your own Notion database before building the production site.

```bash
npm run build:fixtures
npm run serve
```
