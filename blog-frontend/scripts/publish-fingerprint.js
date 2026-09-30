'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const matter = require('gray-matter');

const ROOT_DIR = path.resolve(__dirname, '..');
const PRODUCTION_REPOSITORY = 'minliny/minliny.github.io';
const PRODUCTION_SITE_URL = 'https://blog.minliny.com';
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RAW_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SITE_BYTES = 900 * 1024 * 1024;
const MAX_FILES = 100000;
const IMAGE_TYPES = { avif: 'image/avif', gif: 'image/gif', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  ensure(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'Invalid fingerprint JSON value');
  return JSON.stringify(value);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fingerprint(value) {
  return 'sha256:' + sha256(canonicalJson(value));
}

function safeTree(directory, limits = {}) {
  const maxBytes = limits.maxBytes ?? MAX_SITE_BYTES;
  const maxFiles = limits.maxFiles ?? MAX_FILES;
  const rootStat = fs.lstatSync(directory);
  ensure(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'Not a regular directory: ' + directory);
  const files = [];
  let bytes = 0;
  function walk(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      ensure(!/[\x00-\x1f\\]/.test(relative), 'Unsafe path: ' + relative);
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute);
      ensure(!stat.isSymbolicLink(), 'Symbolic links are forbidden: ' + relative);
      if (stat.isDirectory()) walk(absolute, relative);
      else {
        ensure(stat.isFile() && stat.nlink === 1, 'Special files and hard links are forbidden: ' + relative);
        bytes += stat.size;
        ensure(bytes <= maxBytes, 'Tree exceeds ' + maxBytes + ' byte limit');
        ensure(files.length < maxFiles, 'Tree exceeds ' + maxFiles + ' file limit');
        files.push({ path: relative, bytes: stat.size, absolute });
      }
    }
  }
  walk(directory, '');
  return { files, bytes };
}

