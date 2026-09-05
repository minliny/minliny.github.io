'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  automaticSlug,
  validateDatabaseSchema,
  validatePublishedPages,
} = require('./content-schema');
const {
  buildSnapshot,
  createManifest,
  downloadNotionImage,
  escapeMarkdownText,
  fetchDatabasePages,
  generateExcerptFromBody,
  markdownToPlainText,
  resolveContentDir,
  richTextToMarkdown,
  sanitizeUrl,
  serializeFrontmatter,
  writeSnapshot,
} = require('./sync-notion');

function databaseFixture() {
  return {
    properties: {
      '名称': { type: 'title', title: {} },
      Slug: { type: 'rich_text', rich_text: {} },
      Status: { type: 'select', select: { options: [{ name: 'Draft' }, { name: 'Published' }] } },
      Excerpt: { type: 'rich_text', rich_text: {} },
      Group: { type: 'select', select: { options: [{ name: 'tech' }, { name: 'notes' }] } },
      Tags: { type: 'multi_select', multi_select: { options: [] } },
      Cover: { type: 'files', files: {} },
      Aliases: { type: 'multi_select', multi_select: { options: [] } },
    },
  };
}

function richText(value) {
  return [{ plain_text: value, annotations: {} }];
}

function pageFixture(overrides = {}) {
  const id = overrides.id || 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const value = (name, fallback) => Object.hasOwn(overrides, name) ? overrides[name] : fallback;
  const slug = value('slug', 'safe-article');
  return {
    id,
    created_time: value('createdTime', '2026-07-18T08:00:00.000Z'),
    last_edited_time: value('lastEditedTime', '2026-07-19T08:00:00.000Z'),
    cover: null,
    properties: {
      '名称': { type: 'title', title: richText(overrides.title || 'Safe <Article>') },
      Slug: { type: 'rich_text', rich_text: richText(slug) },
      Status: { type: 'select', select: { name: overrides.status || 'Published' } },
      Date: { type: 'date', date: { start: value('date', '2026-07-19') } },
      Excerpt: { type: 'rich_text', rich_text: richText(value('excerpt', 'Summary')) },
      Group: { type: 'select', select: { name: value('group', 'tech') } },
      Tags: { type: 'multi_select', multi_select: [{ name: 'node' }, { name: 'node' }] },
      Cover: { type: 'files', files: [] },
      Aliases: {
        type: 'multi_select',
        multi_select: (overrides.aliases || []).map((name) => ({ name })),
      },
    },
  };
}

test('database and published page use one shared schema contract', () => {
  const databaseResult = validateDatabaseSchema(databaseFixture());
  assert.deepEqual(databaseResult.errors, []);

  const pageResult = validatePublishedPages([
    pageFixture({ aliases: ['old-safe-article', 'safe-article'] }),
  ]);
  assert.deepEqual(pageResult.errors, []);
  assert.deepEqual(pageResult.articles[0].aliases, ['old-safe-article']);
  assert.deepEqual(pageResult.articles[0].tags, ['node']);
});

test('author metadata defaults to stable slug, created time, and notes group', () => {
  const minimalDatabase = databaseFixture();
  ['Slug', 'Excerpt', 'Group', 'Tags', 'Cover', 'Aliases'].forEach((name) => {
    delete minimalDatabase.properties[name];
  });
  assert.deepEqual(validateDatabaseSchema(minimalDatabase).errors, []);

  const page = pageFixture({ slug: '', date: 'not-a-date', excerpt: '', group: '' });
  ['Slug', 'Date', 'Excerpt', 'Group', 'Tags', 'Cover', 'Aliases'].forEach((name) => {
    delete page.properties[name];
  });
  const result = validatePublishedPages([page]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.articles[0].slug, automaticSlug(page.id));
  assert.equal(result.articles[0].date, '2026-07-18');
  assert.equal(result.articles[0].excerpt, '');
  assert.equal(result.articles[0].group, 'notes');
});

test('a published page needs only a name and non-empty body', async () => {
  const page = pageFixture({ slug: '', excerpt: '', group: '' });
  ['Slug', 'Date', 'Excerpt', 'Group', 'Tags', 'Cover', 'Aliases'].forEach((name) => {
    delete page.properties[name];
  });
  const validation = validatePublishedPages([page]);
  assert.deepEqual(validation.errors, []);

  const client = {
    blocks: {
      children: {
        list: async () => ({
          results: [{
            id: 'paragraph-minimal',
            type: 'paragraph',
            has_children: false,
            paragraph: { rich_text: richText('只填写正文也能生成完整文章。') },
          }],
          has_more: false,
          next_cursor: null,
        }),
      },
    },
  };
  const snapshot = await buildSnapshot(client, validation.articles);
  assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.articles[0].slug, automaticSlug(page.id));
  assert.equal(snapshot.articles[0].date, '2026-07-18');
  assert.equal(snapshot.articles[0].updatedAt, '2026-07-19T08:00:00.000Z');
  assert.equal(snapshot.articles[0].group, 'notes');
  assert.equal(snapshot.articles[0].excerpt, '只填写正文也能生成完整文章。');
});

