const test = require('node:test');
const assert = require('node:assert/strict');
const { identityMatches, checkContext, prepare, guard } = require('./pages-publication');
test('no-op identity ignores retrieval/run time and source-only documentation commits', () => {
 const a={fingerprintVersion:1,contentFingerprint:'a',generatorFingerprint:'b',publishFingerprint:'c',siteUrl:'https://blog.minliny.com',sourceCommit:'old',releaseTag:'site-1-1',generatedAt:'old'};
 assert.equal(identityMatches(a,{...a,sourceCommit:'new',releaseTag:'site-2-1',generatedAt:'new'}),true);
 for(const key of ['fingerprintVersion','contentFingerprint','generatorFingerprint','publishFingerprint','siteUrl']) assert.equal(identityMatches(a,{...a,[key]:'different'}),false);
});
test('force cannot bypass pause; template and non-main contexts cannot publish', () => {
 const old={...process.env};
 try {
  process.env.GITHUB_REPOSITORY='minliny/minliny.github.io';process.env.GITHUB_REF='refs/heads/main';process.env.BLOG_SMOKE_BASE_URL='https://minliny.github.io';
  delete process.env.BLOG_PUBLISH_PAUSED;assert.throws(()=>checkContext('publish'));
  process.env.BLOG_PUBLISH_PAUSED='true';assert.throws(()=>checkContext('publish'));assert.doesNotThrow(()=>checkContext('rollback'));
  process.env.BLOG_PUBLISH_PAUSED='false';assert.doesNotThrow(()=>checkContext('publish'));assert.throws(()=>checkContext('rollback'));
  process.env.GITHUB_REPOSITORY='minliny/MoZhu_Blog';assert.throws(()=>checkContext('publish'));
  process.env.GITHUB_REPOSITORY='minliny/minliny.github.io';process.env.GITHUB_REF='refs/heads/test';assert.throws(()=>checkContext('publish'));
 } finally { for(const key of Object.keys(process.env)) if(!(key in old))delete process.env[key]; Object.assign(process.env,old); }
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computePublishFingerprint } = require('./publish-fingerprint');

function context(t, paused = 'false') {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-publication-test-'));
 const values = {
  GITHUB_REPOSITORY: 'minliny/minliny.github.io', GITHUB_REF: 'refs/heads/main',
  BLOG_PUBLISH_PAUSED: paused, BLOG_SMOKE_BASE_URL: 'https://minliny.github.io',
  GITHUB_RUN_ID: '123', GITHUB_OUTPUT: path.join(directory, 'outputs'),
  GITHUB_STEP_SUMMARY: path.join(directory, 'summary'),
 };
 const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
 Object.assign(process.env, values);
 t.after(() => {
  for (const [key, value] of Object.entries(previous)) {
   if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(directory, { recursive: true, force: true });
 });
 return directory;
}
function publication(changes = {}) {
 const identity = {
  fingerprintVersion: 1,
  contentFingerprint: 'sha256:' + 'a'.repeat(64),
  generatorFingerprint: 'sha256:' + 'b'.repeat(64),
  sourceRepository: 'minliny/minliny.github.io', sourceCommit: 'c'.repeat(40),
  siteUrl: 'https://blog.minliny.com', releaseTag: 'site-100-1',
  buildEnvironment: { nodeVersion: '24.1.0', lockfileSha256: 'sha256:' + 'd'.repeat(64) },
  ...changes,
 };
 identity.publishFingerprint = computePublishFingerprint(identity.contentFingerprint, identity.generatorFingerprint, identity.siteUrl);
 return identity;
}
function prepareOptions(directory, candidate, force = 'false') {
 const identity = path.join(directory, 'identity.json');
 fs.writeFileSync(identity, JSON.stringify(candidate));
 return { identity, out: path.join(directory, 'decision.json'), force };
}
function currentRelease(online, options = {}) {
 const calls = [];
 const services = {
  fetch: async (url, fetchOptions) => {
   calls.push({ operation: 'fetch', url, options: fetchOptions });
   if (options.fetchError) throw new Error('Current manifest unavailable');
   return { ok: true, json: async () => online };
  },
  downloadRelease: (tag, directory) => {
   calls.push({ operation: 'download', tag });
   fs.writeFileSync(path.join(directory, 'release-manifest.json'), JSON.stringify({ archive: { sha256: 'e'.repeat(64) } }));
   return 'e'.repeat(64);
  },
  runNode: (script, args) => {
   calls.push({ operation: script, args });
   if (script === 'verify-pages-release.js') {
    if (options.verifyError) throw new Error('Archive bytes mismatch');
    const out = args[args.indexOf('--out') + 1];
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'content-manifest.json'), JSON.stringify(options.archived || online));
   } else if (script === 'smoke-deployment.js') {
    if (options.smokeError) throw new Error('Public resource hash differs from trusted archive');
   } else throw new Error('Unexpected side effect: ' + script);
  },
 };
 return { services, calls };
}

test('trusted unchanged publication verifies archive and live bytes without requesting build or upload', async (t) => {
 const directory = context(t);
 const online = publication();
 // A new documentation-only commit and run do not alter the rendered inputs.
 const candidate = publication({ sourceCommit: 'f'.repeat(40), releaseTag: 'site-123-1' });
 const { services, calls } = currentRelease(online);
 const decision = await prepare(prepareOptions(directory, candidate), services);
 assert.deepEqual(decision, { changed: false, needsTests: false, reason: 'Verified unchanged release', currentRelease: online.releaseTag });
 assert.deepEqual(calls.map(call => call.operation), ['fetch', 'download', 'verify-pages-release.js', 'smoke-deployment.js']);
 assert.equal(calls[0].options.redirect, 'error');
 assert.equal(calls[0].options.cache, 'no-store');
 assert.match(fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), /^changed=false\nneeds_tests=false\n$/);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'decision.json'))), decision);
});

