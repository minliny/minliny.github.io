'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  sha256, safeTree, computeContentFingerprint, computeGeneratorFingerprint,
  computePublicationIdentity, validatePublicationIdentity, PRODUCTION_SITE_URL,
} = require('./publish-fingerprint');

const ROOT_DIR = path.resolve(__dirname, '..');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-fingerprint-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function snapshot(directory, options = {}) {
  fs.mkdirSync(path.join(directory, 'posts'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'media'), { recursive: true });
  const articles = (options.slugs || ['article']).map((slug) => {
    const aliases = options.aliases || [];
    const updatedAt = '2026-09-30T00:00:00.000Z';
    const markdown = '---\nnotionId: "notion-' + slug + '"\ntitle: ' + JSON.stringify(options.title || 'Article title')
      + '\ndate: "2026-09-30"\nupdatedAt: "' + updatedAt + '"\nexcerpt: "An excerpt"\ntags: []\ncover: ""\naliases: '
      + JSON.stringify(aliases) + '\n---\n\n' + (options.body || 'Article body.') + '\n';
    fs.writeFileSync(path.join(directory, 'posts', slug + '.md'), markdown);
    return { id: 'notion-' + slug, notionId: 'notion-' + slug, slug, aliases, updatedAt, path: 'posts/' + slug + '.md', hash: sha256(markdown) };
  });
  const media = [];
  if (options.media) {
    const bytes = Buffer.from(options.media);
    const hash = sha256(bytes);
    const relative = 'media/' + hash + '.png';
    fs.writeFileSync(path.join(directory, relative), bytes);
    media.push({ path: relative, hash, bytes: bytes.length, contentType: 'image/png' });
  }
  const manifest = { schemaVersion: 1, source: 'notion', generatedAt: options.generatedAt || '2026-09-30T01:00:00.000Z', count: articles.length, mediaCount: media.length, articles, media };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

function saveManifest(directory, manifest) {
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
}

test('content identity ignores capture time and manifest ordering, while preserving the Published set', (t) => {
  const directory = temporary(t);
  const manifest = snapshot(directory, { slugs: ['first', 'second'] });
  const original = computeContentFingerprint(directory);
  manifest.generatedAt = '2027-01-01T00:00:00.000Z';
  manifest.articles.reverse();
  saveManifest(directory, manifest);
  assert.equal(computeContentFingerprint(directory), original);
  manifest.articles.pop();
  manifest.count--;
  fs.rmSync(path.join(directory, manifest.articles[0].slug === 'first' ? 'posts/second.md' : 'posts/first.md'));
  saveManifest(directory, manifest);
  assert.notEqual(computeContentFingerprint(directory), original);
});

test('title, body, alias and real media changes alter content identity', (t) => {
  const variants = [{}, { title: 'Changed title' }, { body: 'Changed body.' }, { aliases: ['old-route'] }, { media: 'image-one' }, { media: 'image-two' }];
  const hashes = variants.map((options) => {
    const directory = temporary(t);
    snapshot(directory, options);
    return computeContentFingerprint(directory);
  });
  assert.equal(new Set(hashes).size, variants.length);
});

test('snapshot validation refuses modified, unregistered, escaping and empty content', (t) => {
  const directory = temporary(t);
  let manifest = snapshot(directory);
  fs.appendFileSync(path.join(directory, 'posts/article.md'), 'tampered');
  assert.throws(() => computeContentFingerprint(directory), /hash mismatch/);
  manifest = snapshot(directory);
  fs.writeFileSync(path.join(directory, 'private.txt'), 'unregistered');
  assert.throws(() => computeContentFingerprint(directory), /Unregistered/);
  fs.rmSync(path.join(directory, 'private.txt'));
  manifest.articles[0].path = '../article.md';
  saveManifest(directory, manifest);
  assert.throws(() => computeContentFingerprint(directory), /Invalid snapshot path/);
  manifest = snapshot(directory);
  manifest.articles = []; manifest.count = 0;
  saveManifest(directory, manifest);
  assert.throws(() => computeContentFingerprint(directory), /published articles/);
});

test('snapshot integrity checks manifest metadata, media bytes and route uniqueness', (t) => {
  const directory = temporary(t);
  let manifest = snapshot(directory, { media: 'image' });
  manifest.media[0].bytes++;
  saveManifest(directory, manifest);
  assert.throws(() => computeContentFingerprint(directory), /size or MIME/);
  manifest = snapshot(directory);
  manifest.articles[0].notionId = manifest.articles[0].id = 'different-id';
  saveManifest(directory, manifest);
  assert.throws(() => computeContentFingerprint(directory), /frontmatter identity/);
  fs.rmSync(path.join(directory, 'media'), { recursive: true });
  manifest = snapshot(directory, { aliases: ['article'] });
  assert.throws(() => computeContentFingerprint(directory), /duplicate route/);
});

test('tree checks reject symlinks, hard links and resource limits', (t) => {
  const directory = temporary(t);
  fs.writeFileSync(path.join(directory, 'one'), 'four');
  assert.throws(() => safeTree(directory, { maxBytes: 3 }), /byte limit/);
  assert.throws(() => safeTree(directory, { maxFiles: 0 }), /file limit/);
  fs.symlinkSync(path.join(directory, 'one'), path.join(directory, 'link'));
  assert.throws(() => safeTree(directory), /Symbolic links/);
  fs.rmSync(path.join(directory, 'link'));
  fs.linkSync(path.join(directory, 'one'), path.join(directory, 'hard'));
  assert.throws(() => safeTree(directory), /hard links/);
});

test('generator identity covers tracked code, lockfile and runtime, excluding docs and fixtures', (t) => {
  const projectRoot = temporary(t);
  fs.mkdirSync(path.join(projectRoot, 'blog-frontend/scripts'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'blog-frontend/content/fixtures'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'blog-frontend/package-lock.json'), '{}');
  fs.writeFileSync(path.join(projectRoot, 'blog-frontend/scripts/build-site.js'), 'renderer');
  fs.writeFileSync(path.join(projectRoot, 'blog-frontend/scripts/pages-release-archive.py'), 'archive-runtime');
  fs.writeFileSync(path.join(projectRoot, 'blog-frontend/scripts/pages-release.test-fixtures.js'), 'test-helper');
  fs.writeFileSync(path.join(projectRoot, 'blog-frontend/scripts/archive.test.py'), 'python-test');
  fs.writeFileSync(path.join(projectRoot, 'blog-frontend/content/fixtures/example.md'), 'fixture');
  fs.writeFileSync(path.join(projectRoot, 'README.md'), 'docs');
  execFileSync('git', ['init', '-q'], { cwd: projectRoot });
  execFileSync('git', ['add', '.'], { cwd: projectRoot });
  const options = { projectRoot, nodeVersion: '24.1.0' };
  const original = computeGeneratorFingerprint(options).generatorFingerprint;
  fs.writeFileSync(path.join(projectRoot, 'README.md'), 'new docs');
  fs.writeFileSync(path.join(projectRoot, 'blog-frontend/scripts/pages-release.test-fixtures.js'), 'changed test-helper');
  fs.writeFileSync(path.join(projectRoot, 'blog-frontend/scripts/archive.test.py'), 'changed python-test');
  fs.writeFileSync(path.join(projectRoot, 'blog-frontend/content/fixtures/example.md'), 'new fixture');
  assert.equal(computeGeneratorFingerprint(options).generatorFingerprint, original);
  fs.appendFileSync(path.join(projectRoot, 'blog-frontend/scripts/build-site.js'), ' changed');
  assert.notEqual(computeGeneratorFingerprint(options).generatorFingerprint, original);
  fs.writeFileSync(path.join(projectRoot, 'blog-frontend/scripts/build-site.js'), 'renderer');
  fs.writeFileSync(path.join(projectRoot, 'blog-frontend/scripts/pages-release-archive.py'), 'changed archive-runtime');
  assert.notEqual(computeGeneratorFingerprint(options).generatorFingerprint, original);
  fs.writeFileSync(path.join(projectRoot, 'blog-frontend/scripts/pages-release-archive.py'), 'archive-runtime');
  assert.notEqual(computeGeneratorFingerprint({ ...options, nodeVersion: '24.2.0' }).generatorFingerprint, original);
  fs.writeFileSync(path.join(projectRoot, 'blog-frontend/package-lock.json'), '{"changed":true}');
  assert.notEqual(computeGeneratorFingerprint(options).generatorFingerprint, original);
});

function identityFor(directory) {
  return computePublicationIdentity({
    contentDir: directory, repository: 'minliny/minliny.github.io', siteUrl: PRODUCTION_SITE_URL,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim(),
    releaseTag: 'site-123-1',
  });
}

test('publication metadata rejects template repositories, malformed hashes, tags and unrelated commits', (t) => {
  const directory = temporary(t);
  snapshot(directory);
  const identity = identityFor(directory);
  assert.equal(validatePublicationIdentity(identity).publishFingerprint, identity.publishFingerprint);
  assert.throws(() => validatePublicationIdentity({ ...identity, sourceRepository: 'minliny/MoZhu_Blog' }), /sourceRepository/);
  assert.throws(() => validatePublicationIdentity({ ...identity, publishFingerprint: 'sha256:' + '0'.repeat(64) }), /does not match/);
  assert.throws(() => validatePublicationIdentity({ ...identity, releaseTag: 'site-../unsafe' }), /releaseTag/);
  assert.throws(() => computePublicationIdentity({ contentDir: directory, repository: identity.sourceRepository, commit: '0'.repeat(40), releaseTag: identity.releaseTag, siteUrl: identity.siteUrl }), /checked-out HEAD/);
  assert.equal(validatePublicationIdentity({ ...identity, source: 'fixtures' }).source, undefined);
});

test('production build binds verified inputs, requires identity and validates its output boundary', (t) => {
  const directory = temporary(t);
  const content = path.join(directory, 'content');
  snapshot(content);
  const identity = identityFor(content);
  const identityPath = path.join(directory, 'identity.json');
  fs.writeFileSync(identityPath, JSON.stringify({ ...identity, source: 'fixtures' }));
  const dist = path.join(directory, 'dist');
  const env = { ...process.env, SITE_URL: PRODUCTION_SITE_URL, BLOG_PRODUCTION: '1' };
  function build(extra = []) {
    return spawnSync(process.execPath, [path.join(ROOT_DIR, 'scripts/build-site.js'), '--content', content, '--output', dist, ...extra], { cwd: ROOT_DIR, env, encoding: 'utf8' });
  }
  const missing = build();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires --identity/);
  const valid = build(['--identity', identityPath]);
  assert.equal(valid.status, 0, valid.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'content-manifest.json')));
  assert.equal(manifest.source, 'notion');
  assert.equal(manifest.publishFingerprint, identity.publishFingerprint);
  function validate() {
    return spawnSync(process.execPath, [path.join(ROOT_DIR, 'scripts/validate-dist.js'), '--output', dist, '--production'], { cwd: ROOT_DIR, env, encoding: 'utf8' });
  }
  const verified = validate();
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  fs.writeFileSync(path.join(dist, '.env'), 'private');
  assert.equal(validate().status, 1);
  fs.rmSync(path.join(dist, '.env'));
  const modifiedManifest = { ...manifest, sourceRepository: 'minliny/MoZhu_Blog' };
  fs.writeFileSync(path.join(dist, 'content-manifest.json'), JSON.stringify(modifiedManifest));
  assert.equal(validate().status, 1);
  snapshot(content, { title: 'Edited after fingerprint' });
  const stale = build(['--identity', identityPath]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /content fingerprint is stale/);
});
