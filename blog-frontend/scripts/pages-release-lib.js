'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const MAX_BYTES = 900 * 1024 * 1024;
const MAX_FILES = 100000;
const SHA = /^[a-f0-9]{64}$/;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const REQUIRED = ['index.html', '.nojekyll', 'about.html', 'post.html', '404.html', 'robots.txt',
  'content-manifest.json', 'posts.json', 'redirects.json', 'feed.xml', 'sitemap.xml', 'style.css', 'theme.js'];

function assert(condition, message) { if (!condition) throw new Error(message); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function decodeUtf8(value, label = 'text') {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value); }
  catch (error) { throw new Error(`Invalid UTF-8 in ${label}`); }
}
function normalizeCloudflareEmailMarkers(value) { return String(value).replace(/<!--\/?email_off-->/g, ''); }
function parseArgs(argv, allowed, booleans = []) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index].replace(/^--/, '');
    assert(argv[index].startsWith('--') && allowed.includes(key), `Unknown option: ${argv[index]}`);
    assert(values[key] === undefined, `Duplicate option: --${key}`);
    if (booleans.includes(key)) values[key] = true;
    else {
      const value = argv[++index];
      assert(value && !value.startsWith('--'), `Missing value: --${key}`);
      values[key] = value;
    }
  }
  return values;
}
function requireArgs(args, keys) { for (const key of keys) assert(args[key], `--${key} is required`); }
function canonicalUrl(value) {
  const url = new URL(value);
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    'siteUrl must be HTTPS without credentials, query or fragment');
  return url.toString().replace(/\/+$/, '');
}
function safeRelativePath(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[\\\x00\r\n:]/.test(value) && !value.startsWith('/')
    && value.split('/').every((part) => part && part !== '.' && part !== '..'), `Unsafe file path: ${value}`);
  return value;
}
function rejectPrivatePath(value) {
  assert(!/(^|\/)(?:\.git|\.github|node_modules|scripts|\.content)(\/|$)/.test(value)
    && !/(^|\/)\.env(?:\.|$)/.test(value)
    && !/(^|\/)package(?:-lock)?\.json$/.test(value)
    && !/\.(?:md|pem|key|p12|pfx|jks|keystore)$/i.test(value), `Private/source file in website: ${value}`);
}
function regularFile(filename) {
  const mode = fs.lstatSync(filename);
  assert(mode.isFile() && !mode.isSymbolicLink(), `Expected a regular file: ${filename}`);
  return mode;
}
function readJson(filename) { regularFile(filename); return JSON.parse(fs.readFileSync(filename, 'utf8')); }
function walkFiles(directory) {
  assert(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(), 'Site root must be a real directory');
  const output = [];
  let totalBytes = 0;
  function walk(current, prefix = '') {
    for (const name of fs.readdirSync(current).sort()) {
      const relative = safeRelativePath(prefix ? `${prefix}/${name}` : name);
      rejectPrivatePath(relative);
      const absolute = path.join(current, name);
      const stat = fs.lstatSync(absolute);
      assert(!stat.isSymbolicLink(), `Site links are forbidden: ${relative}`);
      if (stat.isDirectory()) walk(absolute, relative);
      else {
        assert(stat.isFile() && stat.nlink === 1, `Site links or special files are forbidden: ${relative}`);
        totalBytes += stat.size;
        assert(totalBytes <= MAX_BYTES && output.length < MAX_FILES, 'Site exceeds release resource limits');
        output.push(relative);
      }
    }
  }
  walk(directory);
  return output.sort();
}
function validateIdentity(identity) {
  assert(identity.schemaVersion === 1, 'Unsupported release manifest schema');
  assert(typeof identity.repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.repo), 'Invalid release repository');
  assert(identity.sourceRepository === identity.repo, 'Release sourceRepository does not match repo');
  assert(typeof identity.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(identity.sourceCommit), 'sourceCommit must be a full lowercase Git SHA');
  assert(identity.siteUrl === canonicalUrl(identity.siteUrl), 'siteUrl must be canonical without trailing slash');
  assert(['current', 'legacy-baseline'].includes(identity.siteSchema), 'Invalid siteSchema');
  if (identity.siteSchema === 'legacy-baseline') {
    assert(typeof identity.sourceRunId === 'string' && /^[0-9]+$/.test(identity.sourceRunId), 'Legacy baseline requires sourceRunId');
    assert(new RegExp(`^site-baseline-[0-9]{8}-${identity.sourceRunId}$`).test(identity.releaseTag), 'Invalid designated baseline tag');
  } else {
    assert(/^site-[0-9]+-[0-9]+$/.test(identity.releaseTag), 'Invalid production release tag');
    assert(identity.fingerprintVersion === 1, 'Unsupported fingerprint version');
    for (const key of ['contentFingerprint', 'generatorFingerprint', 'publishFingerprint']) {
      assert(FINGERPRINT.test(identity[key]), `Invalid ${key}`);
    }
    assert(identity.buildEnvironment && typeof identity.buildEnvironment.nodeVersion === 'string'
      && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(identity.buildEnvironment.nodeVersion)
      && FINGERPRINT.test(identity.buildEnvironment.lockfileSha256), 'Invalid build environment');
  }
}
function validateReleaseManifest(manifest) {
  validateIdentity(manifest);
  assert(manifest.archive && manifest.archive.name === 'site.tar.gz' && SHA.test(manifest.archive.sha256)
    && Number.isSafeInteger(manifest.archive.bytes) && manifest.archive.bytes > 0 && manifest.archive.bytes <= MAX_BYTES,
  'Invalid archive identity');
  assert(['raw', 'email-off-markers'].includes(manifest.htmlComparison), 'Invalid HTML comparison mode');
  assert(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= MAX_FILES, 'Invalid file inventory');
  const seen = new Set();
  let totalBytes = 0;
  for (const entry of manifest.files) {
    safeRelativePath(entry.path); rejectPrivatePath(entry.path);
    assert(!seen.has(entry.path), `Duplicate file inventory entry: ${entry.path}`); seen.add(entry.path);
    assert(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && SHA.test(entry.sha256), `Invalid file identity: ${entry.path}`);
    if (entry.path.endsWith('.html') && manifest.htmlComparison === 'email-off-markers') {
      assert(SHA.test(entry.normalizedHtmlSha256), `Missing normalized HTML hash: ${entry.path}`);
    }
    totalBytes += entry.bytes;
  }
  assert(totalBytes <= MAX_BYTES, 'Expanded site exceeds release resource limits');
  for (const required of REQUIRED) assert(seen.has(required), `Missing required website file: ${required}`);
  assert(manifest.checks && Array.isArray(manifest.checks.articleRoutes) && manifest.checks.articleRoutes.length > 0
    && Array.isArray(manifest.checks.aliasRoutes) && Array.isArray(manifest.checks.legacyRoutes)
    && Array.isArray(manifest.checks.media), 'Missing smoke route inventory');
  for (const route of [...manifest.checks.articleRoutes, ...manifest.checks.aliasRoutes.map((item) => item.path)]) {
    assert(typeof route === 'string' && route.endsWith('/'), 'Invalid article route');
    safeRelativePath(route.slice(0, -1));
    assert(seen.has(`${route}index.html`), `Smoke route has no file: ${route}`);
  }
  for (const entry of manifest.checks.aliasRoutes) {
    assert(manifest.checks.articleRoutes.includes(entry.target), 'Alias target is not an article');
  }
  for (const entry of manifest.checks.legacyRoutes) {
    assert(typeof entry.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug)
      && manifest.checks.articleRoutes.includes(entry.target), 'Invalid legacy redirect inventory');
  }
  for (const entry of manifest.checks.media) {
    safeRelativePath(entry.path);
    assert(entry.path.startsWith('media/') && seen.has(entry.path) && typeof entry.contentType === 'string', 'Invalid media inventory');
  }
  return manifest;
}
function validateSite(directory, identity) {
  validateIdentity(identity);
  const names = walkFiles(directory);
  for (const required of REQUIRED) assert(names.includes(required), `Missing required website file: ${required}`);
  const site = readJson(path.join(directory, 'content-manifest.json'));
  assert(site.schemaVersion === 1, 'Unsupported website manifest schema');
  assert(site.source === 'notion' && site.siteUrl === identity.siteUrl, 'Site source/canonical does not match release');
  if (identity.siteSchema === 'current') {
    const mapping = { sourceRepository: 'repo', sourceCommit: 'sourceCommit', releaseTag: 'releaseTag',
      fingerprintVersion: 'fingerprintVersion', contentFingerprint: 'contentFingerprint',
      generatorFingerprint: 'generatorFingerprint', publishFingerprint: 'publishFingerprint' };
    for (const [siteKey, releaseKey] of Object.entries(mapping)) assert(site[siteKey] === identity[releaseKey], `Site identity mismatch: ${siteKey}`);
    assert(JSON.stringify(site.buildEnvironment) === JSON.stringify(identity.buildEnvironment), 'Build environment mismatch');
  }
  const posts = readJson(path.join(directory, 'posts.json'));
  const redirects = readJson(path.join(directory, 'redirects.json'));
  assert(Array.isArray(posts) && posts.length > 0 && redirects.routes && typeof redirects.routes === 'object', 'Invalid posts/redirects inventory');
  assert(site.articleCount === posts.length, 'Website articleCount does not match posts inventory');
  const articleRoutes = []; const aliasRoutes = []; const legacyRoutes = [];
  for (const post of posts) {
    assert(typeof post.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug), 'Invalid post slug');
    const route = `posts/${post.slug}/`;
    assert(post.path === route && redirects.routes[post.slug] === route && names.includes(`${route}index.html`), `Article route mismatch: ${post.slug}`);
    assert(!articleRoutes.includes(route), 'Duplicate article route'); articleRoutes.push(route);
    legacyRoutes.push({ slug: post.slug, target: route });
    for (const alias of post.aliases || []) {
      assert(typeof alias === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(alias), 'Invalid alias slug');
      assert(redirects.routes[alias] === route && names.includes(`posts/${alias}/index.html`), `Alias route mismatch: ${alias}`);
      aliasRoutes.push({ path: `posts/${alias}/`, target: route }); legacyRoutes.push({ slug: alias, target: route });
    }
  }
  for (const [relative, canonical] of [['index.html', `${identity.siteUrl}/`],
    ...articleRoutes.map((route) => [`${route}index.html`, `${identity.siteUrl}/${route}`]),
    ...aliasRoutes.map((item) => [`${item.path}index.html`, `${identity.siteUrl}/${item.target}`])]) {
    assert(decodeUtf8(fs.readFileSync(path.join(directory, relative)), relative).includes(`<link rel="canonical" href="${canonical}">`), `Incorrect canonical: ${relative}`);
  }
  const mediaTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml' };
  const media = names.filter((name) => name.startsWith('media/')).map((name) => {
    assert(/^media\/[a-f0-9]{64}\.[a-z0-9]+$/.test(name), `Invalid content-addressed media: ${name}`);
    const bytes = fs.readFileSync(path.join(directory, name));
    assert(sha256(bytes) === path.basename(name).split('.')[0], `Media digest mismatch: ${name}`);
    const contentType = mediaTypes[path.extname(name).slice(1)]; assert(contentType, `Unsupported published media type: ${name}`);
    return { path: name, contentType };
  });
  return { site, names, checks: { articleRoutes, aliasRoutes, legacyRoutes, media } };
}
function runArchive(args) {
  const result = spawnSync('python3', [path.join(__dirname, 'pages-release-archive.py'), ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  assert(result.status === 0, `Archive operation failed: ${(result.stderr || result.stdout).trim()}`);
}
module.exports = { MAX_BYTES, MAX_FILES, SHA, REQUIRED, assert, sha256, parseArgs, requireArgs,
  canonicalUrl, safeRelativePath, regularFile, readJson, walkFiles, validateIdentity, decodeUtf8,
  validateReleaseManifest, validateSite, runArchive, normalizeCloudflareEmailMarkers };
