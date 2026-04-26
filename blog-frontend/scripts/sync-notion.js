const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const dotenv = require('dotenv');
const { Client } = require('@notionhq/client');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const ROOT_DIR = path.resolve(__dirname, '..');
const POSTS_DIR = path.join(ROOT_DIR, 'posts');
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_ENV = ['NOTION_TOKEN', 'NOTION_DATABASE_ID', 'SITE_URL'];
const REQUIRED_PROPERTIES = {
  '名称': 'title',
  Slug: 'rich_text',
  Status: 'select',
  Date: 'date',
  Excerpt: 'rich_text',
  Group: 'select',
};

const DRY_RUN = process.argv.includes('--dry-run');
const ALLOW_EMPTY_SYNC = process.env.ALLOW_EMPTY_NOTION_SYNC === '1';
const DELETE_NOTION_MANAGED = process.env.DISABLE_NOTION_SYNC_DELETE !== '1';
const UNSUPPORTED_FALLBACK_TYPES = new Set([
  'table',
  'table_row',
  'column_list',
  'column',
  'synced_block',
  'equation',
  'embed',
  'pdf',
  'file',
  'audio',
  'video',
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function ensureEnv() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    fail(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function formatDate(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const stringValue = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(stringValue)) {
    return stringValue;
  }

  const parsed = new Date(stringValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date value: ${value}`);
  }

  return parsed.toISOString().slice(0, 10);
}

function validateSlug(slug, pageId, title) {
  if (!slug) {
    throw new Error(`Missing slug for page ${pageId} (${title})`);
  }

  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid slug "${slug}" for page ${pageId} (${title}). Slugs must use lowercase letters, numbers, and hyphens only.`
    );
  }
}

function escapeYamlString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function serializeFrontmatter(data) {
  const lines = [
    '---',
    `title: "${escapeYamlString(data.title)}"`,
    `date: "${escapeYamlString(data.date)}"`,
    `excerpt: "${escapeYamlString(data.excerpt)}"`,
    `group: "${escapeYamlString(data.group)}"`,
  ];

  if (data.tags.length === 0) {
    lines.push('tags: []');
  } else {
    lines.push('tags:');
    data.tags.forEach((tag) => {
      lines.push(`  - "${escapeYamlString(tag)}"`);
    });
  }

  lines.push(`notionId: "${escapeYamlString(data.notionId)}"`);
  if (data.cover) {
    lines.push(`cover: "${escapeYamlString(data.cover)}"`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function getPlainTextFromRichText(richText) {
  return (richText || []).map((part) => part.plain_text || '').join('').trim();
}

function richTextToMarkdown(richText) {
  return (richText || [])
    .map((item) => {
      let text = item.plain_text || '';
      const href = item.href || item.text?.link?.url;

      if (!text) return '';
      if (item.annotations?.code) text = `\`${text}\``;
      if (item.annotations?.bold) text = `**${text}**`;
      if (item.annotations?.italic) text = `*${text}*`;
      if (item.annotations?.strikethrough) text = `~~${text}~~`;
      if (href) text = `[${text}](${href})`;

      return text;
    })
    .join('');
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
      select: {
        equals: 'Published',
      },
    },
    sorts: [
      {
        property: 'Date',
        direction: 'descending',
      },
    ],
    start_cursor,
  }));
}

async function fetchBlockChildren(client, blockId) {
  const children = await listAllResults((start_cursor) => client.blocks.children.list({
    block_id: blockId,
    start_cursor,
  }));

  const nested = [];
  for (const child of children) {
    if (child.has_children) {
      child.children = await fetchBlockChildren(client, child.id);
    }
    nested.push(child);
  }

  return nested;
}

function getProperty(properties, name, expectedType, pageId) {
  const property = properties[name];
  if (!property) {
    throw new Error(`Missing property "${name}" on page ${pageId}`);
  }

  if (property.type !== expectedType) {
    throw new Error(`Property "${name}" on page ${pageId} must be type "${expectedType}", received "${property.type}"`);
  }

  return property;
}