test('Draft and Published status options are required by the authoring template', () => {
  const database = databaseFixture();
  database.properties.Status.select.options = [{ name: 'Published' }];
  assert.match(validateDatabaseSchema(database).errors.join('\n'), /must define a "Draft"/);
});

test('published query does not depend on a Date database property', async () => {
  let receivedQuery;
  const client = {
    databases: {
      query: async (query) => {
        receivedQuery = query;
        return { results: [], has_more: false, next_cursor: null };
      },
    },
  };

  await fetchDatabasePages(client);
  assert.equal(receivedQuery.filter.property, 'Status');
  assert.equal(receivedQuery.filter.select.equals, 'Published');
  assert.equal(Object.hasOwn(receivedQuery, 'sorts'), false);
});

test('any non-empty Notion group is accepted without an allowlist', () => {
  const database = databaseFixture();
  database.properties.Group.select.options.push({ name: '研究札记' });
  assert.deepEqual(validateDatabaseSchema(database).errors, []);
  assert.deepEqual(validateDatabaseSchema(database).warnings, []);

  const result = validatePublishedPages([pageFixture({ group: '研究札记' })]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.articles[0].group, '研究札记');
});

test('empty Excerpt is derived deterministically from plain article text', () => {
  const body = [
    '# 自动化工具小结',
    '',
    '这是 **正文** 第一段，包含 [参考链接](<https://example.test/path>) 和 <em>HTML</em>。',
    '',
    '```js',
    'const secret = "code is not summary";',
    '```',
    '',
    '- 第二段补充说明。',
  ].join('\n');
  const excerpt = generateExcerptFromBody(body);

  assert.equal(excerpt, '这是 正文 第一段，包含 参考链接 和 HTML。 第二段补充说明。');
  assert.equal(generateExcerptFromBody(body), excerpt);
  assert.doesNotMatch(excerpt, /[#*`<>\[\]]|https?:\/\//);
  assert.equal(markdownToPlainText('&lt;strong&gt;安全文本&lt;/strong&gt;'), '安全文本');
  assert.throws(() => generateExcerptFromBody('<!-- unsupported notion block: child_database -->'), /does not contain text/);
  assert.equal(
    generateExcerptFromBody('<!-- unsupported notion block: child_database -->', { fallback: '仅代码文章' }),
    '仅代码文章'
  );
});

test('generated excerpts prefer a complete sentence and hard-limit long text', () => {
  const sentence = '前半部分用于提供足够上下文，并说明自动发布流程如何从正文提取摘要。';
  const excerpt = generateExcerptFromBody(`${sentence}${'后续内容'.repeat(30)}`);
  const hardCut = generateExcerptFromBody('没有句号的连续正文'.repeat(30));

  assert.equal(excerpt, sentence);
  assert.ok(Array.from(hardCut).length <= 120);
  assert.match(hardCut, /…$/);
});

test('an existing Excerpt remains an optional author override', async () => {
  const validation = validatePublishedPages([pageFixture({ excerpt: '保留已有的人工摘要。' })]);
  const client = {
    blocks: {
      children: {
        list: async () => ({
          results: [{
            id: 'paragraph-1',
            type: 'paragraph',
            has_children: false,
            paragraph: { rich_text: richText('正文内容不会覆盖人工摘要。') },
          }],
          has_more: false,
          next_cursor: null,
        }),
      },
    },
  };

  const snapshot = await buildSnapshot(client, validation.articles);
  assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.articles[0].excerpt, '保留已有的人工摘要。');
  assert.equal(snapshot.generatedExcerptCount, 0);
});

test('published metadata validation collects errors across all pages', () => {
  const result = validatePublishedPages([
    pageFixture({ id: '11111111-1111-1111-1111-111111111111', slug: 'Bad Slug', group: 'other' }),
    pageFixture({ id: '22222222-2222-2222-2222-222222222222', slug: 'second', createdTime: 'not-a-date' }),
    pageFixture({ id: '33333333-3333-3333-3333-333333333333', slug: 'third', status: 'Draft' }),
  ]);

  assert.ok(result.errors.length >= 3);
  assert.match(result.errors.join('\n'), /invalid Slug/);
  assert.match(result.errors.join('\n'), /invalid date/);
  assert.match(result.errors.join('\n'), /must be "Published"/);
});

test('published pages still require a non-empty body', async () => {
  const result = validatePublishedPages([pageFixture()]);
  const client = {
    blocks: {
      children: {
        list: async () => ({ results: [], has_more: false, next_cursor: null }),
      },
    },
  };
  const snapshot = await buildSnapshot(client, result.articles);
  assert.match(snapshot.errors.join('\n'), /article body is empty/);
});

test('slug and alias routes must be globally unique', () => {
  const result = validatePublishedPages([
    pageFixture({ id: '11111111-1111-1111-1111-111111111111', slug: 'first', aliases: ['legacy'] }),
    pageFixture({ id: '22222222-2222-2222-2222-222222222222', slug: 'legacy' }),
  ]);
  assert.match(result.errors.join('\n'), /Route "legacy" is claimed by multiple published pages/);
});

test('Markdown text is escaped and unsafe protocols are rejected', () => {
  assert.equal(escapeMarkdownText('<script>*x*</script>'), '&lt;script&gt;\\*x\\*&lt;/script&gt;');
  assert.equal(sanitizeUrl('javascript:alert(1)', new Set(['https:'])), '');
  assert.equal(sanitizeUrl('https://example.com/a', new Set(['https:'])), 'https://example.com/a');

  const context = { unsafeUrlCounts: new Map() };
  const markdown = richTextToMarkdown([{
    plain_text: '<img src=x>',
    href: 'javascript:alert(1)',
    annotations: {},
  }], context);
  assert.equal(markdown, '&lt;img src=x&gt;');
  assert.equal(context.unsafeUrlCounts.get('rich_text_link'), 1);

  const safeContext = { unsafeUrlCounts: new Map() };
  const spacedLink = richTextToMarkdown([{
    plain_text: 'read',
    href: 'https://example.com/a b',
    annotations: {},
  }], safeContext);
  assert.equal(spacedLink, '[read](<https://example.com/a%20b>)');
  assert.throws(() => resolveContentDir('/private/tmp/not-a-project-content-dir'), /Unsafe CONTENT_DIR/);
});

test('Notion image downloads are content-addressed and deduplicated', async () => {
  const mediaStore = { files: new Map(), bySourceUrl: new Map() };
  const bytes = Buffer.from('fake-png');
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return {
      ok: true,
      status: 200,
      url: 'https://files.example.test/image.png',
      headers: new Headers({ 'content-type': 'image/png', 'content-length': String(bytes.length) }),
      arrayBuffer: async () => bytes,
    };
  };

  const first = await downloadNotionImage('https://files.example.test/image.png', mediaStore, { fetchImpl });
  const second = await downloadNotionImage('https://files.example.test/image.png', mediaStore, { fetchImpl });
  assert.equal(first, second);
  assert.match(first, /^\.\.\/media\/[a-f0-9]{64}\.png$/);
  assert.equal(fetchCount, 1);
  assert.equal(mediaStore.files.size, 1);
});

