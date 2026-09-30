'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./pages-release-lib');

function extractPagesArtifact(archivePath, out) {
  archivePath = path.resolve(archivePath); out = path.resolve(out);
  const archive = lib.regularFile(archivePath);
  lib.assert(archive.size > 0 && archive.size <= lib.MAX_BYTES + 100 * 1024 * 1024, 'Pages artifact exceeds resource limits');
  lib.assert(out !== path.parse(out).root && !fs.existsSync(out), 'Extraction output must be a new directory');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const parent = fs.mkdtempSync(path.join(path.dirname(out), '.pages-transfer-'));
  const stage = path.join(parent, 'site');
  try {
    lib.runArchive(['extract-pages', archivePath, stage]);
    lib.walkFiles(stage);
    fs.renameSync(stage, out);
    return out;
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
}

function verifyRelease(options) {
  const release = path.resolve(options.release);
  const out = path.resolve(options.out);
  lib.assert(out !== path.parse(out).root && out !== release, 'Unsafe extraction output directory');
  lib.assert(!fs.existsSync(out), 'Extraction output already exists; refusing to overwrite it');
  lib.assert(lib.SHA.test(options.expectedSha), 'An independent expected archive SHA-256 is required');
  const manifestPath = path.join(release, 'release-manifest.json');
  const manifest = lib.validateReleaseManifest(lib.readJson(manifestPath));
  lib.assert(manifest.repo === options.repo && manifest.siteUrl === lib.canonicalUrl(options.siteUrl)
    && manifest.releaseTag === options.tag, 'Release identity does not match requested repository/site/tag');
  lib.assert(manifest.siteSchema !== 'legacy-baseline' || options.allowLegacyBaseline === true, 'Legacy baseline restore requires explicit opt-in');
  const archivePath = path.join(release, manifest.archive.name);
  const stat = lib.regularFile(archivePath);
  lib.assert(stat.size === manifest.archive.bytes, 'Archive byte length mismatch');
  const digest = lib.sha256(fs.readFileSync(archivePath));
  lib.assert(digest === options.expectedSha && digest === manifest.archive.sha256, 'Archive SHA-256 mismatch');
  lib.regularFile(path.join(release, 'SHA256SUMS'));
  const sums = `${digest}  site.tar.gz\n${lib.sha256(fs.readFileSync(manifestPath))}  release-manifest.json\n`;
  lib.assert(fs.readFileSync(path.join(release, 'SHA256SUMS'), 'utf8') === sums, 'SHA256SUMS does not match release assets');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const stageParent = fs.mkdtempSync(path.join(path.dirname(out), '.pages-verify-'));
  const stage = path.join(stageParent, 'site');
  try {
    lib.runArchive(['extract', archivePath, stage, manifestPath]);
    const validated = lib.validateSite(stage, manifest);
    lib.assert(JSON.stringify(validated.names) === JSON.stringify(manifest.files.map((entry) => entry.path).sort()), 'Extracted site file inventory mismatch');
    lib.assert(JSON.stringify(validated.checks) === JSON.stringify(manifest.checks), 'Release route inventory does not match website');
    for (const entry of manifest.files) {
      const bytes = fs.readFileSync(path.join(stage, entry.path));
      lib.assert(bytes.length === entry.bytes && lib.sha256(bytes) === entry.sha256, `File identity mismatch: ${entry.path}`);
      if (entry.normalizedHtmlSha256) lib.assert(lib.sha256(lib.normalizeCloudflareEmailMarkers(lib.decodeUtf8(bytes, entry.path))) === entry.normalizedHtmlSha256, `HTML comparison identity mismatch: ${entry.path}`);
    }
    fs.renameSync(stage, out);
    return manifest;
  } finally { fs.rmSync(stageParent, { recursive: true, force: true }); }
}
function main(argv = process.argv.slice(2)) {
  const args = lib.parseArgs(argv, ['release', 'pages-artifact', 'out', 'repo', 'site-url', 'tag', 'expected-sha', 'allow-legacy-baseline'], ['allow-legacy-baseline']);
  if (args['pages-artifact']) {
    lib.requireArgs(args, ['out']);
    lib.assert(!args.release && !args['allow-legacy-baseline'], 'Pages transfer mode cannot be mixed with release mode');
    const out = extractPagesArtifact(args['pages-artifact'], args.out);
    console.log(JSON.stringify({ out }));
    return;
  }
  lib.requireArgs(args, ['release', 'out', 'repo', 'site-url', 'tag', 'expected-sha']);
  const manifest = verifyRelease({ release: args.release, out: args.out, repo: args.repo, siteUrl: args['site-url'], tag: args.tag,
    expectedSha: args['expected-sha'], allowLegacyBaseline: args['allow-legacy-baseline'] });
  console.log(JSON.stringify({ releaseTag: manifest.releaseTag, artifactSha256: manifest.archive.sha256, files: manifest.files.length }));
}
if (require.main === module) { try { main(); } catch (error) { console.error(`[verify-release] ${error.message}`); process.exitCode = 1; } }
module.exports = { verifyRelease, extractPagesArtifact, main };