function extractPageMeta(page) {
  const properties = page.properties;

  Object.entries(REQUIRED_PROPERTIES).forEach(([name, expectedType]) => {
    getProperty(properties, name, expectedType, page.id);
  });

  const title = getPlainTextFromRichText(properties['名称'].title);
  const slug = getPlainTextFromRichText(properties.Slug.rich_text);
  const date = properties.Date.date?.start;
  const excerpt = getPlainTextFromRichText(properties.Excerpt.rich_text);
  const group = properties.Group.select?.name || '';
  const tags = properties.Tags && properties.Tags.type === 'multi_select'
    ? properties.Tags.multi_select.map((item) => item.name)
    : [];
  let cover = '';

  if (properties.Cover?.type === 'url') {
    cover = properties.Cover.url || '';
  } else if (properties.Cover?.type === 'files') {
    const firstFile = properties.Cover.files?.[0];
    if (firstFile?.type === 'external') {
      cover = firstFile.external.url || '';
    } else if (firstFile?.type === 'file') {
      cover = firstFile.file.url || '';
    }
  }

  if (!title || !slug || !date || !excerpt || !group) {
    throw new Error(`Page ${page.id} is missing one of the required values: title, slug, date, excerpt, group`);
  }

  validateSlug(slug, page.id, title);

  return {
    notionId: page.id,
    title,
    slug,
    date: formatDate(date),
    excerpt,
    group,
    tags,
    cover,
  };
}

