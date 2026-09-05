const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');
const hljs = require('highlight.js');
const sanitizeHtml = require('sanitize-html');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'site.config.json');
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_FIELDS = ['title', 'date', 'excerpt'];

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--content', '--output', '--site-url'].includes(flag)) {
      throw new Error(`Unknown build option: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}`);
    }
    options[flag.slice(2)] = value;
    index += 1;
  }
  return options;
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(ROOT_DIR, value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(value) {
  return escapeHtml(value).replace(/&#39;/g, '&apos;');
}

function normalizeDate(value, filePath) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`Invalid date in ${filePath}: ${value}`);
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`Invalid date in ${filePath}: ${value}`);
  }
  return text;
}

function normalizeUpdatedAt(value, date, filePath) {
  if (!value) return `${date}T00:00:00.000Z`;
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid updatedAt in ${filePath}: ${value}`);
  }
  return parsed.toISOString();
}

function normalizeStringArray(value, fieldName, filePath) {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) {
    throw new Error(`Frontmatter "${fieldName}" must be an array in ${filePath}`);
  }
  const result = value.map((item) => String(item).trim()).filter(Boolean);
  if (new Set(result).size !== result.length) {
    throw new Error(`Frontmatter "${fieldName}" contains duplicates in ${filePath}`);
  }
  return result;
}

function normalizeCover(value, title, filePath) {
  if (!value) return null;
  if (typeof value === 'string') {
    return { src: value.trim(), alt: title };
  }
  if (typeof value === 'object' && typeof value.src === 'string') {
    return {
      src: value.src.trim(),
      alt: String(value.alt || title).trim(),
    };
  }
  throw new Error(`Frontmatter "cover" must be a URL/path or { src, alt } in ${filePath}`);
}

function loadArticles(contentDir, config) {
  const postsDir = path.join(contentDir, 'posts');
  if (!fs.existsSync(postsDir) || !fs.statSync(postsDir).isDirectory()) {
    throw new Error(`Content posts directory does not exist: ${postsDir}`);
  }

  const files = fs.readdirSync(postsDir).filter((name) => name.endsWith('.md')).sort();
  if (files.length === 0) {
    throw new Error(`No Markdown articles found in ${postsDir}`);
  }

  const articles = files.map((name) => {
    const slug = name.slice(0, -3);
    const filePath = path.join(postsDir, name);
    if (!SLUG_PATTERN.test(slug)) {
      throw new Error(`Invalid article slug "${slug}" in ${filePath}`);
    }
    const parsed = matter(fs.readFileSync(filePath, 'utf8'));
    for (const field of REQUIRED_FIELDS) {
      if (parsed.data[field] === undefined || String(parsed.data[field]).trim() === '') {
        throw new Error(`Missing required frontmatter "${field}" in ${filePath}`);
      }
    }

    const title = String(parsed.data.title).trim();
    const excerpt = String(parsed.data.excerpt).trim();
    const group = String(parsed.data.group || config.content.defaultGroup || 'notes').trim() || 'notes';
    const date = normalizeDate(parsed.data.date, filePath);
    const aliases = normalizeStringArray(parsed.data.aliases, 'aliases', filePath);
    aliases.forEach((alias) => {
      if (!SLUG_PATTERN.test(alias)) {
        throw new Error(`Invalid alias "${alias}" in ${filePath}`);
      }
    });
    const notionId = String(parsed.data.notionId || parsed.data.id || `local:${slug}`).trim();
    if (!notionId) {
      throw new Error(`Missing stable notionId/id in ${filePath}`);
    }

    const body = parsed.content.trim();
    if (!body) {
      throw new Error(`Article body is empty in ${filePath}`);
    }

    return {
      notionId,
      slug,
      aliases,
      title,
      excerpt,
      group,
      tags: normalizeStringArray(parsed.data.tags, 'tags', filePath),
      date,
      updatedAt: normalizeUpdatedAt(parsed.data.updatedAt, date, filePath),
      cover: normalizeCover(parsed.data.cover, title, filePath),
      body,
      sourcePath: filePath,
      contentHash: `sha256:${sha256(body)}`,
    };
  });

  const ids = new Map();
  const routes = new Map();
  for (const article of articles) {
    if (ids.has(article.notionId)) {
      throw new Error(`Duplicate article id "${article.notionId}": ${ids.get(article.notionId)} and ${article.sourcePath}`);
    }
    ids.set(article.notionId, article.sourcePath);

    for (const route of [article.slug, ...article.aliases]) {
      if (routes.has(route)) {
        throw new Error(`Duplicate slug/alias "${route}": ${routes.get(route)} and ${article.sourcePath}`);
      }
      routes.set(route, article.sourcePath);
    }
  }

  return articles.sort((left, right) => {
    const byDate = right.date.localeCompare(left.date);
    return byDate || left.slug.localeCompare(right.slug);
  });
}

function defaultAboutArticle(config) {
  const title = `关于 ${config.site.title}`;
  const body = config.site.description || config.site.tagline || config.site.title;
  return {
    notionId: 'system:about',
    slug: config.content.aboutSlug,
    aliases: [],
    title,
    excerpt: config.site.description || body,
    group: config.content.defaultGroup || 'notes',
    tags: [],
    date: '1970-01-01',
    updatedAt: '1970-01-01T00:00:00.000Z',
    cover: null,
    body,
    sourcePath: CONFIG_PATH,
    contentHash: `sha256:${sha256(body)}`,
  };
}

function safeContentUrl(rawValue, context) {
  const value = String(rawValue || '').trim();
  if (!value) return null;
  if (value.startsWith('#')) return value;

  const mediaMatch = value.match(/^(?:\.\.\/)?media\/([a-f0-9]{64}\.[a-z0-9]+)$/i);
  if (mediaMatch) {
    const mediaName = mediaMatch[1];
    const sourcePath = path.join(context.contentDir, 'media', mediaName);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error(`Referenced media does not exist: ${sourcePath}`);
    }
    context.referencedMedia.add(mediaName);
    return `${context.rootPrefix}media/${mediaName}`;
  }

  if (/^https?:\/\//i.test(value)) return value;
  if (context.kind === 'link' && /^mailto:/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return null;
  if (value.includes('\\') || value.split('/').includes('..')) return null;
  return value;
}

function renderMarkdown(article, contentDir, rootPrefix, referencedMedia) {
  const renderer = new marked.Renderer();

  renderer.code = (code, infoString) => {
    const rawCode = typeof code === 'object' ? String(code.text || '') : String(code || '');
    const requestedLanguage = typeof infoString === 'object'
      ? String(infoString.lang || '')
      : String(infoString || '').trim().split(/\s+/)[0];
    const language = requestedLanguage && hljs.getLanguage(requestedLanguage)
      ? requestedLanguage
      : 'plaintext';
    const highlighted = hljs.highlight(rawCode, { language }).value;
    return `<div class="code-block"><button class="copy-btn" type="button" aria-label="复制代码">Copy</button><pre><code class="hljs language-${escapeHtml(language)}">${highlighted}</code></pre></div>`;
  };

  renderer.link = (href, title, text) => {
    const safeHref = safeContentUrl(href, {
      contentDir,
      rootPrefix,
      referencedMedia,
      kind: 'link',
    });
    if (!safeHref) return text;
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
    const externalAttributes = /^https?:\/\//i.test(safeHref)
      ? ' target="_blank" rel="noopener noreferrer"'
      : '';
    return `<a href="${escapeHtml(safeHref)}"${titleAttribute}${externalAttributes}>${text}</a>`;
  };

  renderer.image = (href, title, text) => {
    const safeSrc = safeContentUrl(href, {
      contentDir,
      rootPrefix,
      referencedMedia,
      kind: 'image',
    });
    if (!safeSrc) return '';
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(safeSrc)}" alt="${escapeHtml(text || '')}"${titleAttribute} loading="lazy" decoding="async">`;
  };

  const rendered = marked.parse(article.body, {
    renderer,
    gfm: true,
    breaks: false,
    pedantic: false,
  });

  return sanitizeHtml(rendered, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img', 'h1', 'h2', 'figure', 'figcaption', 'button', 'div', 'span',
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel', 'title'],
      img: ['src', 'alt', 'title', 'loading', 'decoding', 'width', 'height'],
      code: ['class'],
      div: ['class'],
      span: ['class'],
      button: ['class', 'type', 'aria-label'],
      h1: ['id'],
      h2: ['id'],
      h3: ['id'],
      h4: ['id'],
      h5: ['id'],
      h6: ['id'],
      th: ['scope'],
      td: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    enforceHtmlBoundary: true,
  });
}

function normalizeSiteUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  const parsed = new URL(text);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`SITE_URL must use http or https: ${value}`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

function absoluteUrl(siteUrl, route = '') {
  if (!siteUrl) return '';
  return `${siteUrl}/${String(route).replace(/^\/+/, '')}`;
}

function formatDisplayDate(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function buildHead({ config, title, description, canonical, rootPrefix, assetVersion, type = 'website', cover = null }) {
  const site = config.site;
  const canonicalMarkup = canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : '';
  const ogUrlMarkup = canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}">` : '';
  const ogImageMarkup = cover && /^https?:\/\//i.test(cover)
    ? `<meta property="og:image" content="${escapeHtml(cover)}">`
    : '';
  return `<!DOCTYPE html>
<html lang="${escapeHtml(site.language)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="color-scheme" content="light dark">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; upgrade-insecure-requests">
  <meta property="og:type" content="${escapeHtml(type)}">
  <meta property="og:site_name" content="${escapeHtml(site.title)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  ${ogUrlMarkup}
  ${ogImageMarkup}
  ${canonicalMarkup}
  <link rel="alternate" type="application/rss+xml" title="${escapeHtml(site.title)} RSS" href="${rootPrefix}feed.xml">
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@300;400;600;700&family=Noto+Sans+SC:wght@300;400&family=Fragment+Mono:ital@0;1&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="${rootPrefix}style.css?v=${assetVersion}">
  <script defer src="${rootPrefix}chrome/background.js?v=${assetVersion}"></script>
  <script defer src="${rootPrefix}chrome/nav.js?v=${assetVersion}"></script>
  <script defer src="${rootPrefix}chrome/init.js?v=${assetVersion}"></script>
  <script defer src="${rootPrefix}theme.js?v=${assetVersion}"></script>
  <script defer src="${rootPrefix}runtime/page.js?v=${assetVersion}"></script>
</head>`;
}

