'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('@notionhq/client');
const {
  maskId,
  validateDatabaseSchema,
  validatePublishedPages,
} = require('./content-schema');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const ROOT_DIR = path.resolve(__dirname, '..');
const REQUIRED_ENV = ['NOTION_TOKEN', 'NOTION_DATABASE_ID'];
const DRY_RUN = process.argv.includes('--dry-run');
const ALLOW_EMPTY_SYNC = process.env.ALLOW_EMPTY_NOTION_SYNC === '1';
const STRICT_UNSUPPORTED_BLOCKS = process.env.STRICT_UNSUPPORTED_BLOCKS === '1';
const EXCERPT_MAX_LENGTH = 120;
const EXCERPT_MIN_SENTENCE_LENGTH = 30;
const MAX_MEDIA_BYTES = parsePositiveInteger(process.env.NOTION_MEDIA_MAX_BYTES, 15 * 1024 * 1024);
const MEDIA_TIMEOUT_MS = parsePositiveInteger(process.env.NOTION_MEDIA_TIMEOUT_MS, 20_000);
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const MEDIA_PROTOCOLS = new Set(['http:', 'https:']);
const IMAGE_EXTENSIONS = new Map([
  ['image/avif', 'avif'],
  ['image/gif', 'gif'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveContentDir(value = process.env.CONTENT_DIR) {
  const resolved = value
    ? path.resolve(ROOT_DIR, value)
    : path.join(ROOT_DIR, '.content', 'notion');
  const filesystemRoot = path.parse(resolved).root;
  const relativeToProject = path.relative(ROOT_DIR, resolved);

  if (
    resolved === filesystemRoot
    || resolved === ROOT_DIR
    || relativeToProject.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToProject)
  ) {
    throw new Error(`Unsafe CONTENT_DIR: ${resolved}`);
  }
  return resolved;
}

function ensureEnv() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function appendYamlArray(lines, name, values) {
  if (!values || values.length === 0) {
    lines.push(`${name}: []`);
    return;
  }
  lines.push(`${name}:`);
  values.forEach((value) => lines.push(`  - ${yamlString(value)}`));
}

function serializeFrontmatter(article) {
  const lines = [
    '---',
    `notionId: ${yamlString(article.notionId)}`,
    `title: ${yamlString(article.title)}`,
    `date: ${yamlString(article.date)}`,
    `excerpt: ${yamlString(article.excerpt)}`,
  ];
  const legacyGroup = String(article.group || '').trim();
  if (legacyGroup) lines.push(`group: ${yamlString(legacyGroup)}`);
  appendYamlArray(lines, 'tags', article.tags);
  lines.push(`cover: ${yamlString(article.cover || '')}`);
  appendYamlArray(lines, 'aliases', article.aliases);
  lines.push(`updatedAt: ${yamlString(article.updatedAt)}`, '---', '');
  return lines.join('\n');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeMarkdownText(value) {
  return escapeHtml(value)
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]{}()#+.!|>-])/g, '\\$1');
}

function escapeImageAlt(value) {
  return escapeHtml(value).replace(/\\/g, '\\\\').replace(/([\[\]])/g, '\\$1');
}

function inlineCode(value) {
  const text = String(value ?? '');
  const longestFence = Math.max(0, ...(text.match(/`+/g) || []).map((match) => match.length));
  const fence = '`'.repeat(Math.max(1, longestFence + 1));
  const padding = /^`|`$|^\s|\s$/.test(text) ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}

function codeFence(value) {
  const text = String(value ?? '');
  const longestFence = Math.max(0, ...(text.match(/`+/g) || []).map((match) => match.length));
  return '`'.repeat(Math.max(3, longestFence + 1));
}

function sanitizeUrl(value, allowedProtocols, options = {}) {
  const raw = String(value || '').trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return '';

  if (options.allowRelative && (/^#/.test(raw) || /^(?:\.\.\/|\.\/|\/(?!\/))/.test(raw))) {
    return raw;
  }

  try {
    const parsed = new URL(raw);
    return allowedProtocols.has(parsed.protocol) ? raw : '';
  } catch (_error) {
    return '';
  }
}

function markdownDestination(url) {
  const encoded = String(url).replace(/[<>\\\s]/g, (character) => encodeURIComponent(character));
  return `<${encoded}>`;
}

function incrementCounter(counter, key) {
  counter.set(key, (counter.get(key) || 0) + 1);
}

function plainTextFromRichText(richText) {
  return (richText || []).map((item) => item.plain_text || '').join('');
}

function richTextToMarkdown(richText, context) {
  return (richText || []).map((item) => {
    const rawText = item.plain_text || '';
    if (!rawText) return '';

    let text = item.annotations?.code ? inlineCode(rawText) : escapeMarkdownText(rawText);
    if (!item.annotations?.code) {
      if (item.annotations?.bold) text = `**${text}**`;
      if (item.annotations?.italic) text = `*${text}*`;
      if (item.annotations?.strikethrough) text = `~~${text}~~`;
    }

    const href = item.href || item.text?.link?.url;
    if (href) {
      const safeHref = sanitizeUrl(href, LINK_PROTOCOLS, { allowRelative: true });
      if (safeHref) {
        text = `[${text}](${markdownDestination(safeHref)})`;
      } else {
        incrementCounter(context.unsafeUrlCounts, 'rich_text_link');
      }
    }
    return text;
  }).join('');
}

async function listAllResults(fetchPage) {
  let cursor;
  const results = [];
  do {
    const response = await fetchPage(cursor);
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function fetchDatabasePages(client) {
  return listAllResults((start_cursor) => client.databases.query({
    database_id: process.env.NOTION_DATABASE_ID,
    filter: {
      property: 'Status',
      select: { equals: 'Published' },
    },
    start_cursor,
    page_size: 100,
  }));
}

async function fetchBlockChildren(client, blockId) {
  const children = await listAllResults((start_cursor) => client.blocks.children.list({
    block_id: blockId,
    start_cursor,
    page_size: 100,
  }));

  for (const child of children) {
    if (child.has_children) {
      child.children = await fetchBlockChildren(client, child.id);
    }
  }
  return children;
}

function createMediaStore() {
  return {
    files: new Map(),
    bySourceUrl: new Map(),
  };
}

function imageSourceFromBlock(block) {
  if (block.type !== 'image') return null;
  if (block.image?.type === 'external' && block.image.external?.url) {
    return { kind: 'external', url: block.image.external.url };
  }
  if (block.image?.type === 'file' && block.image.file?.url) {
    return { kind: 'notion-file', url: block.image.file.url };
  }
  return null;
}

async function downloadNotionImage(url, mediaStore, options = {}) {
  const sourceUrl = sanitizeUrl(url, MEDIA_PROTOCOLS);
  if (!sourceUrl) throw new Error('Notion media URL does not use an allowed HTTP(S) protocol');
  if (mediaStore.bySourceUrl.has(sourceUrl)) return mediaStore.bySourceUrl.get(sourceUrl);

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime does not provide fetch()');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || MEDIA_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(sourceUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'MoZhu_Blog content sync' },
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`media download timed out after ${options.timeoutMs || MEDIA_TIMEOUT_MS}ms`);
    throw new Error(`media download failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) throw new Error(`media download returned HTTP ${response.status}`);
  if (!sanitizeUrl(response.url || sourceUrl, MEDIA_PROTOCOLS)) {
    throw new Error('media download redirected to a disallowed protocol');
  }

  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const extension = IMAGE_EXTENSIONS.get(contentType);
  if (!extension) {
    throw new Error(`unsupported image Content-Type "${contentType || 'missing'}"`);
  }

  const maxBytes = options.maxBytes || MAX_MEDIA_BYTES;
  const declaredLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`image exceeds ${maxBytes} byte limit`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`image exceeds ${maxBytes} byte limit`);

  const hash = sha256(buffer);
  const fileName = `${hash}.${extension}`;
  const publicPath = `../media/${fileName}`;
  if (!mediaStore.files.has(fileName)) {
    mediaStore.files.set(fileName, { buffer, contentType, hash, fileName });
  }
  mediaStore.bySourceUrl.set(sourceUrl, publicPath);
  return publicPath;
}

function unsupportedBlockComment(type, context) {
  incrementCounter(context.unsupportedCounts, type);
  return `<!-- unsupported notion block: ${type} -->`;
}

function normalizeParagraph(text) {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function decodeHtmlEntities(value) {
  const namedEntities = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return String(value || '').replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return namedEntities[entity.toLowerCase()] ?? match;
    const hexadecimal = entity[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return '';
    try {
      return String.fromCodePoint(codePoint);
    } catch (_error) {
      return '';
    }
  });
}

function markdownToPlainText(value) {
  let text = String(value || '')
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[^]*?^\s*\1\s*$/gm, ' ')
    .replace(/^\s*\$\$\s*$[^]*?^\s*\$\$\s*$/gm, ' ')
    .replace(/^\s*#{1,6}\s+.*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)/g, ' $1 ')
    .replace(/\[([^\]]+)\]\((?:<[^>]*>|[^)]*)\)/g, ' $1 ')
    .replace(/<https?:\/\/[^>]+>/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, ' ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\[[ xX]\]\s+/gm, '')
    .replace(/(`+)([^]*?)\1/g, '$2')
    .replace(/\\([\\`*_[\]{}()#+.!|>-])/g, '$1')
    .replace(/[*_~]+/g, ' ');

  text = decodeHtmlEntities(text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\t\r\n ]+/g, ' ')
    .replace(/\s+([,.;:!?，。；：！？])/g, '$1')
    .trim();
  return text;
}

function truncateExcerpt(value, maxLength = EXCERPT_MAX_LENGTH) {
  const characters = Array.from(String(value || '').trim());
  if (characters.length <= maxLength) return characters.join('');

  const candidate = characters.slice(0, maxLength).join('');
  let sentenceEnd = -1;
  for (const match of candidate.matchAll(/[。！？!?；;]/g)) {
    if (match.index + 1 >= EXCERPT_MIN_SENTENCE_LENGTH) sentenceEnd = match.index + 1;
  }
  if (sentenceEnd > 0) return candidate.slice(0, sentenceEnd).trim();

  const availableLength = Math.max(1, maxLength - 1);
  let hardCut = characters.slice(0, availableLength).join('').trimEnd();
  const finalSpace = hardCut.lastIndexOf(' ');
  if (finalSpace >= EXCERPT_MIN_SENTENCE_LENGTH) hardCut = hardCut.slice(0, finalSpace).trimEnd();
  return `${hardCut}…`;
}

function generateExcerptFromBody(body, options = {}) {
  const plainText = markdownToPlainText(body);
  const fallback = markdownToPlainText(options.fallback || '');
  const source = plainText || fallback;
  if (!source) throw new Error('article body does not contain text that can be used for an excerpt');
  return truncateExcerpt(source, options.maxLength || EXCERPT_MAX_LENGTH);
}

function prefixLines(value, prefix) {
  return String(value || '').split('\n').map((line) => `${prefix}${line}`).join('\n');
}

async function renderChildren(children, context, depth = 0) {
  const chunks = [];
  for (const child of children || []) {
    const rendered = await renderBlock(child, context, depth);
    if (rendered) chunks.push(rendered);
  }
  return chunks.join('\n\n').trim();
}

async function renderBlock(block, context, depth = 0) {
  const indent = '  '.repeat(depth);
  switch (block.type) {
    case 'paragraph':
      return normalizeParagraph(richTextToMarkdown(block.paragraph.rich_text, context));
    case 'heading_1':
      return `# ${richTextToMarkdown(block.heading_1.rich_text, context)}`;
    case 'heading_2':
      return `## ${richTextToMarkdown(block.heading_2.rich_text, context)}`;
    case 'heading_3':
      return `### ${richTextToMarkdown(block.heading_3.rich_text, context)}`;
    case 'quote':
      return prefixLines(richTextToMarkdown(block.quote.rich_text, context), '> ');
    case 'divider':
      return '---';
    case 'code': {
      const rawLanguage = block.code.language && block.code.language !== 'plain text' ? block.code.language : '';
      const language = /^[a-z0-9_+.-]+$/i.test(rawLanguage) ? rawLanguage : '';
      const code = plainTextFromRichText(block.code.rich_text);
      const fence = codeFence(code);
      return `${fence}${language}\n${code}\n${fence}`;
    }
    case 'callout': {
      const text = normalizeParagraph(richTextToMarkdown(block.callout.rich_text, context));
      return prefixLines(text || 'Callout', '> ');
    }
    case 'image': {
      const source = imageSourceFromBlock(block);
      const alt = escapeImageAlt(plainTextFromRichText(block.image.caption) || 'image');
      if (!source) return unsupportedBlockComment('image_missing_source', context);

      if (source.kind === 'notion-file') {
        const localPath = await downloadNotionImage(source.url, context.mediaStore);
        return `![${alt}](${markdownDestination(localPath)})`;
      }

      const safeUrl = sanitizeUrl(source.url, MEDIA_PROTOCOLS);
      if (!safeUrl) {
        incrementCounter(context.unsafeUrlCounts, 'image');
        return unsupportedBlockComment('image_unsafe_url', context);
      }
      return `![${alt}](${markdownDestination(safeUrl)})`;
    }
    case 'bookmark':
    case 'link_preview': {
      const url = block[block.type]?.url;
      const safeUrl = sanitizeUrl(url, LINK_PROTOCOLS);
      if (!safeUrl) {
        incrementCounter(context.unsafeUrlCounts, block.type);
        return unsupportedBlockComment(`${block.type}_unsafe_url`, context);
      }
      return `[${escapeMarkdownText(safeUrl)}](${markdownDestination(safeUrl)})`;
    }
    case 'bulleted_list_item': {
      const text = richTextToMarkdown(block.bulleted_list_item.rich_text, context) || ' ';
      const childText = await renderChildren(block.children, context, depth + 1);
      return [`${indent}- ${text}`, childText].filter(Boolean).join('\n');
    }
    case 'numbered_list_item': {
      const text = richTextToMarkdown(block.numbered_list_item.rich_text, context) || ' ';
      const childText = await renderChildren(block.children, context, depth + 1);
      return [`${indent}1. ${text}`, childText].filter(Boolean).join('\n');
    }
    case 'to_do': {
      const checked = block.to_do.checked ? 'x' : ' ';
      const text = richTextToMarkdown(block.to_do.rich_text, context) || ' ';
      const childText = await renderChildren(block.children, context, depth + 1);
      return [`${indent}- [${checked}] ${text}`, childText].filter(Boolean).join('\n');
    }
    case 'toggle': {
      const summary = richTextToMarkdown(block.toggle.rich_text, context) || '详情';
      const childText = await renderChildren(block.children, context, depth + 1);
      return [`**${summary}**`, childText].filter(Boolean).join('\n\n');
    }
    case 'equation': {
      const expression = escapeHtml(block.equation?.expression || '');
      if (!expression) return unsupportedBlockComment('equation_empty', context);
      return `$$\n${expression}\n$$`;
    }
    default: {
      const comment = unsupportedBlockComment(block.type || 'unknown', context);
      const childText = await renderChildren(block.children, context, depth + 1);
      return [comment, childText].filter(Boolean).join('\n\n');
    }
  }
}

async function materializeCover(coverSource, mediaStore) {
  if (!coverSource) return '';
  if (coverSource.kind === 'notion-file') {
    return downloadNotionImage(coverSource.url, mediaStore);
  }

  const safeUrl = sanitizeUrl(coverSource.url, MEDIA_PROTOCOLS);
  if (!safeUrl) throw new Error('cover URL does not use an allowed HTTP(S) protocol');
  return safeUrl;
}

async function buildArticle(client, article, context) {
  const [blocks, cover] = await Promise.all([
    fetchBlockChildren(client, article.notionId),
    materializeCover(article.coverSource, context.mediaStore),
  ]);
  const body = (await renderChildren(blocks, context)).trim();
  if (!body) throw new Error('article body is empty');
  const excerpt = article.excerpt || generateExcerptFromBody(body, { fallback: article.title });
  if (!article.excerpt) context.generatedExcerptCount += 1;
  const normalizedArticle = {
    ...article,
    excerpt,
    cover,
  };
  delete normalizedArticle.coverSource;
  const markdown = `${serializeFrontmatter(normalizedArticle)}${body}${body ? '\n' : ''}`;
  return {
    ...normalizedArticle,
    markdown,
    hash: sha256(markdown),
    path: `posts/${normalizedArticle.slug}.md`,
  };
}

async function buildSnapshot(client, articles, options = {}) {
  const context = {
    mediaStore: createMediaStore(),
    unsupportedCounts: new Map(),
    unsafeUrlCounts: new Map(),
    generatedExcerptCount: 0,
  };
  const builtArticles = [];
  const errors = [];

  for (const article of articles) {
    try {
      builtArticles.push(await buildArticle(client, article, context));
    } catch (error) {
      errors.push(`Page ${maskId(article.notionId)}: content export failed: ${error.message}`);
    }
  }

  builtArticles.sort((left, right) => right.date.localeCompare(left.date) || left.slug.localeCompare(right.slug));
  return { ...context, articles: builtArticles, errors };
}

function createManifest(snapshot) {
  const media = [...snapshot.mediaStore.files.values()]
    .map((file) => ({
      path: `media/${file.fileName}`,
      hash: file.hash,
      bytes: file.buffer.length,
      contentType: file.contentType,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    schemaVersion: 1,
    source: 'notion',
    generatedAt: new Date().toISOString(),
    count: snapshot.articles.length,
    mediaCount: media.length,
    articles: snapshot.articles.map((article) => ({
      id: article.notionId,
      notionId: article.notionId,
      slug: article.slug,
      aliases: article.aliases,
      hash: article.hash,
      updatedAt: article.updatedAt,
      path: article.path,
    })),
    media,
  };
}

function writeSnapshot(contentDir, snapshot, manifest) {
  const parentDir = path.dirname(contentDir);
  fs.mkdirSync(parentDir, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(parentDir, `.${path.basename(contentDir)}-stage-`));
  const backupDir = path.join(parentDir, `.${path.basename(contentDir)}-backup-${process.pid}-${Date.now()}`);
  let movedExisting = false;
  let promoted = false;

  try {
    const postsDir = path.join(stageDir, 'posts');
    const mediaDir = path.join(stageDir, 'media');
    fs.mkdirSync(postsDir, { recursive: true });
    fs.mkdirSync(mediaDir, { recursive: true });

    snapshot.articles.forEach((article) => {
      fs.writeFileSync(path.join(stageDir, article.path), article.markdown, 'utf8');
    });
    snapshot.mediaStore.files.forEach((file) => {
      fs.writeFileSync(path.join(mediaDir, file.fileName), file.buffer);
    });
    fs.writeFileSync(path.join(stageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    if (fs.existsSync(contentDir)) {
      fs.renameSync(contentDir, backupDir);
      movedExisting = true;
    }
    fs.renameSync(stageDir, contentDir);
    promoted = true;

    if (movedExisting) {
      try {
        fs.rmSync(backupDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`Snapshot published, but old snapshot cleanup failed: ${error.message}`);
      }
    }
  } catch (error) {
    if (!promoted && movedExisting && !fs.existsSync(contentDir) && fs.existsSync(backupDir)) {
      fs.renameSync(backupDir, contentDir);
    }
    throw error;
  } finally {
    if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function printCounterSummary(label, counter) {
  if (counter.size === 0) {
    console.log(`${label}: none`);
    return;
  }
  const summary = [...counter.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, count]) => `${key}=${count}`)
    .join(', ');
  console.log(`${label}: ${summary}`);
}

function throwCollectedErrors(label, errors) {
  if (errors.length === 0) return;
  throw new Error(`${label} (${errors.length}):\n${errors.map((error) => `- ${error}`).join('\n')}`);
}

async function main() {
  ensureEnv();
  const contentDir = resolveContentDir();
  console.log(`Starting stateless Notion snapshot${DRY_RUN ? ' (dry-run)' : ''}...`);
  console.log(`Content directory: ${contentDir}`);
  console.log(`Strict unsupported blocks: ${STRICT_UNSUPPORTED_BLOCKS ? 'enabled' : 'disabled'}`);

  const client = new Client({ auth: process.env.NOTION_TOKEN });
  const database = await client.databases.retrieve({ database_id: process.env.NOTION_DATABASE_ID });
  const databaseValidation = validateDatabaseSchema(database);
  databaseValidation.warnings.forEach((warning) => console.warn(`Schema warning: ${warning}`));
  throwCollectedErrors('Database schema validation failed', databaseValidation.errors);

  const pages = await fetchDatabasePages(client);
  if (pages.length === 0 && !ALLOW_EMPTY_SYNC) {
    throw new Error('No published Notion pages found. Set ALLOW_EMPTY_NOTION_SYNC=1 only for an intentional empty snapshot.');
  }

  const pageValidation = validatePublishedPages(pages);
  throwCollectedErrors('Published content validation failed', pageValidation.errors);
  console.log(`Published pages validated: ${pages.length}`);

  const snapshot = await buildSnapshot(client, pageValidation.articles);
  console.log(`Excerpts generated from article bodies: ${snapshot.generatedExcerptCount}`);
  printCounterSummary('Unsupported block summary', snapshot.unsupportedCounts);
  printCounterSummary('Blocked URL summary', snapshot.unsafeUrlCounts);
  if (STRICT_UNSUPPORTED_BLOCKS && snapshot.unsupportedCounts.size > 0) {
    snapshot.errors.push('Unsupported Notion blocks are present while STRICT_UNSUPPORTED_BLOCKS=1.');
  }
  throwCollectedErrors('Content snapshot generation failed', snapshot.errors);

  const manifest = createManifest(snapshot);
  if (DRY_RUN) {
    console.log(`Dry run complete. articles=${manifest.count} media=${manifest.mediaCount} writes=0`);
    return;
  }

  writeSnapshot(contentDir, snapshot, manifest);
  console.log(`Notion snapshot published. articles=${manifest.count} media=${manifest.mediaCount}`);
  console.log(`Manifest: ${path.join(contentDir, 'manifest.json')}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Notion sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildArticle,
  buildSnapshot,
  createManifest,
  fetchDatabasePages,
  generateExcerptFromBody,
  downloadNotionImage,
  escapeMarkdownText,
  markdownToPlainText,
  renderBlock,
  resolveContentDir,
  richTextToMarkdown,
  sanitizeUrl,
  serializeFrontmatter,
  writeSnapshot,
};