function normalizeParagraph(text) {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function imageUrlFromBlock(block) {
  if (block.type !== 'image') return '';
  if (block.image.type === 'external') return block.image.external.url;
  if (block.image.type === 'file') return block.image.file.url;
  return '';
}

function recordUnsupported(unsupportedCounts, type) {
  unsupportedCounts.set(type, (unsupportedCounts.get(type) || 0) + 1);
}

function unsupportedBlockComment(type, unsupportedCounts) {
  recordUnsupported(unsupportedCounts, type);
  return `<!-- unsupported notion block: ${type} -->`;
}

function renderChildren(children, context, depth = 0) {
  const chunks = [];

  children.forEach((child) => {
    const rendered = renderBlock(child, context, depth);
    if (rendered) chunks.push(rendered);
  });

  return chunks.join('\n\n').trim();
}

function renderBlock(block, context, depth = 0) {
  const indent = '  '.repeat(depth);

  switch (block.type) {
    case 'paragraph':
      return normalizeParagraph(richTextToMarkdown(block.paragraph.rich_text));
    case 'heading_1':
      return `# ${richTextToMarkdown(block.heading_1.rich_text)}`;
    case 'heading_2':
      return `## ${richTextToMarkdown(block.heading_2.rich_text)}`;
    case 'heading_3':
      return `### ${richTextToMarkdown(block.heading_3.rich_text)}`;
    case 'quote':
      return `> ${richTextToMarkdown(block.quote.rich_text)}`;
    case 'divider':
      return '---';
    case 'code': {
      const language = block.code.language && block.code.language !== 'plain text'
        ? block.code.language
        : '';
      return `\`\`\`${language}\n${richTextToMarkdown(block.code.rich_text)}\n\`\`\``;
    }
    case 'callout': {
      const calloutText = normalizeParagraph(richTextToMarkdown(block.callout.rich_text));
      return `> ${calloutText || 'Callout'}`;
    }
    case 'image': {
      const alt = richTextToMarkdown(block.image.caption) || 'image';
      const url = imageUrlFromBlock(block);
      return url ? `![${alt}](${url})` : unsupportedBlockComment('image', context.unsupportedCounts);
    }
    case 'bookmark':
      return block.bookmark.url ? `[${block.bookmark.url}](${block.bookmark.url})` : unsupportedBlockComment('bookmark', context.unsupportedCounts);
    case 'link_preview':
      return block.link_preview.url ? `[${block.link_preview.url}](${block.link_preview.url})` : unsupportedBlockComment('link_preview', context.unsupportedCounts);
    case 'bulleted_list_item': {
      const text = richTextToMarkdown(block.bulleted_list_item.rich_text) || ' ';
      const childText = renderChildren(block.children || [], context, depth + 1);
      return [`${indent}- ${text}`, childText].filter(Boolean).join('\n');
    }
    case 'numbered_list_item': {
      const text = richTextToMarkdown(block.numbered_list_item.rich_text) || ' ';
      const childText = renderChildren(block.children || [], context, depth + 1);
      return [`${indent}1. ${text}`, childText].filter(Boolean).join('\n');
    }
    case 'toggle': {
      const summary = richTextToMarkdown(block.toggle.rich_text) || '详情';
      const childText = renderChildren(block.children || [], context, depth + 1);
      if (!childText) {
        return `<details>\n<summary>${summary}</summary>\n</details>`;
      }
      return `<details>\n<summary>${summary}</summary>\n\n${childText}\n</details>`;
    }
    case 'equation':
      if (block.equation?.expression) {
        return `$$\n${block.equation.expression}\n$$`;
      }
      return unsupportedBlockComment('equation', context.unsupportedCounts);
    case 'table':
    case 'table_row':
    case 'column_list':
    case 'column':
    case 'synced_block':
    case 'embed':
    case 'pdf':
    case 'file':
    case 'audio':
    case 'video': {
      const comment = unsupportedBlockComment(block.type, context.unsupportedCounts);
      const childText = renderChildren(block.children || [], context, depth + 1);
      return [comment, childText].filter(Boolean).join('\n');
    }
    default: {
      if (UNSUPPORTED_FALLBACK_TYPES.has(block.type)) {
        const comment = unsupportedBlockComment(block.type, context.unsupportedCounts);
        const childText = renderChildren(block.children || [], context, depth + 1);
        return [comment, childText].filter(Boolean).join('\n');
      }
      return unsupportedBlockComment(block.type, context.unsupportedCounts);
    }
  }
}

function buildMarkdown(meta, blocks, context) {
  const body = renderChildren(blocks, context).trim();
  const frontmatter = serializeFrontmatter(meta);
  return `${frontmatter}${body}${body ? '\n' : ''}`;
}

function readLocalPostFiles() {
  return fs.readdirSync(POSTS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const filePath = path.join(POSTS_DIR, name);
      const parsed = matter(fs.readFileSync(filePath, 'utf8'));
      return {
        name,
        slug: name.replace(/\.md$/, ''),
        filePath,
        notionId: parsed.data.notionId ? String(parsed.data.notionId) : '',
        frontmatter: parsed.data,
      };
    });
}

function buildLocalNotionMap(localPosts) {
  const notionMap = new Map();

  localPosts.forEach((post) => {
    if (!post.notionId) return;

    if (notionMap.has(post.notionId)) {
      const existing = notionMap.get(post.notionId);
      throw new Error(
        `Invalid local state: notionId=${post.notionId} appears in both "${existing.name}" and "${post.name}".`
      );
    }

    notionMap.set(post.notionId, post);
  });

  return notionMap;
}

function detectRemoteSlugConflicts(metas) {
  const bySlug = new Map();

  metas.forEach((meta) => {
    const list = bySlug.get(meta.slug) || [];
    list.push(meta);
    bySlug.set(meta.slug, list);
  });

  const conflicts = [];
  bySlug.forEach((entries, slug) => {
    if (entries.length > 1) {
      conflicts.push({ slug, entries });
    }
  });

  return conflicts;
}

function describeRemoteSlugConflicts(conflicts) {
  return conflicts.map((conflict) => {
    const details = conflict.entries
      .map((entry) => `title="${entry.title}", notionId=${entry.notionId}`)
      .join(' | ');
    return `Slug conflict "${conflict.slug}": ${details}`;
  });
}

