'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const lib = require('./pages-release-lib');

const DEFAULT_ATTEMPTS = 15;
const DEFAULT_DELAY_MS = 12000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

function normalizeBaseUrl(value, name) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  lib.assert(text, `${name} is required`);
  const parsed = new URL(text);
  lib.assert(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
    && !parsed.search && !parsed.hash, `${name} must be an HTTP(S) URL without credentials, query or fragment`);
  return parsed.toString().replace(/\/+$/, '');
}
function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  lib.assert(Number.isSafeInteger(parsed) && parsed > 0, `${name} must be a positive integer`);
  return parsed;
}
function isJsonContentType(value) { return /^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|$)/i.test(value || ''); }
function isXmlContentType(value) { return /^(?:application|text)\/(?:[a-z0-9.-]+\+)?xml(?:\s*;|$)/i.test(value || ''); }
function mimeMatches(value, expected) { return value.toLowerCase().split(';')[0].trim() === expected; }
function fileUrl(base, relative) { return new URL(relative.split('/').map(encodeURIComponent).join('/'), `${base}/`).toString(); }

async function fetchResource(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl || globalThis.fetch)(url, {
      redirect: 'follow', signal: controller.signal,
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache', 'user-agent': 'minliny-blog-deployment-smoke/2.0' },
    });
    const limit = options.maxBytes || 16 * 1024 * 1024;
    const chunks = []; let length = 0;
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.length;
          lib.assert(length <= limit, `${url} response exceeds expected size`);
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
    } else {
      const bytes = Buffer.from(await response.arrayBuffer()); length = bytes.length;
      lib.assert(length <= limit, `${url} response exceeds expected size`); chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks, length);
    return { url, finalUrl: response.url || url, status: response.status,
      contentType: response.headers.get('content-type') || '', bytes, text: bytes.toString('utf8'), sha256: lib.sha256(bytes) };
  } finally { clearTimeout(timeout); controller.abort(); }
}
function parseJson(resource, label) {
  lib.assert(isJsonContentType(resource.contentType), `${label} has unexpected Content-Type: ${resource.contentType || '(missing)'}`);
  try { return JSON.parse(resource.text); } catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
}
function compareExpected(resource, entry, release) {
  if (entry.path.endsWith('.html') && release.htmlComparison === 'email-off-markers') {
    lib.assert(lib.sha256(lib.normalizeCloudflareEmailMarkers(lib.decodeUtf8(resource.bytes, entry.path))) === entry.normalizedHtmlSha256,
      `${entry.path} differs from expected release (stale cache or altered HTML)`);
  } else lib.assert(resource.bytes.length === entry.bytes && resource.sha256 === entry.sha256,
    `${entry.path} differs from expected release (stale cache or altered bytes)`);
}
function assertResponseLocation(resource, allowedOrigins) {
  const requested = new URL(resource.url); const final = new URL(resource.finalUrl);
  lib.assert(final.protocol === 'https:' || requested.protocol === 'http:', 'HTTPS response redirected to an insecure URL');
  lib.assert(allowedOrigins.includes(final.origin), `${resource.url} redirected to an unexpected domain: ${resource.finalUrl}`);
  lib.assert(final.pathname === requested.pathname && final.search === requested.search, `${resource.url} redirected to a different path: ${resource.finalUrl}`);
}
function validateCanonical(resource, expected, label) {
  lib.assert(/^text\/html(?:\s*;|$)/i.test(resource.contentType), `${label} has unexpected HTML Content-Type`);
  lib.assert(resource.text.includes(`<link rel="canonical" href="${expected}">`)
    && resource.text.includes(`<meta property="og:url" content="${expected}">`), `${label} canonical/og:url mismatch`);
}
function validateXml(resource, siteUrl, kind) {
  lib.assert(isXmlContentType(resource.contentType), `${kind} has unexpected XML Content-Type`);
  const parsed = spawnSync('python3', ['-c', 'import json,sys,xml.etree.ElementTree as E; r=E.fromstring(sys.stdin.buffer.read()); print(json.dumps({"root":r.tag.split("}")[-1],"urls":[e.text for e in r.iter() if e.tag.split("}")[-1] in ("link","loc") and e.text]}))'],
    { input: resource.bytes, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  lib.assert(!parsed.error && parsed.status === 0, `${kind} is not well-formed XML`);
  const document = JSON.parse(parsed.stdout);
  lib.assert(document.root === (kind === 'feed.xml' ? 'rss' : 'urlset') && document.urls.length > 0,
    `${kind} has an unexpected XML root or no URLs`);
  lib.assert(document.urls[0] === `${siteUrl}/` && document.urls.every((url) => url.startsWith(`${siteUrl}/`)), `${kind} canonical URLs mismatch`);
}

async function checkDeployment(options) {
  lib.assert(options.releaseManifest || options.expectedManifest, 'A trusted release manifest is required; mirror comparison cannot validate a deployment');
  const release = lib.validateReleaseManifest(options.expectedManifest || lib.readJson(options.releaseManifest));
  const siteUrl = lib.canonicalUrl(options.siteUrl || options.canonicalUrl || release.siteUrl);
  lib.assert(release.siteUrl === siteUrl, 'Release canonical does not match requested SITE_URL');
  const baseUrl = normalizeBaseUrl(options.baseUrl || options.canonicalUrl, 'BLOG_SMOKE_BASE_URL');
  lib.assert(new URL(baseUrl).protocol === 'https:' || options.allowHttpForTests === true, 'Public smoke requires HTTPS');
  const allowedOrigins = [...new Set([new URL(baseUrl).origin, new URL(siteUrl).origin])];
  const inventory = new Map(release.files.map((entry) => [entry.path, entry]));
  const resources = new Map();
  async function checkedFile(name, relative = name) {
    const entry = inventory.get(name); lib.assert(entry, `Release has no expected file: ${name}`);
    const resource = await fetchResource(fileUrl(baseUrl, relative), { fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs, maxBytes: Math.max(entry.bytes + 256 * 1024, 1024) });
    lib.assert(resource.status === 200, `${resource.url} returned HTTP ${resource.status}`);
    assertResponseLocation(resource, allowedOrigins); compareExpected(resource, entry, release);
    resources.set(name, resource); return resource;
  }
  const home = await checkedFile('index.html', ''); validateCanonical(home, `${siteUrl}/`, 'home');
  const metadata = parseJson(await checkedFile('content-manifest.json'), 'content-manifest.json');
  lib.assert(metadata.schemaVersion === 1, 'Unsupported website manifest schema');
  lib.assert(metadata.source === 'notion' && metadata.siteUrl === siteUrl, 'Website source/canonical mismatch');
  if (release.siteSchema === 'current') {
    for (const [siteKey, releaseKey] of Object.entries({ sourceRepository: 'repo', sourceCommit: 'sourceCommit', releaseTag: 'releaseTag',
      fingerprintVersion: 'fingerprintVersion', contentFingerprint: 'contentFingerprint', generatorFingerprint: 'generatorFingerprint', publishFingerprint: 'publishFingerprint' })) {
      lib.assert(metadata[siteKey] === release[releaseKey], `Website release identity mismatch: ${siteKey}`);
    }
  }
  const posts = parseJson(await checkedFile('posts.json'), 'posts.json');
  const redirects = parseJson(await checkedFile('redirects.json'), 'redirects.json');
  lib.assert(Array.isArray(posts) && posts.length > 0 && redirects.routes, 'Website posts/redirects missing');
  lib.assert(metadata.articleCount === posts.length && posts.length === release.checks.articleRoutes.length, 'Website articleCount does not match release/posts inventory');
  for (const name of ['feed.xml', 'sitemap.xml']) validateXml(await checkedFile(name), siteUrl, name);
  for (const entry of release.files.filter((entry) => /\.(?:css|js)$/.test(entry.path))) {
    const resource = await checkedFile(entry.path);
    lib.assert(entry.bytes > 0, `Empty asset: ${entry.path}`);
    lib.assert(entry.path.endsWith('.css') ? /^text\/css(?:\s*;|$)/i.test(resource.contentType)
      : /^(?:application|text)\/(?:x-)?javascript(?:\s*;|$)/i.test(resource.contentType), `Asset MIME mismatch: ${entry.path}`);
  }
  const articlePath = release.checks.articleRoutes[0];
  for (const route of release.checks.articleRoutes) {
    validateCanonical(await checkedFile(`${route}index.html`, route), `${siteUrl}/${route}`, `article ${route}`);
  }
  validateCanonical(await checkedFile('about.html'), `${siteUrl}/about.html`, 'about page');
  for (const alias of release.checks.aliasRoutes) {
    const resource = await checkedFile(`${alias.path}index.html`, alias.path);
    validateCanonical(resource, `${siteUrl}/${alias.target}`, `alias ${alias.path}`);
    const refresh = resource.text.match(/<meta\s+http-equiv="refresh"\s+content="0;\s*url=([^"]+)"/i);
    lib.assert(refresh && new URL(refresh[1], resource.url).pathname === new URL(alias.target, `${baseUrl}/`).pathname, `Alias redirect target mismatch: ${alias.path}`);
  }
  const legacy = await checkedFile('post.html');
  lib.assert(/^text\/html(?:\s*;|$)/i.test(legacy.contentType), 'Legacy route MIME mismatch');
  for (const entry of release.checks.legacyRoutes) lib.assert(redirects.routes[entry.slug] === entry.target, `Legacy route target mismatch: ${entry.slug}`);
  if (release.checks.legacyRoutes.length) {
    const entry = release.checks.legacyRoutes[0];
    const resource = await fetchResource(`${fileUrl(baseUrl, 'post.html')}?slug=${encodeURIComponent(entry.slug)}`,
      { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, maxBytes: inventory.get('post.html').bytes + 256 * 1024 });
    lib.assert(resource.status === 200, 'Legacy query route is unavailable'); assertResponseLocation(resource, allowedOrigins);
    compareExpected(resource, inventory.get('post.html'), release);
  }
  for (const media of release.checks.media) {
    const resource = await checkedFile(media.path); lib.assert(mimeMatches(resource.contentType, media.contentType), `Media MIME mismatch: ${media.path}`);
  }
  const missingUrl = fileUrl(baseUrl, `__pages_smoke_missing_${release.releaseTag.replace(/[^a-z0-9_-]/gi, '_')}/missing`);
  const notFound = await fetchResource(missingUrl, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs,
    maxBytes: inventory.get('404.html').bytes + 256 * 1024 });
  lib.assert(notFound.status === 404, `Missing route must return 404, got ${notFound.status}`);
  assertResponseLocation(notFound, allowedOrigins); compareExpected(notFound, inventory.get('404.html'), release);
  lib.assert(/^text\/html(?:\s*;|$)/i.test(notFound.contentType), '404 page MIME mismatch');
  const githubEntryUrl = options.githubEntryUrl;
  if (githubEntryUrl) {
    const entryBase = normalizeBaseUrl(githubEntryUrl, 'GITHUB_ENTRY_URL');
    lib.assert(new URL(entryBase).protocol === 'https:', 'GitHub entry smoke requires HTTPS');
    for (const relative of ['', articlePath]) {
      const entry = inventory.get(relative ? `${relative}index.html` : 'index.html');
      const resource = await fetchResource(fileUrl(entryBase, relative), { fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs, maxBytes: entry.bytes + 256 * 1024 });
      lib.assert(resource.status === 200, 'GitHub entry is unavailable');
      const origins = baseUrl === siteUrl ? [new URL(siteUrl).origin] : [new URL(entryBase).origin, new URL(siteUrl).origin];
      assertResponseLocation(resource, origins); compareExpected(resource, entry, release);
    }
  }
  return { releaseTag: release.releaseTag, artifactSha256: release.archive.sha256, articlePath, articleStatus: true,
    checkedFiles: resources.size, hashes: Object.fromEntries([...resources].map(([name, resource]) => [name, resource.sha256])) };
}
async function retryDeployment(options) {
  const attempts = positiveInteger(options.attempts, DEFAULT_ATTEMPTS, 'SMOKE_ATTEMPTS');
  const delay = positiveInteger(options.delayMs, DEFAULT_DELAY_MS, 'SMOKE_DELAY_MS');
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { const result = await checkDeployment(options); console.log(`Deployment smoke passed: ${result.releaseTag} (${result.checkedFiles} files).`); return result; }
    catch (error) { lastError = error; console.error(`Deployment smoke ${attempt}/${attempts}: ${error.message}`); if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delay)); }
  }
  throw lastError;
}
async function main(argv = process.argv.slice(2)) {
  const args = lib.parseArgs(argv, ['base-url', 'site-url', 'release-manifest', 'github-entry-url']);
  await retryDeployment({ baseUrl: args['base-url'] || process.env.BLOG_SMOKE_BASE_URL || process.env.CANONICAL_URL,
    siteUrl: args['site-url'] || process.env.SITE_URL || process.env.CANONICAL_URL,
    releaseManifest: args['release-manifest'] || process.env.BLOG_RELEASE_MANIFEST,
    githubEntryUrl: args['github-entry-url'] || process.env.BLOG_GITHUB_ENTRY_URL,
    attempts: process.env.SMOKE_ATTEMPTS, delayMs: process.env.SMOKE_DELAY_MS,
    timeoutMs: positiveInteger(process.env.SMOKE_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 'SMOKE_REQUEST_TIMEOUT_MS') });
}
if (require.main === module) main().catch((error) => { console.error(`[smoke] ${error.message}`); process.exitCode = 1; });
module.exports = { checkDeployment, retryDeployment, fetchResource, isJsonContentType, isXmlContentType,
  normalizeCloudflareEmailMarkers: lib.normalizeCloudflareEmailMarkers, normalizeBaseUrl, main };
