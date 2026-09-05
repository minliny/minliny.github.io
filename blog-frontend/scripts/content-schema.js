'use strict';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const PROPERTY_SCHEMA = Object.freeze({
  '名称': Object.freeze({ required: true, types: Object.freeze(['title']) }),
  Slug: Object.freeze({ required: false, types: Object.freeze(['rich_text']) }),
  Status: Object.freeze({ required: true, types: Object.freeze(['select']) }),
  Excerpt: Object.freeze({ required: false, types: Object.freeze(['rich_text']) }),
  Group: Object.freeze({ required: false, types: Object.freeze(['select']) }),
  Tags: Object.freeze({ required: false, types: Object.freeze(['multi_select']) }),
  Cover: Object.freeze({ required: false, types: Object.freeze(['url', 'files']) }),
  Aliases: Object.freeze({ required: false, types: Object.freeze(['multi_select', 'rich_text']) }),
});

function maskId(value) {
  const text = String(value || '').replace(/-/g, '');
  if (!text) return '<missing>';
  if (text.length <= 10) return '<set>';
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function getPlainText(richText) {
  return (richText || []).map((part) => part.plain_text || '').join('').trim();
}

function formatDate(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  const stringValue = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(stringValue)) {
    const exactDate = new Date(`${stringValue}T00:00:00.000Z`);
    if (!Number.isNaN(exactDate.getTime()) && exactDate.toISOString().slice(0, 10) === stringValue) {
      return stringValue;
    }
    throw new Error(`invalid date value "${stringValue}"`);
  }

  const parsed = new Date(stringValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid date value "${stringValue}"`);
  }
  return parsed.toISOString().slice(0, 10);
}

function describeExpectedTypes(types) {
  return types.map((type) => `"${type}"`).join(' or ');
}

function validateDatabaseSchema(database) {
  const properties = database?.properties || {};
  const errors = [];
  const warnings = [];

  Object.entries(PROPERTY_SCHEMA).forEach(([name, definition]) => {
    const property = properties[name];
    if (!property) {
      if (definition.required) errors.push(`Missing required database property "${name}".`);
      return;
    }
    if (!definition.types.includes(property.type)) {
      errors.push(
        `Database property "${name}" must be ${describeExpectedTypes(definition.types)}, received "${property.type}".`
      );
    }
  });

  const statusProperty = properties.Status;
  if (statusProperty?.type === 'select') {
    const statuses = new Set((statusProperty.select?.options || []).map((option) => option.name));
    if (!statuses.has('Draft')) {
      errors.push('Database property "Status" must define a "Draft" select option for the default authoring template.');
    }
    if (!statuses.has('Published')) {
      errors.push('Database property "Status" must define a "Published" select option.');
    }
  }

  return { errors, warnings };
}

function validatePropertyType(properties, name, definition, context, errors) {
  const property = properties[name];
  if (!property) {
    if (definition.required) errors.push(`${context}: missing required property "${name}".`);
    return undefined;
  }
  if (!definition.types.includes(property.type)) {
    errors.push(
      `${context}: property "${name}" must be ${describeExpectedTypes(definition.types)}, received "${property.type}".`
    );
    return undefined;
  }
  return property;
}

function extractAliases(property) {
  if (!property) return [];
  if (property.type === 'multi_select') {
    return (property.multi_select || []).map((item) => String(item.name || '').trim()).filter(Boolean);
  }
  if (property.type === 'rich_text') {
    return getPlainText(property.rich_text)
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function extractCover(page, property) {
  if (property?.type === 'url' && property.url) {
    return { kind: 'external', url: property.url };
  }

  if (property?.type === 'files') {
    const firstFile = property.files?.[0];
    if (firstFile?.type === 'external' && firstFile.external?.url) {
      return { kind: 'external', url: firstFile.external.url };
    }
    if (firstFile?.type === 'file' && firstFile.file?.url) {
      return { kind: 'notion-file', url: firstFile.file.url };
    }
  }

  if (page?.cover?.type === 'external' && page.cover.external?.url) {
    return { kind: 'external', url: page.cover.external.url };
  }
  if (page?.cover?.type === 'file' && page.cover.file?.url) {
    return { kind: 'notion-file', url: page.cover.file.url };
  }

  return null;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function automaticSlug(pageId) {
  const compactId = String(pageId || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  return compactId ? `post-${compactId.slice(0, 12)}` : '';
}

function extractPublishedPage(page) {
  const context = `Page ${maskId(page?.id)}`;
  const properties = page?.properties || {};
  const errors = [];
  const validProperties = {};

  Object.entries(PROPERTY_SCHEMA).forEach(([name, definition]) => {
    validProperties[name] = validatePropertyType(properties, name, definition, context, errors);
  });

  const title = getPlainText(validProperties['名称']?.title);
  const configuredSlug = getPlainText(validProperties.Slug?.rich_text);
  const slug = configuredSlug || automaticSlug(page?.id);
  const status = validProperties.Status?.select?.name || '';
  const rawDate = page?.created_time || '';
  const excerpt = getPlainText(validProperties.Excerpt?.rich_text);
  const group = String(validProperties.Group?.select?.name || '').trim();
  const tags = uniqueStrings((validProperties.Tags?.multi_select || []).map((item) => item.name));
  const aliases = uniqueStrings(extractAliases(validProperties.Aliases)).filter((alias) => alias !== slug);
  const updatedAt = String(page?.last_edited_time || '');
  let date = '';

  if (!title) errors.push(`${context}: "名称" must not be empty.`);
  if (!slug) {
    errors.push(`${context}: cannot generate a Slug without a valid page ID.`);
  } else if (!SLUG_PATTERN.test(slug)) {
    errors.push(`${context}: invalid Slug "${slug}"; use lowercase letters, numbers, and hyphens only.`);
  }
  if (status !== 'Published') {
    errors.push(`${context}: "Status" must be "Published" for a published snapshot.`);
  }
  if (!rawDate) {
    errors.push(`${context}: cannot generate a Date without page created_time.`);
  } else {
    try {
      date = formatDate(rawDate);
    } catch (error) {
      errors.push(`${context}: ${error.message}.`);
    }
  }
  aliases.forEach((alias) => {
    if (!SLUG_PATTERN.test(alias)) {
      errors.push(`${context}: invalid alias "${alias}"; use lowercase letters, numbers, and hyphens only.`);
    }
  });
  if (!updatedAt || Number.isNaN(new Date(updatedAt).getTime())) {
    errors.push(`${context}: page last_edited_time must be a valid timestamp.`);
  }

  const article = {
    notionId: String(page?.id || ''),
    title,
    slug,
    date,
    excerpt,
    group,
    tags,
    aliases,
    coverSource: extractCover(page, validProperties.Cover),
    updatedAt,
  };

  return { article, errors };
}

function validatePublishedPages(pages) {
  const errors = [];
  const articles = [];

  (pages || []).forEach((page) => {
    const result = extractPublishedPage(page);
    errors.push(...result.errors);
    articles.push(result.article);
  });

  const routeOwners = new Map();
  articles.forEach((article) => {
    if (!article.slug) return;
    const routes = [article.slug, ...article.aliases];
    routes.forEach((route) => {
      if (!SLUG_PATTERN.test(route)) return;
      const owners = routeOwners.get(route) || [];
      owners.push(article.notionId);
      routeOwners.set(route, owners);
    });
  });

  routeOwners.forEach((owners, route) => {
    const uniqueOwners = [...new Set(owners)];
    if (uniqueOwners.length > 1) {
      errors.push(
        `Route "${route}" is claimed by multiple published pages: ${uniqueOwners.map(maskId).join(', ')}.`
      );
    }
  });

  return { articles, errors };
}

module.exports = {
  PROPERTY_SCHEMA,
  SLUG_PATTERN,
  automaticSlug,
  extractPublishedPage,
  formatDate,
  getPlainText,
  maskId,
  validateDatabaseSchema,
  validatePublishedPages,
};