test('snapshot output replaces old state and emits schemaVersion 1 manifest', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mozhu-content-test-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const outputDir = path.join(temporaryRoot, 'notion');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'stale.txt'), 'stale', 'utf8');

  const client = {
    blocks: {
      children: {
        list: async () => ({
          results: [{
            id: 'block-1',
            type: 'paragraph',
            has_children: false,
            paragraph: { rich_text: richText('<b>safe</b>') },
          }],
          has_more: false,
          next_cursor: null,
        }),
      },
    },
  };
  const validation = validatePublishedPages([pageFixture({ excerpt: '' })]);
  const snapshot = await buildSnapshot(client, validation.articles);
  const manifest = createManifest(snapshot);
  writeSnapshot(outputDir, snapshot, manifest);

  assert.equal(fs.existsSync(path.join(outputDir, 'stale.txt')), false);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.count, 1);
  assert.equal(snapshot.generatedExcerptCount, 1);
  assert.equal(manifest.articles[0].path, 'posts/safe-article.md');
  assert.match(fs.readFileSync(path.join(outputDir, 'posts/safe-article.md'), 'utf8'), /&lt;b&gt;safe&lt;\/b&gt;/);
  assert.match(fs.readFileSync(path.join(outputDir, 'posts/safe-article.md'), 'utf8'), /excerpt: "safe"/);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8')));

  const frontmatter = serializeFrontmatter(snapshot.articles[0]);
  assert.match(frontmatter, /notionId:/);
  assert.match(frontmatter, /tags:/);
  assert.match(frontmatter, /cover: ""/);
  assert.match(frontmatter, /aliases: \[\]/);
  assert.match(frontmatter, /updatedAt:/);
});
