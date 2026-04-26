const fs = require('fs');
const path = require('path');

const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
const ROOT_DIR = path.resolve(__dirname, '..');
const POSTS_JSON_PATH = path.join(ROOT_DIR, 'posts.json');
const OUTPUT_PATH = path.join(ROOT_DIR, 'feed.xml');
const MAX_ITEMS = 20;

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function resolveLink(slug) {
  const relativeLink = `post.html?slug=${encodeURIComponent(slug)}`;
  return SITE_URL ? `${SITE_URL}/${relativeLink}` : relativeLink;
}

function resolveHomeLink() {
  return SITE_URL ? `${SITE_URL}/` : './';
}

function buildItem(post) {
  const pubDate = new Date(post.date).toUTCString();
  return [
    '    <item>',
    `      <title>${escapeXml(post.title)}</title>`,
    `      <link>${escapeXml(resolveLink(post.slug))}</link>`,
    `      <guid>${escapeXml(resolveLink(post.slug))}</guid>`,
    `      <pubDate>${pubDate}</pubDate>`,
    `      <description>${escapeXml(post.excerpt || '')}</description>`,
    '    </item>',
  ].join('\n');
}

function main() {
  const posts = JSON.parse(fs.readFileSync(POSTS_JSON_PATH, 'utf8'));
  const latestPosts = [...posts]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_ITEMS);

  const lastBuildDate = latestPosts[0]
    ? new Date(latestPosts[0].date).toUTCString()
    : new Date().toUTCString();

  const rss = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    '    <title>Minliny</title>',
    `    <link>${escapeXml(resolveHomeLink())}</link>`,
    '    <description>做有意思的事情</description>',
    '    <language>zh-CN</language>',
    `    <lastBuildDate>${lastBuildDate}</lastBuildDate>`,
    ...latestPosts.map(buildItem),
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');

  fs.writeFileSync(OUTPUT_PATH, rss, 'utf8');
  console.log(`RSS generated: ${OUTPUT_PATH}`);
}

main();
