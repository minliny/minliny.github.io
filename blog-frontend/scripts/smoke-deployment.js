const crypto = require('node:crypto');

const DEFAULT_ATTEMPTS = 15;
const DEFAULT_DELAY_MS = 12_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(value, name) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) throw new Error(`${name} is required`);
  const parsed = new URL(text);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${name} must use http or https`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isJsonContentType(value) {
  return /^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|$)/i.test(value || '');
}

function isXmlContentType(value) {
  return /^(?:application|text)\/(?:[a-z0-9.-]+\+)?xml(?:\s*;|$)/i.test(value || '');
}

async function fetchResource(baseUrl, relativePath, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Global fetch is unavailable');
  const timeoutMs = options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = new URL(relativePath, `${baseUrl}/`).toString();

  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'user-agent': 'minliny-blog-deployment-smoke/1.0',
      },
    });
    assert(response.ok, `${url} returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      url,
      finalUrl: response.url || url,
      contentType: response.headers.get('content-type') || '',
      bytes,
      text: bytes.toString('utf8'),
      sha256: sha256(bytes),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson(resource, label) {
  try {
    return JSON.parse(resource.text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function validateHome(resource, canonicalUrl, label) {
  assert(resource.text.includes(`<link rel="canonical" href="${canonicalUrl}/">`), `${label} canonical link is stale`);
  assert(resource.text.includes(`<meta property="og:url" content="${canonicalUrl}/">`), `${label} og:url is stale`);
}

function validateXml(resource, canonicalUrl, label) {
  assert(isXmlContentType(resource.contentType), `${label} has unexpected Content-Type: ${resource.contentType || '(missing)'}`);
  assert(/^\s*<\?xml\b/i.test(resource.text), `${label} is missing an XML declaration`);
  assert(resource.text.includes(`${canonicalUrl}/`), `${label} does not contain the canonical domain`);
}

function compareResource(left, right, label) {
  assert(left.sha256 === right.sha256, `${label} differs between canonical and mirror domains`);
}

async function loadDomain(baseUrl, canonicalUrl, options) {
  const resources = {};
  const entries = await Promise.all([
    ['home', fetchResource(baseUrl, '/', options)],
    ['manifest', fetchResource(baseUrl, 'content-manifest.json', options)],
    ['posts', fetchResource(baseUrl, 'posts.json', options)],
    ['feed', fetchResource(baseUrl, 'feed.xml', options)],
    ['sitemap', fetchResource(baseUrl, 'sitemap.xml', options)],
    ['style', fetchResource(baseUrl, 'style.css', options)],
    ['javascript', fetchResource(baseUrl, 'theme.js', options)],
  ].map(async ([name, request]) => [name, await request]));
  entries.forEach(([name, resource]) => {
    resources[name] = resource;
    assert(new URL(resource.finalUrl).origin === new URL(baseUrl).origin, `${resource.url} redirected to another domain: ${resource.finalUrl}`);
  });

  validateHome(resources.home, canonicalUrl, `${baseUrl} home`);
  assert(isJsonContentType(resources.manifest.contentType), `${baseUrl} manifest has unexpected Content-Type: ${resources.manifest.contentType || '(missing)'}`);
  const manifest = parseJson(resources.manifest, `${baseUrl} manifest`);
  assert(manifest.source === 'notion', `${baseUrl} manifest source must be notion`);
  assert(manifest.siteUrl === canonicalUrl, `${baseUrl} manifest siteUrl must be ${canonicalUrl}`);

  const posts = parseJson(resources.posts, `${baseUrl} posts.json`);
  assert(Array.isArray(posts) && posts.length > 0, `${baseUrl} posts.json must contain at least one article`);
  assert(typeof posts[0].slug === 'string' && posts[0].slug.length > 0, `${baseUrl} first article is missing a slug`);
  validateXml(resources.feed, canonicalUrl, `${baseUrl} feed.xml`);
  validateXml(resources.sitemap, canonicalUrl, `${baseUrl} sitemap.xml`);
  assert(/^text\/css(?:\s*;|$)/i.test(resources.style.contentType), `${baseUrl} style.css has unexpected Content-Type: ${resources.style.contentType || '(missing)'}`);
  assert(/^(?:application|text)\/(?:x-)?javascript(?:\s*;|$)/i.test(resources.javascript.contentType), `${baseUrl} theme.js has unexpected Content-Type: ${resources.javascript.contentType || '(missing)'}`);
  assert(resources.style.bytes.length > 0, `${baseUrl} style.css is empty`);
  assert(resources.javascript.bytes.length > 0, `${baseUrl} theme.js is empty`);

  return { baseUrl, manifest, posts, resources };
}

async function checkDeployment(options) {
  const canonicalUrl = normalizeBaseUrl(options.canonicalUrl, 'CANONICAL_URL');
  const mirrorUrl = normalizeBaseUrl(options.mirrorUrl, 'MIRROR_URL');
  const requestOptions = {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS,
  };
  const [canonical, mirror] = await Promise.all([
    loadDomain(canonicalUrl, canonicalUrl, requestOptions),
    loadDomain(mirrorUrl, canonicalUrl, requestOptions),
  ]);

  for (const name of ['manifest', 'posts', 'feed', 'sitemap', 'style', 'javascript']) {
    compareResource(canonical.resources[name], mirror.resources[name], name);
  }
  assert(canonical.posts[0].slug === mirror.posts[0].slug, 'First article slug differs between domains');

  const articlePath = `posts/${encodeURIComponent(canonical.posts[0].slug)}/`;
  const [canonicalArticle, mirrorArticle] = await Promise.all([
    fetchResource(canonicalUrl, articlePath, requestOptions),
    fetchResource(mirrorUrl, articlePath, requestOptions),
  ]);
  assert(/^text\/html(?:\s*;|$)/i.test(canonicalArticle.contentType), `Canonical article has unexpected Content-Type: ${canonicalArticle.contentType || '(missing)'}`);
  assert(/^text\/html(?:\s*;|$)/i.test(mirrorArticle.contentType), `Mirror article has unexpected Content-Type: ${mirrorArticle.contentType || '(missing)'}`);
  compareResource(canonicalArticle, mirrorArticle, 'representative article');

  return {
    articlePath,
    hashes: Object.fromEntries(
      ['manifest', 'posts', 'feed', 'sitemap', 'style', 'javascript']
        .map((name) => [name, canonical.resources[name].sha256]),
    ),
    articleStatus: canonicalArticle.bytes.length > 0 && mirrorArticle.bytes.length > 0,
  };
}

async function retryDeployment(options) {
  const attempts = positiveInteger(options.attempts, DEFAULT_ATTEMPTS, 'SMOKE_ATTEMPTS');
  const delayMs = positiveInteger(options.delayMs, DEFAULT_DELAY_MS, 'SMOKE_DELAY_MS');
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await checkDeployment(options);
      console.log(`Deployment smoke passed on attempt ${attempt}/${attempts}.`);
      console.log(`Checked article: ${result.articlePath}`);
      Object.entries(result.hashes).forEach(([name, digest]) => console.log(`${name} sha256:${digest}`));
      return result;
    } catch (error) {
      lastError = error;
      console.error(`Deployment smoke attempt ${attempt}/${attempts} failed: ${error.message}`);
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw lastError;
}

async function main() {
  await retryDeployment({
    canonicalUrl: process.env.CANONICAL_URL,
    mirrorUrl: process.env.MIRROR_URL,
    attempts: process.env.SMOKE_ATTEMPTS,
    delayMs: process.env.SMOKE_DELAY_MS,
    timeoutMs: positiveInteger(process.env.SMOKE_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 'SMOKE_REQUEST_TIMEOUT_MS'),
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Deployment smoke failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  checkDeployment,
  isJsonContentType,
  isXmlContentType,
  normalizeBaseUrl,
  positiveInteger,
};
