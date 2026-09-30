#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const REPOSITORY = 'minliny/minliny.github.io';
const SITE_URL = 'https://blog.minliny.com';
const TAG = /^site-(?:\d+-\d+|baseline-20260930-\d+)$/;
function gh(args) { return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }); }
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function argsOf(argv) { const result = {}; for (let i=0;i<argv.length;i+=2) { if (!argv[i].startsWith('--') || argv[i+1] === undefined) throw new Error('Expected --key value'); result[argv[i].slice(2)] = argv[i+1]; } return result; }
function assert(value, message) { if (!value) throw new Error(message); }
function output(values) { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k,v])=>`${k}=${v}\n`).join('')); }
function summary(text) { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`); }
function checkContext(mode) {
  assert(process.env.GITHUB_REPOSITORY === REPOSITORY && process.env.GITHUB_REF === 'refs/heads/main', 'Production requires the exact repository and main');
  assert(process.env.BLOG_PUBLISH_PAUSED === (mode === 'rollback' ? 'true' : 'false'), 'Publication pause is missing or does not allow this operation');
  assert(['https://minliny.github.io', SITE_URL].includes(process.env.BLOG_SMOKE_BASE_URL), 'Unexpected smoke transport URL');
}
function downloadRelease(tag, directory) {
  assert(TAG.test(tag), 'Invalid release tag');
  const release = JSON.parse(gh(['release', 'view', tag, '--repo', REPOSITORY, '--json', 'tagName,isDraft,url']));
  assert(!release.isDraft && release.tagName === tag, 'Release is not a public archive');
  gh(['release', 'download', tag, '--repo', REPOSITORY, '--dir', directory, '--pattern', 'site.tar.gz', '--pattern', 'release-manifest.json', '--pattern', 'SHA256SUMS']);
  const sums = fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8');
  const match = sums.match(/^([a-f0-9]{64})  site\.tar\.gz$/m);
  const manifestMatch = sums.match(/^([a-f0-9]{64})  release-manifest\.json$/m);
  assert(match && manifestMatch && manifestMatch[1] === sha(path.join(directory, 'release-manifest.json')), 'Release checksum record does not match');
  return match[1];
}
function runNode(script, args) { execFileSync(process.execPath, [path.join(__dirname, script), ...args], { stdio: 'inherit', timeout: 300000 }); }
function identityMatches(a, b) { return ['fingerprintVersion', 'contentFingerprint', 'generatorFingerprint', 'publishFingerprint', 'siteUrl'].every(k=>a[k] === b[k]); }
async function prepare(options, services = {}) {
  const fetchCurrent = services.fetch || globalThis.fetch;
  const getRelease = services.downloadRelease || downloadRelease;
  const executeNode = services.runNode || runNode;
  checkContext('publish');
  const identity = json(options.identity);
  const { validatePublicationIdentity } = require('./publish-fingerprint');
  validatePublicationIdentity(identity);
  let online, trusted = false, reason = 'No verified current release';
  try {
    const response = await fetchCurrent(`${process.env.BLOG_SMOKE_BASE_URL}/content-manifest.json?check=${process.env.GITHUB_RUN_ID}`, { signal: AbortSignal.timeout(15000), redirect: 'error', cache: 'no-store' });
    assert(response.ok, `Current manifest HTTP ${response.status}`);
    online = await response.json();
    validatePublicationIdentity(online);
    assert(online.sourceRepository === REPOSITORY && online.siteUrl === SITE_URL && TAG.test(online.releaseTag), 'Current release identity is invalid');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-current-release-'));
    try {
      const expected = getRelease(online.releaseTag, directory);
      executeNode('verify-pages-release.js', ['--release', directory, '--out', path.join(directory,'verified'), '--repo', REPOSITORY, '--site-url', SITE_URL, '--tag', online.releaseTag, '--expected-sha', expected]);
      const archived = json(path.join(directory, 'verified/content-manifest.json'));
      assert(identityMatches(online, archived) && online.sourceCommit === archived.sourceCommit && online.releaseTag === archived.releaseTag, 'Online identity differs from trusted archive');
      // The archive is prepared only after tests pass. A failed smoke never establishes a no-op.
      trusted = true;
      if (identityMatches(identity, archived) && options.force !== 'true') {
        executeNode('smoke-deployment.js', ['--base-url', process.env.BLOG_SMOKE_BASE_URL, '--site-url', SITE_URL, '--release-manifest', path.join(directory, 'release-manifest.json')]);
        const decision = { changed: false, needsTests: false, reason: 'Verified unchanged release', currentRelease: online.releaseTag };
        fs.writeFileSync(options.out, JSON.stringify(decision, null, 2));
        output({ changed: false, needs_tests: false });
        summary(`Unchanged: verified ${online.releaseTag}. No build, artifact upload, release or Pages deployment.`);
        return decision;
      }
      reason = options.force === 'true' ? 'Forced publication' : 'Publication fingerprint changed';
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  } catch (error) { reason = `Repair publication required: ${error.message}`; }
  const decision = { changed: true, needsTests: !trusted || !online || online.generatorFingerprint !== identity.generatorFingerprint, reason };
  fs.writeFileSync(options.out, JSON.stringify(decision, null, 2));
  output({ changed: true, needs_tests: decision.needsTests });
  summary(decision.reason);
  return decision;
}
function guard(options, services = {}) {
  const readGh = services.gh || gh;
  checkContext(options.mode || 'publish');
  const workflow = JSON.parse(readGh(['api', `repos/${REPOSITORY}/actions/workflows/deploy-blog.yml`]));
  if (options.mode === 'rollback') {
    assert(workflow.state.startsWith('disabled'), 'Disable and drain normal publication before rollback');
    for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
      const runs = JSON.parse(readGh(['api', `repos/${REPOSITORY}/actions/workflows/deploy-blog.yml/runs?status=${status}&per_page=1`]));
      assert(runs.total_count === 0, `Normal publication still has ${status} runs`);
    }
    output({ activate: true }); return true;
  }
  const head = JSON.parse(readGh(['api', `repos/${REPOSITORY}/git/ref/heads/main`])).object.sha;
  const activate = workflow.state === 'active' && head === options.commit;
  output({ activate });
  if (!activate) summary('Skipped activation: normal publication was disabled or main advanced.');
  return activate;
}
function archive(options) {
  checkContext('publish');
  const manifest = json(path.join(options.release, 'release-manifest.json'));
  const tag = manifest.releaseTag;
  assert(TAG.test(tag) && manifest.sourceRepository === REPOSITORY, 'Archive identity rejected');
  const ref = JSON.parse(gh(['api', `repos/${REPOSITORY}/git/ref/heads/main`]));
  assert(ref.object.sha === manifest.sourceCommit, 'Archive source is stale');
  let exists = false;
  try { gh(['release','view',tag,'--repo',REPOSITORY,'--json','tagName']); exists = true; } catch (error) {
    // Distinguish an absent release from authentication, transport and other failures.
    const stderr = String(error.stderr || '');
    if (!/not found|HTTP 404/i.test(stderr)) throw error;
  }
  if (exists) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-existing-release-'));
    try { downloadRelease(tag, directory); for (const name of ['site.tar.gz','release-manifest.json','SHA256SUMS']) assert(sha(path.join(directory,name)) === sha(path.join(options.release,name)), `Existing ${name} differs; never overwrite a release`); }
    finally { fs.rmSync(directory,{recursive:true,force:true}); }
  } else {
    const body = path.join(options.release,'release-notes.md');
    fs.writeFileSync(body, `Static Published content archive prepared before Pages activation.\n\nSource: ${manifest.sourceCommit}\nArchive SHA-256: ${manifest.archive.sha256}\n\nArchive availability does not establish successful deployment or external verification. Use the Actions run and website identity for activation status. Historical archives may retain withdrawn articles.\n`);
    gh(['release','create',tag, ...['site.tar.gz','release-manifest.json','SHA256SUMS'].map(name=>path.join(options.release,name)), '--repo',REPOSITORY,'--target',manifest.sourceCommit,'--title',tag,'--notes-file',body,'--latest=false']);
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'blog-upload-verification-'));
  try { downloadRelease(tag,directory); for (const name of ['site.tar.gz','release-manifest.json','SHA256SUMS']) assert(sha(path.join(directory,name)) === sha(path.join(options.release,name)), `Uploaded ${name} differs`); }
  finally { fs.rmSync(directory,{recursive:true,force:true}); }
  summary(`Archive prepared and downloaded for verification: ${tag}; source ${manifest.sourceCommit}; SHA-256 ${manifest.archive.sha256}. Pages activation and smoke are separate subsequent steps.`);
}
async function main(argv=process.argv.slice(2)) { const mode=argv.shift(); const options=argsOf(argv); if(mode==='prepare') await prepare(options); else if(mode==='guard') guard(options); else if(mode==='archive') archive(options); else throw new Error('Expected prepare, guard or archive'); }
if(require.main===module) main().catch(error=>{ console.error(error.message); process.exitCode=1; });
module.exports={ identityMatches,checkContext,argsOf,prepare,guard };