function planWriteOperations(metas, localPosts) {
  const localByFileName = new Map(localPosts.map((post) => [post.name, post]));
  const errors = [];
  const operations = [];

  metas.forEach((meta) => {
    const fileName = `${meta.slug}.md`;
    const existing = localByFileName.get(fileName);

    if (!existing) {
      operations.push({
        type: 'create',
        slug: meta.slug,
        notionId: meta.notionId,
        filePath: path.join(POSTS_DIR, fileName),
        meta,
      });
      return;
    }

    if (!existing.notionId) {
      errors.push(`Refusing to overwrite local manual post "${fileName}" because it has no notionId.`);
      return;
    }

    if (existing.notionId !== meta.notionId) {
      errors.push(
        `Slug conflict for "${meta.slug}": local file "${fileName}" is bound to notionId=${existing.notionId}, current page notionId=${meta.notionId}.`
      );
      return;
    }

    operations.push({
      type: 'update',
      slug: meta.slug,
      notionId: meta.notionId,
      filePath: existing.filePath,
      meta,
    });
  });

  return { operations, errors };
}

function planRenameOperations(metas, localPosts) {
  const localByNotionId = buildLocalNotionMap(localPosts);
  const localByFileName = new Map(localPosts.map((post) => [post.name, post]));
  const operations = [];

  metas.forEach((meta) => {
    const localPost = localByNotionId.get(meta.notionId);
    if (!localPost) return;
    if (localPost.slug === meta.slug) return;

    const targetName = `${meta.slug}.md`;
    const targetPath = path.join(POSTS_DIR, targetName);
    const existingTarget = localByFileName.get(targetName);

    if (existingTarget && existingTarget.notionId !== meta.notionId) {
      const label = existingTarget.notionId
        ? `notionId=${existingTarget.notionId}`
        : 'manual post';
      throw new Error(
        `Cannot rename "${localPost.name}" to "${targetName}" because target already exists (${label}).`
      );
    }

    operations.push({
      type: 'rename',
      notionId: meta.notionId,
      oldSlug: localPost.slug,
      newSlug: meta.slug,
      oldFilePath: localPost.filePath,
      newFilePath: targetPath,
      oldName: localPost.name,
      newName: targetName,
    });
  });

  return operations;
}

function applyRenamePlanToLocalPosts(localPosts, renameOperations) {
  const renamedByNotionId = new Map(renameOperations.map((operation) => [operation.notionId, operation]));

  return localPosts.map((post) => {
    const rename = renamedByNotionId.get(post.notionId);
    if (!rename) return post;

    return {
      ...post,
      name: rename.newName,
      slug: rename.newSlug,
      filePath: rename.newFilePath,
    };
  });
}

function planDeleteOperations(localPosts, publishedNotionIds) {
  return localPosts
    .filter((post) => post.notionId && !publishedNotionIds.has(post.notionId))
    .map((post) => ({
      type: 'delete',
      slug: post.slug,
      notionId: post.notionId,
      filePath: post.filePath,
    }));
}

function printUnsupportedSummary(unsupportedCounts) {
  if (unsupportedCounts.size === 0) {
    console.log('Unsupported block summary: none');
    return;
  }

  console.log('Unsupported block summary:');
  Array.from(unsupportedCounts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([type, count]) => {
      console.log(`- ${type}: ${count}`);
    });
}

async function buildWritePayloads(client, operations, unsupportedCounts) {
  const payloads = [];

  for (const operation of operations) {
    const blocks = await fetchBlockChildren(client, operation.notionId);
    const markdown = buildMarkdown(operation.meta, blocks, { unsupportedCounts });
    payloads.push({ ...operation, markdown });
  }

  return payloads;
}