function computeContentFingerprint(contentDir) {
  const tree = safeTree(contentDir);
  const files = new Map(tree.files.map((file) => [file.path, file]));
  ensure(files.has('manifest.json'), 'Notion snapshot manifest.json is required');
  const manifest = JSON.parse(fs.readFileSync(files.get('manifest.json').absolute, 'utf8'));
  ensure(manifest.schemaVersion === 1 && manifest.source === 'notion', 'Snapshot must have schemaVersion 1 and source notion');
  ensure(typeof manifest.generatedAt === 'string' && !Number.isNaN(Date.parse(manifest.generatedAt)), 'Invalid snapshot capture time');
  ensure(Array.isArray(manifest.articles) && manifest.articles.length > 0, 'Snapshot must contain published articles');
  ensure(Array.isArray(manifest.media), 'Snapshot media must be an array');
  ensure(manifest.count === manifest.articles.length && manifest.mediaCount === manifest.media.length, 'Snapshot counts do not match records');
  const seen = new Set(['manifest.json']);
  const ids = new Set();
  const routes = new Set();
  function verifyRecord(record, pattern) {
    ensure(record && typeof record === 'object' && pattern.test(record.path), 'Invalid snapshot path: ' + record?.path);
    ensure(!seen.has(record.path), 'Duplicate snapshot path: ' + record.path);
    ensure(RAW_HASH_PATTERN.test(record.hash), 'Invalid snapshot hash: ' + record.path);
    const file = files.get(record.path);
    ensure(file, 'Missing snapshot file: ' + record.path);
    const actual = sha256(fs.readFileSync(file.absolute));
    ensure(actual === record.hash, 'Snapshot hash mismatch: ' + record.path);
    seen.add(record.path);
    return { path: record.path, sha256: actual };
  }
  const articles = manifest.articles.map((record) => {
    const verified = verifyRecord(record, /^posts\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/);
    ensure(record.path === 'posts/' + record.slug + '.md', 'Article slug/path mismatch: ' + record.path);
    ensure(typeof record.notionId === 'string' && record.notionId.length > 0 && record.id === record.notionId, 'Invalid article identity: ' + record.path);
    ensure(!ids.has(record.notionId), 'Duplicate article identity: ' + record.path);
    ids.add(record.notionId);
    ensure(Array.isArray(record.aliases) && new Set(record.aliases).size === record.aliases.length, 'Invalid aliases: ' + record.path);
    for (const route of [record.slug, ...record.aliases]) {
      ensure(typeof route === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route) && !routes.has(route), 'Invalid or duplicate route: ' + route);
      routes.add(route);
    }
    const parsed = matter(fs.readFileSync(files.get(record.path).absolute, 'utf8'));
    ensure(parsed.data.notionId === record.notionId, 'Article frontmatter identity mismatch: ' + record.path);
    ensure(canonicalJson(parsed.data.aliases || []) === canonicalJson(record.aliases), 'Article aliases mismatch: ' + record.path);
    ensure(parsed.data.updatedAt === record.updatedAt && !Number.isNaN(Date.parse(record.updatedAt)), 'Article update time mismatch: ' + record.path);
    for (const field of ['title', 'date', 'excerpt']) ensure(parsed.data[field] !== undefined && String(parsed.data[field]).trim(), 'Missing article ' + field + ': ' + record.path);
    ensure(parsed.content.trim(), 'Empty article body: ' + record.path);
    return verified;
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const media = manifest.media.map((record) => {
    const verified = verifyRecord(record, /^media\/[a-f0-9]{64}\.(?:avif|gif|jpg|png|webp)$/);
    const extension = record.path.split('.').at(-1);
    ensure(record.path.split('/').at(-1).split('.')[0] === record.hash, 'Media filename/hash mismatch: ' + record.path);
    ensure(record.bytes === files.get(record.path).bytes && IMAGE_TYPES[extension] === record.contentType, 'Media size or MIME mismatch: ' + record.path);
    return verified;
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  ensure(seen.size === files.size, 'Unregistered snapshot files: ' + [...files.keys()].filter((file) => !seen.has(file)).join(', '));
  return fingerprint({ version: 1, source: 'notion', articles, media });
}

function isProductionInput(relative) {
  if (/^\.github\/workflows\/(?:deploy-blog|rollback-pages)\.yml$/.test(relative)) return true;
  if (!relative.startsWith('blog-frontend/')) return false;
  const local = relative.slice('blog-frontend/'.length);
  return /^(?:package(?:-lock)?\.json|site\.config\.json|style\.css|theme\.js)$/.test(local)
    || /^(?:chrome|runtime)\/.+\.(?:js|css)$/.test(local)
    || (/^scripts\/.+\.(?:js|py)$/.test(local) && !/\.test(?:[.-]|$)/.test(local))
    || /^content\/[^/]+\.schema\.json$/.test(local);
}

function computeGeneratorFingerprint(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(ROOT_DIR, '..'));
  const nodeVersion = options.nodeVersion || process.versions.node;
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: projectRoot, encoding: 'utf8' })
    .split('\0').filter((file) => file && isProductionInput(file)).sort();
  ensure(tracked.includes('blog-frontend/package-lock.json') && tracked.includes('blog-frontend/scripts/build-site.js'), 'Production generator inputs are missing from Git');
  const inputs = tracked.map((relative) => {
    const absolute = path.join(projectRoot, relative);
    const stat = fs.lstatSync(absolute);
    ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Invalid generator file: ' + relative);
    return { path: relative, sha256: sha256(fs.readFileSync(absolute)) };
  });
  return {
    generatorFingerprint: fingerprint({ version: 1, nodeVersion, inputs }),
    buildEnvironment: {
      nodeVersion,
      lockfileSha256: 'sha256:' + sha256(fs.readFileSync(path.join(projectRoot, 'blog-frontend', 'package-lock.json'))),
    },
  };
}

function computePublishFingerprint(contentFingerprint, generatorFingerprint, siteUrl) {
  return fingerprint({ version: 1, contentFingerprint, generatorFingerprint, siteUrl });
}