test('matching online fingerprints cannot establish no-op when stale cached resources fail smoke', async (t) => {
 const directory = context(t);
 const candidate = publication();
 const { services, calls } = currentRelease(candidate, { smokeError: true });
 const decision = await prepare(prepareOptions(directory, candidate), services);
 assert.equal(decision.changed, true);
 assert.equal(decision.needsTests, false); // Code was already tested before the trusted archive was made.
 assert.match(decision.reason, /Repair publication required.*resource hash/);
 assert.equal(calls.filter(call => call.operation === 'smoke-deployment.js').length, 1);
 assert.match(fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), /changed=true/);
 assert.doesNotMatch(fs.readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8'), /Unchanged:/);
});

test('unverified archive, missing schema and manifest transport failure require tests and publication', async (t) => {
 const directory = context(t);
 const candidate = publication();
 for (const [online, failure] of [
  [candidate, { verifyError: true }],
  [{ source: 'notion', siteUrl: candidate.siteUrl }, {}],
  [candidate, { fetchError: true }],
  [candidate, { archived: publication({ sourceCommit: 'e'.repeat(40) }) }],
 ]) {
  const { services, calls } = currentRelease(online, failure);
  const decision = await prepare(prepareOptions(directory, candidate), services);
  assert.equal(decision.changed, true);
  assert.equal(decision.needsTests, true);
  assert.equal(calls.filter(call => call.operation === 'smoke-deployment.js').length, 0);
 }
});

test('repeated scheduled polls cannot bypass an unverified new generator after its tests fail', async (t) => {
 const directory = context(t);
 const prior = publication();
 const candidate = publication({ generatorFingerprint: 'sha256:' + '1'.repeat(64), releaseTag: 'site-123-1' });
 const { services } = currentRelease(prior);
 // Failed tests do not update the current release: the next poll must make the same decision.
 for (let attempt = 0; attempt < 2; attempt++) {
  const decision = await prepare(prepareOptions(directory, candidate), services);
  assert.equal(decision.changed, true);
  assert.equal(decision.needsTests, true);
 }
 const verified = currentRelease(candidate);
 const success = await prepare(prepareOptions(directory, candidate), verified.services);
 assert.equal(success.changed, false);
 assert.equal(success.needsTests, false);
});

test('force requests a new publication but cannot bypass the pause or production gate', async (t) => {
 const directory = context(t);
 const candidate = publication();
 const { services, calls } = currentRelease(candidate);
 const forced = await prepare(prepareOptions(directory, candidate, 'true'), services);
 assert.equal(forced.changed, true);
 assert.equal(forced.needsTests, false);
 assert.equal(calls.filter(call => call.operation === 'smoke-deployment.js').length, 0);
 process.env.BLOG_PUBLISH_PAUSED = 'true';
 const count = calls.length;
 await assert.rejects(prepare(prepareOptions(directory, candidate, 'true'), services), /pause/);
 assert.equal(calls.length, count);
});

function mockGuard(options = {}) {
 const calls = [];
 return {
  calls,
  gh: args => {
   calls.push(args);
   const endpoint = args[1];
   if (endpoint.endsWith('/actions/workflows/deploy-blog.yml')) return JSON.stringify({ state: options.state || 'active' });
   if (endpoint.endsWith('/git/ref/heads/main')) return JSON.stringify({ object: { sha: options.head || 'c'.repeat(40) } });
   const status = new URL('https://api.github.com/' + endpoint).searchParams.get('status');
   assert.ok(['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(status));
   return JSON.stringify({ total_count: status === options.unfinished ? 1 : 0, workflow_runs: [] });
  },
 };
}

test('activation guard refuses a stale main or a disabled workflow and accepts the current trusted head', (t) => {
 context(t);
 const commit = 'c'.repeat(40);
 assert.equal(guard({ commit }, mockGuard()), true);
 assert.equal(guard({ commit }, mockGuard({ head: 'd'.repeat(40) })), false);
 assert.equal(guard({ commit }, mockGuard({ state: 'disabled_manually' })), false);
 assert.match(fs.readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8'), /Skipped activation/);
});

test('rollback requires explicit pause, a disabled entry point and no unfinished run in any state', (t) => {
 context(t, 'true');
 assert.throws(() => guard({ mode: 'rollback' }, mockGuard()), /Disable and drain/);
 for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
  // total_count is authoritative even if an old unfinished run is outside the first page.
  assert.throws(() => guard({ mode: 'rollback' }, mockGuard({ state: 'disabled_manually', unfinished: status })), new RegExp(status));
 }
 const drained = mockGuard({ state: 'disabled_manually' });
 assert.equal(guard({ mode: 'rollback' }, drained), true);
 assert.equal(drained.calls.filter(args => args[1].includes('/runs?status=')).length, 5);
 process.env.BLOG_PUBLISH_PAUSED = 'false';
 assert.throws(() => guard({ mode: 'rollback' }, mockGuard({ state: 'disabled_manually' })), /pause/);
});
