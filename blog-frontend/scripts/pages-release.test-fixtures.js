'use strict';
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./pages-release-lib');
const { packageRelease } = require('./package-pages-release');
const SITE_URL = 'https://blog.example.test';
const REPO = 'example/example.github.io';
const COMMIT = 'a'.repeat(40);
function makeSite(root, { legacy = false, marker = 'new', media = true, secondArticle = false } = {}) {
  const dist = path.join(root, 'dist'); fs.mkdirSync(dist, { recursive: true });
  const identity = { fingerprintVersion: 1, contentFingerprint: `sha256:${'1'.repeat(64)}`,
    generatorFingerprint: `sha256:${'2'.repeat(64)}`, publishFingerprint: `sha256:${'3'.repeat(64)}`,
    sourceRepository: REPO, sourceCommit: COMMIT, releaseTag: 'site-123-1',
    buildEnvironment: { nodeVersion: '24.1.0', lockfileSha256: `sha256:${'4'.repeat(64)}` } };
  function write(name, value) { const filename = path.join(dist, name); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, value); }
  function html(canonical, body) { return `<!doctype html><html><head><link rel="canonical" href="${canonical}"><meta property="og:url" content="${canonical}"><link rel="stylesheet" href="/style.css"><script src="/theme.js"></script></head><body><main>${body}</main></body></html>`; }
  write('index.html', html(`${SITE_URL}/`, `Home ${marker} <!--email_off-->email<!--/email_off-->`));
  write('about.html', html(`${SITE_URL}/about.html`, 'About'));
  write('404.html', html(`${SITE_URL}/404.html`, 'Missing page'));
  write('post.html', '<!doctype html><main>Legacy route</main><script src="runtime/legacy.js"></script>');
  write('posts/first-post/index.html', html(`${SITE_URL}/posts/first-post/`, `Article ${marker}`));
  if (secondArticle) write('posts/second-post/index.html', html(`${SITE_URL}/posts/second-post/`, `Second article ${marker}`));
  write('posts/old-post/index.html', html(`${SITE_URL}/posts/first-post/`, 'Moved').replace('</head>', '<meta http-equiv="refresh" content="0; url=../first-post/"></head>'));
  write('content-manifest.json', JSON.stringify({ schemaVersion: 1, source: 'notion', siteUrl: SITE_URL,
    buildHash: `sha256:${'5'.repeat(64)}`, articleCount: secondArticle ? 2 : 1, ...(legacy ? {} : identity) }));
  write('posts.json', JSON.stringify([{ slug: 'first-post', path: 'posts/first-post/', aliases: ['old-post'] }, ...(secondArticle ? [{ slug: 'second-post', path: 'posts/second-post/', aliases: [] }] : [])]));
  write('redirects.json', JSON.stringify({ schemaVersion: 1, routes: { 'first-post': 'posts/first-post/', 'old-post': 'posts/first-post/', ...(secondArticle ? { 'second-post': 'posts/second-post/' } : {}) }, aliases: { 'old-post': 'first-post' } }));
  write('feed.xml', `<?xml version="1.0"?><rss><channel><link>${SITE_URL}/</link><item><link>${SITE_URL}/posts/first-post/</link></item></channel></rss>`);
  write('sitemap.xml', `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE_URL}/</loc></url><url><loc>${SITE_URL}/posts/first-post/</loc></url></urlset>`);
  write('robots.txt', `User-agent: *\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  write('style.css', `body { color: black; } /* ${marker} */`);
  write('theme.js', `window.theme = '${marker}';`);
  write('runtime/legacy.js', 'window.redirects = true;'); write('.nojekyll', '');
  if (media) { const bytes = Buffer.from('test png image'); write(`media/${lib.sha256(bytes)}.png`, bytes); }
  return { dist, identity, write };
}
function makeRelease(root, options = {}) {
  const fixture = makeSite(root, options); const release = path.join(root, 'release');
  const tag = options.legacy ? 'site-baseline-20260930-123' : fixture.identity.releaseTag;
  const manifest = packageRelease({ dist: fixture.dist, out: release, repo: REPO, commit: COMMIT, tag,
    legacyBaseline: options.legacy, sourceRun: options.legacy ? '123' : undefined });
  return { ...fixture, release, tag, manifest };
}
function fixtureFetch(dist, options = {}) {
  return async (url) => {
    const parsed = new URL(url); let name = decodeURIComponent(parsed.pathname).replace(/^\//, '');
    if (!name || name.endsWith('/')) name += 'index.html';
    let status = 200;
    if (!fs.existsSync(path.join(dist, name))) { status = 404; name = '404.html'; }
    const extension = path.extname(name);
    const contentType = { '.html': 'text/html', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript', '.xml': 'application/xml', '.png': 'image/png' }[extension] || 'text/plain';
    let body = fs.readFileSync(path.join(dist, name)); let finalUrl = url;
    const edited = options.edit?.({ url, name, body, status, contentType, finalUrl }) || {};
    body = edited.body ?? body; status = edited.status ?? status; finalUrl = edited.finalUrl ?? finalUrl;
    const response = new Response(body, { status, headers: { 'content-type': edited.contentType ?? contentType } });
    Object.defineProperty(response, 'url', { value: finalUrl }); return response;
  };
}
module.exports = { SITE_URL, REPO, COMMIT, makeSite, makeRelease, fixtureFetch };
