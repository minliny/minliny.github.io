const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT_DIR = path.resolve(__dirname, '..');
const BUILD_SCRIPT = path.join(ROOT_DIR, 'scripts', 'build-site.js');
const VALIDATE_SCRIPT = path.join(ROOT_DIR, 'scripts', 'validate-dist.js');

test('build sanitizes article HTML and keeps the publishing boundary clean', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mozhu-build-test-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const contentDir = path.join(temporaryRoot, 'content');
  const outputDir = path.join(temporaryRoot, 'dist');
  fs.cpSync(path.join(ROOT_DIR, 'content', 'fixtures'), contentDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'posts', 'unsafe-html.md'), `---
notionId: fixture-unsafe-html
title: Unsafe HTML test
date: 2026-04-27
updatedAt: 2026-04-27T00:00:00.000Z
excerpt: Security regression fixture
group: tech
tags: []
cover: ""
aliases: []
---

<script>alert('xss')</script>

[unsafe](javascript:alert(1))

![unsafe](data:image/svg+xml,<svg onload=alert(1)>)
`, 'utf8');

  const build = spawnSync(process.execPath, [BUILD_SCRIPT, '--content', contentDir, '--output', outputDir], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const article = fs.readFileSync(path.join(outputDir, 'posts', 'unsafe-html', 'index.html'), 'utf8');
  const content = article.match(/<div class="post-content">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.doesNotMatch(content, /<script/i);
  assert.doesNotMatch(content, /javascript:/i);
  assert.doesNotMatch(content, /onload=/i);
  assert.doesNotMatch(article, /node_modules|package-lock\.json|\.env/);
});

test('SITE_URL is consistent across discovery metadata and output validation', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mozhu-site-url-test-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const contentDir = path.join(ROOT_DIR, 'content', 'fixtures');
  const outputDir = path.join(temporaryRoot, 'dist');
  const siteUrl = 'https://canonical.example.test/blog';

  const build = spawnSync(process.execPath, [
    BUILD_SCRIPT,
    '--content', contentDir,
    '--output', outputDir,
    '--site-url', siteUrl,
  ], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const home = fs.readFileSync(path.join(outputDir, 'index.html'), 'utf8');
  const article = fs.readFileSync(path.join(outputDir, 'posts', 'hello-world', 'index.html'), 'utf8');
  const feed = fs.readFileSync(path.join(outputDir, 'feed.xml'), 'utf8');
  const sitemap = fs.readFileSync(path.join(outputDir, 'sitemap.xml'), 'utf8');
  const robots = fs.readFileSync(path.join(outputDir, 'robots.txt'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'content-manifest.json'), 'utf8'));

  assert.match(home, /<link rel="canonical" href="https:\/\/canonical\.example\.test\/blog\/">/);
  assert.match(home, /<meta property="og:url" content="https:\/\/canonical\.example\.test\/blog\/">/);
  assert.match(article, /<link rel="canonical" href="https:\/\/canonical\.example\.test\/blog\/posts\/hello-world\/">/);
  assert.match(article, /<meta property="og:url" content="https:\/\/canonical\.example\.test\/blog\/posts\/hello-world\/">/);
  assert.match(feed, /<link>https:\/\/canonical\.example\.test\/blog\/<\/link>/);
  assert.match(feed, /<guid>https:\/\/canonical\.example\.test\/blog\/posts\/hello-world\/<\/guid>/);
  assert.match(sitemap, /<loc>https:\/\/canonical\.example\.test\/blog\/posts\/hello-world\/<\/loc>/);
  assert.match(robots, /Sitemap: https:\/\/canonical\.example\.test\/blog\/sitemap\.xml/);
  assert.equal(manifest.siteUrl, siteUrl);

  const validation = spawnSync(process.execPath, [VALIDATE_SCRIPT, '--output', outputDir], {
    cwd: ROOT_DIR,
    env: { ...process.env, SITE_URL: siteUrl },
    encoding: 'utf8',
  });
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);

  const mismatch = spawnSync(process.execPath, [VALIDATE_SCRIPT, '--output', outputDir], {
    cwd: ROOT_DIR,
    env: { ...process.env, SITE_URL: 'https://wrong.example.test' },
    encoding: 'utf8',
  });
  assert.equal(mismatch.status, 1);
  assert.match(`${mismatch.stdout}\n${mismatch.stderr}`, /does not (?:use|match) SITE_URL/);
});

test('build preserves legacy groups and reads a missing group from site.config', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mozhu-groups-test-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const contentDir = path.join(temporaryRoot, 'content');
  const outputDir = path.join(temporaryRoot, 'dist');
  fs.cpSync(path.join(ROOT_DIR, 'content', 'fixtures'), contentDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'posts', 'research-note.md'), `---
notionId: fixture-research-note
title: Research note
date: 2026-04-28
updatedAt: 2026-04-28T00:00:00.000Z
excerpt: Dynamic group regression fixture
group: 研究札记
tags: []
cover: ""
aliases: []
---

Research body.
`, 'utf8');
  fs.writeFileSync(path.join(contentDir, 'posts', 'default-note.md'), `---
notionId: fixture-default-note
title: Default note
date: 2026-04-27
updatedAt: 2026-04-27T00:00:00.000Z
excerpt: Default group regression fixture
tags: []
cover: ""
aliases: []
---

Default body.
`, 'utf8');

  const build = spawnSync(process.execPath, [BUILD_SCRIPT, '--content', contentDir, '--output', outputDir], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const home = fs.readFileSync(path.join(outputDir, 'index.html'), 'utf8');
  const posts = JSON.parse(fs.readFileSync(path.join(outputDir, 'posts.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'site.config.json'), 'utf8'));
  assert.match(home, /<h2 class="group-title">研究札记<\/h2>/);
  assert.match(home, /href="posts\/research-note\/"/);
  assert.match(home, /href="posts\/default-note\/"/);
  assert.equal(posts.find((post) => post.slug === 'research-note').group, '研究札记');
  assert.equal(posts.find((post) => post.slug === 'default-note').group, config.content.defaultGroup);
});

test('build does not require a specially configured Notion about article', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mozhu-about-test-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const contentDir = path.join(temporaryRoot, 'content');
  const outputDir = path.join(temporaryRoot, 'dist');
  fs.cpSync(path.join(ROOT_DIR, 'content', 'fixtures'), contentDir, { recursive: true });
  fs.rmSync(path.join(contentDir, 'posts', 'about.md'));

  const build = spawnSync(process.execPath, [BUILD_SCRIPT, '--content', contentDir, '--output', outputDir], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const about = fs.readFileSync(path.join(outputDir, 'about.html'), 'utf8');
  assert.match(about, /<h1 class="post-title">关于 Minliny<\/h1>/);
  assert.match(about, /做有意思的事情/);
});
