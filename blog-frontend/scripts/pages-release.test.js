'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { packageRelease } = require('./package-pages-release');
const { verifyRelease, extractPagesArtifact } = require('./verify-pages-release');
const lib = require('./pages-release-lib');
const fixture = require('./pages-release.test-fixtures');
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-release-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function verifyOptions(data, out, extra = {}) { return { release: data.release, out, repo: fixture.REPO, siteUrl: fixture.SITE_URL,
  tag: data.tag, expectedSha: data.manifest.archive.sha256, ...extra }; }
function rewriteManifest(data) {
  const text = `${JSON.stringify(data.manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(data.release, 'release-manifest.json'), text);
  fs.writeFileSync(path.join(data.release, 'SHA256SUMS'), `${data.manifest.archive.sha256}  site.tar.gz\n${lib.sha256(text)}  release-manifest.json\n`);
}
test('release roundtrip preserves original bytes, hidden files and identity', (t) => {
  const root = temporary(t); const data = fixture.makeRelease(root); const out = path.join(root, 'restored');
  const verified = verifyRelease(verifyOptions(data, out)); assert.equal(verified.sourceCommit, fixture.COMMIT);
  for (const name of lib.walkFiles(data.dist)) assert.deepEqual(fs.readFileSync(path.join(out, name)), fs.readFileSync(path.join(data.dist, name)));
  assert.ok(fs.existsSync(path.join(out, '.nojekyll'))); assert.throws(() => verifyRelease(verifyOptions(data, out)), /already exists/);
});
test('deterministic packaging and independent archive digest prevent replacement', (t) => {
  const root = temporary(t); const data = fixture.makeRelease(root);
  const repeated = packageRelease({ dist: data.dist, out: path.join(root, 'second'), repo: fixture.REPO, commit: fixture.COMMIT, tag: data.tag });
  assert.equal(repeated.archive.sha256, data.manifest.archive.sha256);
  assert.throws(() => verifyRelease(verifyOptions(data, path.join(root, 'bad'), { expectedSha: '0'.repeat(64) })), /SHA-256 mismatch/);
  assert.ok(!fs.existsSync(path.join(root, 'bad')));
});
test('legacy baseline requires explicit opt-in and restores without inserting schema fields', (t) => {
  const root = temporary(t); const data = fixture.makeRelease(root, { legacy: true });
  assert.throws(() => verifyRelease(verifyOptions(data, path.join(root, 'blocked'))), /explicit opt-in/);
  verifyRelease(verifyOptions(data, path.join(root, 'legacy'), { allowLegacyBaseline: true }));
  assert.deepEqual(fs.readFileSync(path.join(data.dist, 'content-manifest.json')), fs.readFileSync(path.join(root, 'legacy/content-manifest.json')));
  assert.equal(lib.readJson(path.join(root, 'legacy/content-manifest.json')).releaseTag, undefined);
});
test('package refuses links, private files and mismatched production identities', (t) => {
  const root = temporary(t); const data = fixture.makeSite(root);
  const options = { dist: data.dist, out: path.join(root, 'release'), repo: fixture.REPO, commit: fixture.COMMIT, tag: data.identity.releaseTag };
  assert.throws(() => packageRelease({ ...options, commit: 'b'.repeat(40) }), /Site identity mismatch/);
  data.write('.env', 'secret'); assert.throws(() => packageRelease(options), /Private\/source file/); fs.unlinkSync(path.join(data.dist, '.env'));
  fs.symlinkSync('/etc/passwd', path.join(data.dist, 'link')); assert.throws(() => packageRelease(options), /links are forbidden/);
});
test('file inventory digests are enforced independently of archive digest', (t) => {
  const root = temporary(t); const data = fixture.makeRelease(root);
  data.manifest.files.find((entry) => entry.path === 'style.css').sha256 = '0'.repeat(64); rewriteManifest(data);
  assert.throws(() => verifyRelease(verifyOptions(data, path.join(root, 'bad'))), /digest mismatch/);
  assert.ok(!fs.existsSync(path.join(root, 'bad')));
});
test('Pages transport accepts dot-root tar and rejects traversal, duplicates and links', (t) => {
  const root = temporary(t); const data = fixture.makeSite(root); const archive = path.join(root, 'artifact.tar');
  const packed = spawnSync('python3', ['-c', 'import tarfile,sys; t=tarfile.open(sys.argv[2],"w"); t.add(sys.argv[1],arcname="."); t.close()', data.dist, archive]);
  assert.equal(packed.status, 0); const out = path.join(root, 'transport'); extractPagesArtifact(archive, out);
  assert.deepEqual(fs.readFileSync(path.join(out, '.nojekyll')), Buffer.alloc(0));
  for (const kind of ['traversal', 'duplicate', 'symlink', 'hardlink']) {
    const malicious = path.join(root, `${kind}.tar`);
    const result = spawnSync('python3', ['-c', 'import io,tarfile,sys; t=tarfile.open(sys.argv[1],"w"); k=sys.argv[2]; h=tarfile.TarInfo("../escape" if k=="traversal" else "entry"); h.size=1; t.addfile(h,io.BytesIO(b"x")); h=tarfile.TarInfo("entry" if k=="duplicate" else "link"); h.size=1; h.type=tarfile.SYMTYPE if k=="symlink" else tarfile.LNKTYPE if k=="hardlink" else tarfile.REGTYPE; h.linkname="/etc/passwd"; t.addfile(h,io.BytesIO(b"y")); t.close()', malicious, kind]);
    assert.equal(result.status, 0); assert.throws(() => extractPagesArtifact(malicious, path.join(root, `out-${kind}`)), /Archive operation failed/);
    assert.ok(!fs.existsSync(path.join(root, 'escape'))); assert.ok(!fs.existsSync(path.join(root, `out-${kind}`)));
  }
});
test('explicit release inventory rejects injected traversal paths', (t) => {
  const root = temporary(t); const data = fixture.makeRelease(root);
  data.manifest.files[0].path = '../escaped'; rewriteManifest(data);
  assert.throws(() => verifyRelease(verifyOptions(data, path.join(root, 'bad'))), /Unsafe file path/);
});
test('release restore refuses wrong repository/tag and dishonest normalized HTML metadata', (t) => {
  const root = temporary(t); const data = fixture.makeRelease(root);
  assert.throws(() => verifyRelease(verifyOptions(data, path.join(root, 'wrong-repo'), { repo: 'attacker/site' })), /Release identity/);
  assert.throws(() => verifyRelease(verifyOptions(data, path.join(root, 'wrong-tag'), { tag: 'site-999-1' })), /Release identity/);
  data.manifest.files.find((entry) => entry.path === 'index.html').normalizedHtmlSha256 = '0'.repeat(64);
  rewriteManifest(data);
  assert.throws(() => verifyRelease(verifyOptions(data, path.join(root, 'bad-html'))), /HTML comparison identity mismatch/);
});
test('package rejects unsupported website schema and incorrect article count, including legacy baselines', (t) => {
  const root = temporary(t); const data = fixture.makeSite(root, { legacy: true });
  const options = { dist: data.dist, out: path.join(root, 'release'), repo: fixture.REPO, commit: fixture.COMMIT,
    tag: 'site-baseline-20260930-123', legacyBaseline: true, sourceRun: '123' };
  const filename = path.join(data.dist, 'content-manifest.json'); const metadata = lib.readJson(filename);
  fs.writeFileSync(filename, JSON.stringify({ ...metadata, schemaVersion: 2 }));
  assert.throws(() => packageRelease(options), /Unsupported website manifest schema/);
  fs.writeFileSync(filename, JSON.stringify({ ...metadata, articleCount: 999 }));
  assert.throws(() => packageRelease(options), /articleCount/);
});