function executeOperations(renameOperations, writeOperations, deleteOperations) {
  const stats = {
    renamed: 0,
    created: 0,
    updated: 0,
    deleted: 0,
  };

  renameOperations.forEach((operation) => {
    stats.renamed += 1;

    if (DRY_RUN) {
      console.log(`[dry-run] rename: ${operation.oldName} → ${operation.newName}`);
      return;
    }

    fs.renameSync(operation.oldFilePath, operation.newFilePath);
    console.log(`Renamed: ${operation.oldName} → ${operation.newName}`);
  });

  writeOperations.forEach((operation) => {
    if (operation.type === 'create') stats.created += 1;
    if (operation.type === 'update') stats.updated += 1;

    if (DRY_RUN) {
      console.log(`[dry-run] ${operation.type}: ${path.basename(operation.filePath)}`);
      return;
    }

    fs.writeFileSync(operation.filePath, operation.markdown, 'utf8');
    console.log(`${operation.type === 'create' ? 'Created' : 'Updated'}: ${path.basename(operation.filePath)}`);
  });

  deleteOperations.forEach((operation) => {
    stats.deleted += 1;

    if (DRY_RUN) {
      console.log(`[dry-run] delete: ${path.basename(operation.filePath)}`);
      return;
    }

    fs.unlinkSync(operation.filePath);
    console.log(`Deleted: ${path.basename(operation.filePath)}`);
  });

  return stats;
}

async function main() {
  ensureEnv();

  console.log(`Starting Notion sync${DRY_RUN ? ' (dry-run)' : ''}...`);
  console.log(`Delete sync: ${DELETE_NOTION_MANAGED ? 'enabled' : 'disabled'}`);

  const client = new Client({ auth: process.env.NOTION_TOKEN });
  const pages = await fetchDatabasePages(client);

  if (pages.length === 0 && !ALLOW_EMPTY_SYNC) {
    fail('No published Notion pages found. Abort to protect local posts.');
  }

  const metas = pages.map(extractPageMeta);
  const remoteConflicts = detectRemoteSlugConflicts(metas);
  if (remoteConflicts.length > 0) {
    fail(describeRemoteSlugConflicts(remoteConflicts).join('\n'));
  }

  const localPosts = readLocalPostFiles();
  const plannedRenames = planRenameOperations(metas, localPosts);
  const localPostsAfterRename = applyRenamePlanToLocalPosts(localPosts, plannedRenames);
  const { operations: plannedWrites, errors: planningErrors } = planWriteOperations(metas, localPostsAfterRename);
  if (planningErrors.length > 0) {
    fail(planningErrors.join('\n'));
  }

  const publishedNotionIds = new Set(metas.map((meta) => meta.notionId));
  const plannedDeletes = DELETE_NOTION_MANAGED
    ? planDeleteOperations(localPostsAfterRename, publishedNotionIds)
    : [];

  console.log(`Published pages: ${metas.length}`);
  console.log(`Planned renames: ${plannedRenames.length}`);
  console.log(`Planned writes: ${plannedWrites.length}`);
  console.log(`Planned deletes: ${plannedDeletes.length}`);

  if (plannedRenames.length > 0) {
    console.log('Rename candidates:');
    plannedRenames.forEach((operation) => {
      console.log(`- ${operation.oldName} → ${operation.newName}`);
    });
  }

  if (plannedDeletes.length > 0) {
    console.log('Delete candidates:');
    plannedDeletes.forEach((operation) => {
      console.log(`- ${path.basename(operation.filePath)} (notionId=${operation.notionId})`);
    });
  }

  const unsupportedCounts = new Map();
  const writeOperations = await buildWritePayloads(client, plannedWrites, unsupportedCounts);
  const stats = executeOperations(plannedRenames, writeOperations, plannedDeletes);

  console.log(
    `Sync complete${DRY_RUN ? ' (dry-run)' : ''}. renamed=${stats.renamed} created=${stats.created} updated=${stats.updated} deleted=${stats.deleted} dryRun=${DRY_RUN ? 1 : 0}`
  );
  if (plannedRenames.length > 0) {
    console.log(`renamed: ${plannedRenames.length}`);
    plannedRenames.forEach((operation) => {
      console.log(`- ${operation.oldName} → ${operation.newName}`);
    });
  } else {
    console.log('renamed: 0');
  }
  printUnsupportedSummary(unsupportedCounts);
}

main().catch((error) => {
  console.error(`Notion sync failed: ${error.message}`);
  process.exit(1);
});