function homeHeader(config, rootPrefix) {
  return `<header class="site-header">
    <a class="logo" href="${rootPrefix}about.html" aria-label="查看关于 ${escapeHtml(config.site.title)}">
      <span class="logo-letter">${escapeHtml(config.site.title)}</span>
      <span class="logo-hint">notion-powered static blog</span>
    </a>
    <p class="bio">Publish from Notion to a static site.</p>
  </header>
  <hr class="divider">`;
}

function footer(config, rootPrefix) {
  return `<footer class="footer">
    <div class="footer-label">Connect</div>
    <div class="links-connect">
      <a href="${rootPrefix}feed.xml">RSS</a>
      <a href="mailto:${escapeHtml(config.site.email)}">邮箱</a>
      <a href="${rootPrefix}about.html">关于</a>
    </div>
  </footer>`;
}

function writeFile(outputDir, relativePath, content) {
  const targetPath = path.join(outputDir, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

function copyFile(outputDir, relativePath) {
  const sourcePath = path.join(ROOT_DIR, relativePath);
  const targetPath = path.join(outputDir, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function buildIndex({ articles, config, siteUrl, outputDir, assetVersion }) {
  const posts = articles.filter((article) => article.slug !== config.content.aboutSlug);
  const configuredGroups = config.content.groups || [];
  const configuredKeys = new Set(configuredGroups.map((group) => group.key));
  const discoveredGroups = [...new Set(posts.map((article) => article.group))]
    .filter((group) => group && !configuredKeys.has(group))
    .sort((left, right) => left.localeCompare(right, config.site.language));
  const groups = [
    ...configuredGroups,
    ...discoveredGroups.map((group) => ({ key: group, label: group })),
  ];
  const sections = groups.map((group) => {
    const items = posts.filter((article) => article.group === group.key);
    if (items.length === 0) return '';
    return `<section class="post-group">
      <h2 class="group-title">${escapeHtml(group.label)}</h2>
      <ul class="group-list">
        ${items.map((article) => `<li class="entry">
          <div class="entry-title"><a href="posts/${escapeHtml(article.slug)}/">${escapeHtml(article.title)}</a></div>
          <time class="entry-meta" datetime="${article.date}">${escapeHtml(formatDisplayDate(article.date))}</time>
          ${article.excerpt ? `<p class="entry-excerpt">${escapeHtml(article.excerpt)}</p>` : ''}
        </li>`).join('\n')}
      </ul>
    </section>`;
  }).filter(Boolean).join('\n');

  const content = sections || '<p class="empty-state">还没有发布文章。</p>';
  const head = buildHead({
    config,
    title: `${config.site.title} · ${config.site.tagline}`,
    description: config.site.description,
    canonical: absoluteUrl(siteUrl),
    rootPrefix: '',
    assetVersion,
  });
  writeFile(outputDir, 'index.html', `${head}
<body data-page="home">
  <a class="skip-link" href="#main-content">跳到正文</a>
  <div class="page">
    ${homeHeader(config, '')}
    <main id="main-content">
      <div class="entries grouped-entries" aria-label="文章列表">${content}</div>
    </main>
    ${footer(config, '')}
  </div>
</body>
</html>`);
}

function resolveCover(article, contentDir, rootPrefix, referencedMedia) {
  if (!article.cover) return null;
  const src = safeContentUrl(article.cover.src, {
    contentDir,
    rootPrefix,
    referencedMedia,
    kind: 'image',
  });
  return src ? { src, alt: article.cover.alt } : null;
}

function buildArticlePage({ article, config, contentDir, siteUrl, outputDir, assetVersion, referencedMedia }) {
  const rootPrefix = '../../';
  const cover = resolveCover(article, contentDir, rootPrefix, referencedMedia);
  const rendered = renderMarkdown(article, contentDir, rootPrefix, referencedMedia);
  const canonical = absoluteUrl(siteUrl, `posts/${article.slug}/`);
  const absoluteCover = cover && /^https?:\/\//i.test(cover.src)
    ? cover.src
    : cover && siteUrl
      ? absoluteUrl(siteUrl, cover.src.replace(/^\.\.\/\.\.\//, ''))
      : null;
  const head = buildHead({
    config,
    title: `${article.title} · ${config.site.title}`,
    description: article.excerpt,
    canonical,
    rootPrefix,
    assetVersion,
    type: 'article',
    cover: absoluteCover,
  });
  writeFile(outputDir, `posts/${article.slug}/index.html`, `${head}
<body data-page="post">
  <a class="skip-link" href="#main-content">跳到正文</a>
  <div class="page">
    <a class="post-back" href="${rootPrefix}index.html">← 返回</a>
    <main id="main-content">
      <article>
        <div class="post-shell">
          <h1 class="post-title">${escapeHtml(article.title)}</h1>
          <time class="post-meta" datetime="${article.date}">${escapeHtml(formatDisplayDate(article.date))}</time>
          ${cover ? `<img class="post-cover" src="${escapeHtml(cover.src)}" alt="${escapeHtml(cover.alt)}" loading="eager" decoding="async">` : ''}
          <div class="post-content">${rendered}</div>
        </div>
      </article>
    </main>
    ${footer(config, rootPrefix)}
  </div>
</body>
</html>`);
}

function buildAboutPage({ article, config, contentDir, siteUrl, outputDir, assetVersion, referencedMedia }) {
  const rendered = renderMarkdown(article, contentDir, '', referencedMedia);
  const cover = resolveCover(article, contentDir, '', referencedMedia);
  const head = buildHead({
    config,
    title: `${article.title} · ${config.site.title}`,
    description: article.excerpt,
    canonical: absoluteUrl(siteUrl, 'about.html'),
    rootPrefix: '',
    assetVersion,
    cover: cover?.src,
  });
  writeFile(outputDir, 'about.html', `${head}
<body data-page="about">
  <a class="skip-link" href="#main-content">跳到正文</a>
  <div class="page">
    <a class="post-back" href="index.html">← 返回</a>
    <main id="main-content">
      <article>
        <div class="post-shell about-content">
          <h1 class="post-title">${escapeHtml(article.title)}</h1>
          ${cover ? `<img class="post-cover" src="${escapeHtml(cover.src)}" alt="${escapeHtml(cover.alt)}" loading="eager" decoding="async">` : ''}
          <div class="post-content">${rendered}</div>
        </div>
      </article>
    </main>
    ${footer(config, '')}
  </div>
</body>
</html>`);
}

function buildAliasPage({ alias, article, config, siteUrl, outputDir, assetVersion }) {
  const rootPrefix = '../../';
  const target = `../${article.slug}/`;
  const canonical = absoluteUrl(siteUrl, `posts/${article.slug}/`);
  const head = buildHead({
    config,
    title: `${article.title} · ${config.site.title}`,
    description: `此文章已迁移到 ${article.title}`,
    canonical,
    rootPrefix,
    assetVersion,
  }).replace('</head>', `  <meta http-equiv="refresh" content="0; url=${escapeHtml(target)}">\n</head>`);
  writeFile(outputDir, `posts/${alias}/index.html`, `${head}
<body data-page="redirect">
  <div class="page"><main id="main-content"><div class="post-shell">
    <h1 class="post-title">文章地址已更新</h1>
    <div class="post-content"><p><a href="${escapeHtml(target)}">前往《${escapeHtml(article.title)}》</a></p></div>
  </div></main></div>
</body>
</html>`);
}

function buildLegacyPage({ config, outputDir, assetVersion }) {
  const head = buildHead({
    config,
    title: `文章跳转 · ${config.site.title}`,
    description: '正在跳转到文章的新地址。',
    canonical: '',
    rootPrefix: '',
    assetVersion,
  }).replace('</head>', '  <script defer src="runtime/legacy.js"></script>\n</head>');
  writeFile(outputDir, 'post.html', `${head}
<body data-page="legacy">
  <a class="skip-link" href="#main-content">跳到正文</a>
  <div class="page"><main id="main-content"><div class="post-shell">
    <h1 class="post-title" id="legacy-title">正在查找文章…</h1>
    <div class="post-content" id="legacy-message"><p>旧链接仍然有效，页面会自动跳转。</p><noscript><p>请启用 JavaScript，或从<a href="index.html">首页</a>打开文章。</p></noscript></div>
  </div></main></div>
</body>
</html>`);
}

function buildNotFoundPage({ config, siteUrl, outputDir, assetVersion }) {
  const head = buildHead({
    config,
    title: `页面不存在 · ${config.site.title}`,
    description: '页面不存在，或者链接已经失效。',
    canonical: absoluteUrl(siteUrl, '404.html'),
    rootPrefix: '',
    assetVersion,
  });
  writeFile(outputDir, '404.html', `${head}
<body data-page="not-found">
  <a class="skip-link" href="#main-content">跳到正文</a>
  <div class="page"><main id="main-content"><div class="post-shell">
    <h1 class="post-title">页面不存在</h1>
    <div class="post-content"><p>这篇文章不存在，或者链接已经失效。</p><p><a href="index.html">返回首页</a></p></div>
  </div></main>${footer(config, '')}</div>
</body>
</html>`);
}

function buildFeeds({ articles, config, siteUrl, outputDir }) {
  const posts = articles.filter((article) => article.slug !== config.content.aboutSlug);
  const homeUrl = absoluteUrl(siteUrl) || './';
  const latest = posts.slice(0, 20);
  const rss = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    `    <title>${escapeXml(config.site.title)}</title>`,
    `    <link>${escapeXml(homeUrl)}</link>`,
    `    <description>${escapeXml(config.site.description)}</description>`,
    `    <language>${escapeXml(config.site.language)}</language>`,
    `    <lastBuildDate>${new Date(`${latest[0]?.date || '1970-01-01'}T00:00:00.000Z`).toUTCString()}</lastBuildDate>`,
    ...latest.flatMap((article) => {
      const link = absoluteUrl(siteUrl, `posts/${article.slug}/`) || `posts/${article.slug}/`;
      return [
        '    <item>',
        `      <title>${escapeXml(article.title)}</title>`,
        `      <link>${escapeXml(link)}</link>`,
        `      <guid>${escapeXml(link)}</guid>`,
        `      <pubDate>${new Date(`${article.date}T00:00:00.000Z`).toUTCString()}</pubDate>`,
        `      <description>${escapeXml(article.excerpt)}</description>`,
        '    </item>',
      ];
    }),
    '  </channel>',
    '</rss>',
  ].join('\n');
  writeFile(outputDir, 'feed.xml', rss);

  const sitemapRoutes = ['', 'about.html', ...posts.map((article) => `posts/${article.slug}/`)];
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...sitemapRoutes.map((route) => `  <url><loc>${escapeXml(absoluteUrl(siteUrl, route) || route || './')}</loc></url>`),
    '</urlset>',
  ].join('\n');
  writeFile(outputDir, 'sitemap.xml', sitemap);

  const robots = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${absoluteUrl(siteUrl, 'sitemap.xml') || 'sitemap.xml'}`,
  ].join('\n');
  writeFile(outputDir, 'robots.txt', robots);
}

function copyMedia(contentDir, outputDir) {
  const mediaDir = path.join(contentDir, 'media');
  if (!fs.existsSync(mediaDir)) return [];
  const names = fs.readdirSync(mediaDir).sort();
  const copied = [];
  for (const name of names) {
    const source = path.join(mediaDir, name);
    if (!fs.statSync(source).isFile()) {
      throw new Error(`Nested media directories are not supported: ${source}`);
    }
    if (!/^[a-f0-9]{64}\.[a-z0-9]+$/i.test(name)) {
      throw new Error(`Media filename is not content-addressed: ${source}`);
    }
    const bytes = fs.readFileSync(source);
    if (sha256(bytes) !== name.split('.')[0].toLowerCase()) {
      throw new Error(`Media checksum does not match filename: ${source}`);
    }
    const target = path.join(outputDir, 'media', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    copied.push(name);
  }
  return copied;
}

function replaceOutputAtomically(stagingDir, outputDir) {
  const backupDir = `${outputDir}.previous-${process.pid}`;
  let movedExisting = false;
  try {
    if (fs.existsSync(outputDir)) {
      fs.renameSync(outputDir, backupDir);
      movedExisting = true;
    }
    fs.renameSync(stagingDir, outputDir);
    if (movedExisting) fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(outputDir) && movedExisting && fs.existsSync(backupDir)) {
      fs.renameSync(backupDir, outputDir);
    }
    throw error;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readJson(CONFIG_PATH);
  const contentDir = resolveFromRoot(args.content || process.env.CONTENT_DIR || 'content/fixtures');
  const outputDir = resolveFromRoot(args.output || process.env.DIST_DIR || 'dist');
  if (outputDir === ROOT_DIR || outputDir === path.parse(outputDir).root) {
    throw new Error(`Refusing unsafe output directory: ${outputDir}`);
  }
  const siteUrl = normalizeSiteUrl(args['site-url'] || process.env.SITE_URL || config.site.publicUrl);
  const articles = loadArticles(contentDir, config);
  const about = articles.find((article) => article.slug === config.content.aboutSlug)
    || defaultAboutArticle(config);
  const assetFiles = [
    'style.css', 'theme.js', 'chrome/background.js', 'chrome/nav.js', 'chrome/init.js',
    'runtime/page.js', 'runtime/legacy.js',
  ];
  const assetVersion = sha256(assetFiles.map((file) => fs.readFileSync(path.join(ROOT_DIR, file))).join('\n')).slice(0, 12);
  const stagingDir = fs.mkdtempSync(path.join(path.dirname(outputDir), `.${path.basename(outputDir)}-build-`));
  const referencedMedia = new Set();

  try {
    assetFiles.forEach((file) => copyFile(stagingDir, file));
    const copiedMedia = copyMedia(contentDir, stagingDir);
    buildIndex({ articles, config, siteUrl, outputDir: stagingDir, assetVersion });
    buildAboutPage({ article: about, config, contentDir, siteUrl, outputDir: stagingDir, assetVersion, referencedMedia });

    const posts = articles.filter((article) => article.slug !== config.content.aboutSlug);
    posts.forEach((article) => {
      buildArticlePage({ article, config, contentDir, siteUrl, outputDir: stagingDir, assetVersion, referencedMedia });
      article.aliases.forEach((alias) => buildAliasPage({ alias, article, config, siteUrl, outputDir: stagingDir, assetVersion }));
    });

    buildLegacyPage({ config, outputDir: stagingDir, assetVersion });
    buildNotFoundPage({ config, siteUrl, outputDir: stagingDir, assetVersion });
    buildFeeds({ articles, config, siteUrl, outputDir: stagingDir });

    const routes = {};
    const aliases = {};
    posts.forEach((article) => {
      routes[article.slug] = `posts/${article.slug}/`;
      article.aliases.forEach((alias) => {
        routes[alias] = `posts/${article.slug}/`;
        aliases[alias] = article.slug;
      });
    });
    writeFile(stagingDir, 'redirects.json', JSON.stringify({ schemaVersion: 1, routes, aliases }, null, 2));

    const postsJson = posts.map((article) => ({
      schemaVersion: 1,
      id: article.notionId,
      notionId: article.notionId,
      slug: article.slug,
      aliases: article.aliases,
      title: article.title,
      date: article.date,
      updatedAt: article.updatedAt,
      excerpt: article.excerpt,
      group: article.group,
      tags: article.tags,
      cover: article.cover,
      path: `posts/${article.slug}/`,
      contentHash: article.contentHash,
    }));
    writeFile(stagingDir, 'posts.json', JSON.stringify(postsJson, null, 2));

    const sourceManifestPath = path.join(contentDir, 'manifest.json');
    const sourceManifest = fs.existsSync(sourceManifestPath) ? readJson(sourceManifestPath) : null;
    const deterministicBuildTime = sourceManifest?.generatedAt
      || process.env.BUILD_TIMESTAMP
      || articles.map((article) => article.updatedAt).sort().at(-1)
      || '1970-01-01T00:00:00.000Z';
    const buildHash = `sha256:${sha256(JSON.stringify({
      config,
      assetVersion,
      articles: articles.map(({ notionId, slug, aliases: articleAliases, updatedAt, contentHash }) => ({
        notionId, slug, aliases: articleAliases, updatedAt, contentHash,
      })),
      sourceManifestHash: sourceManifest ? sha256(JSON.stringify(sourceManifest)) : null,
    }))}`;
    const manifest = {
      schemaVersion: 1,
      source: sourceManifest ? 'notion' : 'fixtures',
      sourceManifestHash: sourceManifest ? `sha256:${sha256(JSON.stringify(sourceManifest))}` : null,
      builtAt: deterministicBuildTime,
      siteUrl,
      buildHash,
      articleCount: posts.length,
      mediaCount: copiedMedia.length,
      referencedMedia: [...referencedMedia].sort(),
      articles: postsJson.map((article) => ({
        id: article.id,
        slug: article.slug,
        aliases: article.aliases,
        updatedAt: article.updatedAt,
        route: article.path,
        contentHash: article.contentHash,
      })),
    };
    writeFile(stagingDir, 'content-manifest.json', JSON.stringify(manifest, null, 2));
    writeFile(stagingDir, '.nojekyll', '');

    replaceOutputAtomically(stagingDir, outputDir);
    console.log(`Static site built: ${outputDir}`);
    console.log(`Content source: ${contentDir}`);
    console.log(`Articles: ${posts.length}; media: ${copiedMedia.length}; build: ${buildHash}`);
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

try {
  main();
} catch (error) {
  console.error(`[build] ${error.message}`);
  process.exitCode = 1;
}