function validatePublicationIdentity(identity, options = {}) {
  ensure(identity && typeof identity === 'object' && !Array.isArray(identity), 'Publication identity must be an object');
  ensure(identity.fingerprintVersion === 1, 'Publication fingerprintVersion must be 1');
  for (const field of ['contentFingerprint', 'generatorFingerprint', 'publishFingerprint']) ensure(typeof identity[field] === 'string' && HASH_PATTERN.test(identity[field]), 'Invalid ' + field);
  ensure(identity.sourceRepository === PRODUCTION_REPOSITORY, 'Publication sourceRepository is not the production repository');
  ensure(typeof identity.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(identity.sourceCommit), 'Publication sourceCommit must be a full lowercase commit');
  ensure(typeof identity.releaseTag === 'string' && /^site-[0-9]+-[0-9]+$/.test(identity.releaseTag), 'Publication releaseTag must have site-run-attempt form');
  ensure(identity.siteUrl === PRODUCTION_SITE_URL && identity.siteUrl === (options.siteUrl || PRODUCTION_SITE_URL), 'Publication siteUrl does not match production SITE_URL');
  ensure(identity.buildEnvironment && /^\d+\.\d+\.\d+$/.test(identity.buildEnvironment.nodeVersion) && HASH_PATTERN.test(identity.buildEnvironment.lockfileSha256), 'Invalid publication buildEnvironment');
  ensure(identity.publishFingerprint === computePublishFingerprint(identity.contentFingerprint, identity.generatorFingerprint, identity.siteUrl), 'Publication fingerprint does not match its inputs');
  return {
    fingerprintVersion: identity.fingerprintVersion,
    contentFingerprint: identity.contentFingerprint,
    generatorFingerprint: identity.generatorFingerprint,
    publishFingerprint: identity.publishFingerprint,
    sourceRepository: identity.sourceRepository,
    sourceCommit: identity.sourceCommit,
    releaseTag: identity.releaseTag,
    siteUrl: identity.siteUrl,
    buildEnvironment: {
      nodeVersion: identity.buildEnvironment.nodeVersion,
      lockfileSha256: identity.buildEnvironment.lockfileSha256,
    },
  };
}

function computePublicationIdentity(options) {
  const generator = computeGeneratorFingerprint(options);
  const actualCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: options.projectRoot || path.join(ROOT_DIR, '..'), encoding: 'utf8' }).trim();
  ensure(options.commit === actualCommit, 'Publication sourceCommit is not the checked-out HEAD');
  const identity = {
    fingerprintVersion: 1,
    contentFingerprint: computeContentFingerprint(path.resolve(options.contentDir)),
    ...generator,
    sourceRepository: options.repository,
    sourceCommit: options.commit,
    releaseTag: options.releaseTag,
    siteUrl: options.siteUrl,
  };
  identity.publishFingerprint = computePublishFingerprint(identity.contentFingerprint, identity.generatorFingerprint, identity.siteUrl);
  return validatePublicationIdentity(identity, { siteUrl: options.siteUrl });
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    ensure(['--content', '--site-url', '--repository', '--commit', '--release-tag', '--output'].includes(argv[index]), 'Unknown fingerprint option: ' + argv[index]);
    ensure(argv[index + 1] && !argv[index + 1].startsWith('--'), 'Missing value: ' + argv[index]);
    args[argv[index].slice(2)] = argv[index + 1];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = path.join(ROOT_DIR, '..');
  const identity = computePublicationIdentity({
    contentDir: path.resolve(ROOT_DIR, args.content || process.env.CONTENT_DIR || '.content/notion'),
    siteUrl: args['site-url'] || process.env.SITE_URL || PRODUCTION_SITE_URL,
    repository: args.repository || process.env.GITHUB_REPOSITORY,
    commit: args.commit || process.env.SOURCE_COMMIT || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim(),
    releaseTag: args['release-tag'] || process.env.RELEASE_TAG,
    projectRoot,
  });
  const output = JSON.stringify(identity, null, 2) + '\n';
  if (args.output) {
    const destination = path.resolve(ROOT_DIR, args.output);
    let existing;
    try { existing = fs.lstatSync(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    ensure(!existing || (fs.lstatSync(destination).isFile() && !fs.lstatSync(destination).isSymbolicLink() && fs.lstatSync(destination).nlink === 1), 'Identity output must be a regular private file');
    fs.writeFileSync(destination, output, { mode: 0o600 });
    fs.chmodSync(destination, 0o600);
    console.log('Publication identity: ' + destination);
  } else process.stdout.write(output);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error('[fingerprint] ' + error.message); process.exitCode = 1; }
}

module.exports = {
  PRODUCTION_REPOSITORY, PRODUCTION_SITE_URL, MAX_SITE_BYTES,
  canonicalJson, sha256, safeTree, computeContentFingerprint, computeGeneratorFingerprint,
  computePublishFingerprint, computePublicationIdentity, validatePublicationIdentity, isProductionInput,
};
