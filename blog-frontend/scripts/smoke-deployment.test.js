'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkDeployment, isJsonContentType, isXmlContentType, normalizeCloudflareEmailMarkers } = require('./smoke-deployment');
const fixture = require('./pages-release.test-fixtures');
function dataFor(t, settings) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-smoke-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return fixture.makeRelease(root, settings); }
function options(data, fetchImpl = fixture.fixtureFetch(data.dist), extra = {}) { return { baseUrl: fixture.SITE_URL, siteUrl: fixture.SITE_URL, expectedManifest: data.manifest, fetchImpl, timeoutMs: 1000, ...extra }; }
test('single-site smoke binds transport, aliases, legacy links, media and custom 404 to archive', async (t) => {
  const data = dataFor(t); const seen = [];
  const wrapped = fixture.fixtureFetch(data.dist, { edit: (resource) => { seen.push(resource.url); } });
  const result = await checkDeployment(options(data, wrapped, { baseUrl: 'https://preview.example.test' }));
  assert.equal(result.releaseTag, data.tag); assert.equal(result.articleStatus, true);
  for (const fragment of ['/posts/old-post/', 'post.html?slug=', '/media/', '__pages_smoke_missing_']) assert.ok(seen.some((url) => url.includes(fragment)));
});
test('smoke verifies every article and the about page, rather than only the first article', async (t) => {
  const data = dataFor(t, { secondArticle: true });
  for (const name of ['posts/second-post/index.html', 'about.html']) {
    const edit = (resource) => resource.name === name ? { body: `${resource.body}stale content` } : null;
    await assert.rejects(checkDeployment(options(data, fixture.fixtureFetch(data.dist, { edit }))), /differs from expected release/);
  }
});
test('old internally consistent website cannot pass expected release', async (t) => {
  const data = dataFor(t); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-smoke-old-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = fixture.makeRelease(root, { marker: 'old' });
  await assert.rejects(checkDeployment(options(data, fixture.fixtureFetch(old.dist))), /differs from expected release/);
  await assert.rejects(checkDeployment({ canonicalUrl: fixture.SITE_URL, mirrorUrl: 'https://old.example.test', fetchImpl: fixture.fixtureFetch(old.dist) }), /trusted release manifest is required/);
});
test('designated baseline passes without adding modern identity fields', async (t) => {
  const data = dataFor(t, { legacy: true }); const result = await checkDeployment(options(data)); assert.equal(result.releaseTag, data.tag);
});
test('homepage fallback, changed media and wrong asset MIME fail', async (t) => {
  const data = dataFor(t);
  for (const edit of [({ status }) => status === 404 ? { status: 200 } : null,
    ({ name }) => name.startsWith('media/') ? { body: 'changed media' } : null,
    ({ name }) => name === 'style.css' ? { contentType: 'text/html' } : null]) {
    await assert.rejects(checkDeployment(options(data, fixture.fixtureFetch(data.dist, { edit }))));
  }
});
test('GitHub custom-domain redirect requires canonical origin and preserved path', async (t) => {
  const data = dataFor(t); const entry = 'https://example.github.io';
  const edit = ({ url }) => new URL(url).origin === entry ? { finalUrl: url.replace(entry, fixture.SITE_URL) } : null;
  await checkDeployment(options(data, fixture.fixtureFetch(data.dist, { edit }), { githubEntryUrl: entry }));
  for (const finalUrl of ['https://attacker.example.test/', `${fixture.SITE_URL}/unexpected`]) {
    const incorrect = ({ url }) => new URL(url).origin === entry ? { finalUrl } : null;
    await assert.rejects(checkDeployment(options(data, fixture.fixtureFetch(data.dist, { edit: incorrect }), { githubEntryUrl: entry })), /unexpected domain|different path/);
  }
});
test('only email_off comments may change in HTML', async (t) => {
  const data = dataFor(t);
  const stripped = ({ name, body }) => name.endsWith('.html') ? { body: normalizeCloudflareEmailMarkers(body.toString()) } : null;
  await checkDeployment(options(data, fixture.fixtureFetch(data.dist, { edit: stripped })));
  const injected = ({ name, body }) => name === 'index.html' ? { body: `${body}<script>injected()</script>` } : null;
  await assert.rejects(checkDeployment(options(data, fixture.fixtureFetch(data.dist, { edit: injected }))), /altered HTML/);
});
test('HTML normalization rejects malformed UTF-8 rather than accepting replacement-character collisions', async (t) => {
  const data = dataFor(t);
  const edit = ({ name, body }) => name === 'index.html' ? { body: Buffer.concat([body, Buffer.from([0xff])]) } : null;
  await assert.rejects(checkDeployment(options(data, fixture.fixtureFetch(data.dist, { edit }))), /Invalid UTF-8/);
});
test('content type checks accept structured JSON/XML and reject plain text', () => {
  assert.equal(isJsonContentType('application/problem+json; charset=utf-8'), true);
  assert.equal(isJsonContentType('text/plain'), false); assert.equal(isXmlContentType('application/rss+xml'), true);
  assert.equal(isXmlContentType('application/json'), false);
});
