'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./pages-release-lib');

function packageRelease(options) {
  const dist = path.resolve(options.dist);
  const out = path.resolve(options.out);
  lib.assert(out !== path.parse(out).root && out !== dist && !out.startsWith(`${dist}${path.sep}`), 'Unsafe release output directory');
  lib.assert(!fs.existsSync(out), 'Release output already exists; refusing to overwrite an archive');
  const site = lib.readJson(path.join(dist, 'content-manifest.json'));
  const legacy = options.legacyBaseline === true;
  const identity = {
    schemaVersion: 1, siteSchema: legacy ? 'legacy-baseline' : 'current', repo: options.repo, sourceRepository: options.repo,
    sourceCommit: options.commit, releaseTag: options.tag,
    siteUrl: lib.canonicalUrl(options.siteUrl || site.siteUrl),
    ...(legacy ? { sourceRunId: options.sourceRun } : {
      fingerprintVersion: site.fingerprintVersion, contentFingerprint: site.contentFingerprint,
      generatorFingerprint: site.generatorFingerprint, publishFingerprint: site.publishFingerprint,
      buildEnvironment: site.buildEnvironment,
    }),
    ...(site.buildHash ? { buildHash: site.buildHash } : {}),
  };
  const validated = lib.validateSite(dist, identity);
  const htmlComparison = options.htmlMode || 'email-off-markers';
  lib.assert(['raw', 'email-off-markers'].includes(htmlComparison), 'Invalid HTML comparison mode');
  const files = validated.names.map((name) => {
    const bytes = fs.readFileSync(path.join(dist, name));
    return { path: name, bytes: bytes.length, sha256: lib.sha256(bytes),
      ...(name.endsWith('.html') && htmlComparison === 'email-off-markers'
        ? { normalizedHtmlSha256: lib.sha256(lib.normalizeCloudflareEmailMarkers(lib.decodeUtf8(bytes, name))) } : {}),
    };
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(out), '.pages-release-'));
  try {
    const inventory = path.join(stage, '.inventory.json');
    fs.writeFileSync(inventory, JSON.stringify(files));
    const archivePath = path.join(stage, 'site.tar.gz');
    lib.runArchive(['pack', dist, archivePath, inventory]);
    fs.unlinkSync(inventory);
    const archiveBytes = fs.readFileSync(archivePath);
    const manifest = { ...identity, htmlComparison,
      archive: { name: 'site.tar.gz', bytes: archiveBytes.length, sha256: lib.sha256(archiveBytes) },
      files, checks: validated.checks,
    };
    lib.validateReleaseManifest(manifest);
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(path.join(stage, 'release-manifest.json'), manifestText);
    fs.writeFileSync(path.join(stage, 'SHA256SUMS'), `${manifest.archive.sha256}  site.tar.gz\n${lib.sha256(manifestText)}  release-manifest.json\n`);
    fs.renameSync(stage, out);
    return manifest;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
function main(argv = process.argv.slice(2)) {
  const args = lib.parseArgs(argv, ['dist', 'out', 'repo', 'commit', 'tag', 'site-url', 'legacy-baseline', 'source-run', 'html-mode'], ['legacy-baseline']);
  lib.requireArgs(args, ['dist', 'out', 'repo', 'commit', 'tag']);
  const manifest = packageRelease({ dist: args.dist, out: args.out, repo: args.repo, commit: args.commit,
    tag: args.tag, siteUrl: args['site-url'], legacyBaseline: args['legacy-baseline'], sourceRun: args['source-run'], htmlMode: args['html-mode'] });
  console.log(JSON.stringify({ releaseTag: manifest.releaseTag, artifactSha256: manifest.archive.sha256, files: manifest.files.length }));
}
if (require.main === module) { try { main(); } catch (error) { console.error(`[package-release] ${error.message}`); process.exitCode = 1; } }
module.exports = { packageRelease, main };
