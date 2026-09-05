const assert = require('node:assert/strict');
const test = require('node:test');

const {
  checkDeployment,
  isJsonContentType,
  isXmlContentType,
  normalizeCloudflareEmailMarkers,
} = require('./smoke-deployment');

function responseFor(body, contentType, url) {
  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function fixtureFetch(canonicalUrl, overrides = {}) {
  const manifest = JSON.stringify({ source: 'notion', siteUrl: canonicalUrl });
  const posts = JSON.stringify([{ slug: 'first-post' }]);
  const fixtures = {
    '/': [`<link rel="canonical" href="${canonicalUrl}/"><meta property="og:url" content="${canonicalUrl}/">`, 'text/html'],
    '/content-manifest.json': [manifest, 'application/json; charset=utf-8'],
    '/posts.json': [posts, 'application/json'],
    '/feed.xml': [`<?xml version="1.0"?><rss><link>${canonicalUrl}/</link></rss>`, 'application/rss+xml'],
    '/sitemap.xml': [`<?xml version="1.0"?><urlset><loc>${canonicalUrl}/</loc></urlset>`, 'application/xml'],
    '/style.css': ['body { color: black; }', 'text/css'],
    '/theme.js': ['document.documentElement.dataset.theme = "day";', 'text/javascript'],
    '/posts/first-post/': ['<!doctype html><main>First post</main>', 'text/html'],
    ...overrides,
  };
  return async (url) => {
    const parsed = new URL(url);
    const fixture = fixtures[parsed.pathname];
    if (!fixture) return new Response('not found', { status: 404 });
    return responseFor(fixture[0], fixture[1], url);
  };
}

test('deployment smoke validates and compares both domains', async () => {
  const canonicalUrl = 'https://blog.example.test';
  const result = await checkDeployment({
    canonicalUrl,
    mirrorUrl: 'https://mirror.example.test',
    fetchImpl: fixtureFetch(canonicalUrl),
    timeoutMs: 1_000,
  });
  assert.equal(result.articlePath, 'posts/first-post/');
  assert.equal(result.articleStatus, true);
  assert.match(result.hashes.manifest, /^[a-f0-9]{64}$/);
});

test('deployment smoke rejects stale or malformed manifest metadata', async () => {
  const canonicalUrl = 'https://blog.example.test';
  const fetchImpl = fixtureFetch(canonicalUrl, {
    '/content-manifest.json': [JSON.stringify({ source: 'fixtures', siteUrl: canonicalUrl }), 'text/plain'],
  });
  await assert.rejects(
    checkDeployment({ canonicalUrl, mirrorUrl: 'https://mirror.example.test', fetchImpl, timeoutMs: 1_000 }),
    /manifest has unexpected Content-Type/,
  );
});

test('content type checks accept structured JSON and XML media types', () => {
  assert.equal(isJsonContentType('application/problem+json; charset=utf-8'), true);
  assert.equal(isJsonContentType('text/plain'), false);
  assert.equal(isXmlContentType('application/rss+xml; charset=utf-8'), true);
  assert.equal(isXmlContentType('application/json'), false);
});

test('HTML comparison ignores only Cloudflare email_off control markers', () => {
  const marked = '<!--email_off--><a href="mailto:writer@example.test">Email</a><!--/email_off-->';
  const unmarked = '<a href="mailto:writer@example.test">Email</a>';
  const transformed = '<a href="/cdn-cgi/l/email-protection">Email</a><script src="/cdn-cgi/email-decode.js"></script>';

  assert.equal(normalizeCloudflareEmailMarkers(marked), unmarked);
  assert.equal(normalizeCloudflareEmailMarkers(unmarked), unmarked);
  assert.notEqual(normalizeCloudflareEmailMarkers(transformed), unmarked);
});
