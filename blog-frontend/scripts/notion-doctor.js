'use strict';

const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('@notionhq/client');
const {
  PROPERTY_SCHEMA,
  maskId,
  validateDatabaseSchema,
  validatePublishedPages,
} = require('./content-schema');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function describeProperty(property) {
  if (!property) return 'missing';
  return property.type || 'unknown';
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

function printCollectedErrors(errors) {
  if (errors.length === 0) return;
  console.error(`Validation errors (${errors.length}):`);
  errors.forEach((error) => console.error(`- ${error}`));
}

async function main() {
  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;

  console.log('Notion doctor starting...');
  console.log(`NOTION_TOKEN: ${token ? '<set>' : '<missing>'}`);
  console.log(`NOTION_DATABASE_ID: ${maskId(databaseId)}`);

  if (!token || !databaseId) {
    throw new Error('Missing NOTION_TOKEN or NOTION_DATABASE_ID.');
  }

  const client = new Client({ auth: token });
  const database = await client.databases.retrieve({ database_id: databaseId });
  const schemaValidation = validateDatabaseSchema(database);

  console.log('Content schema:');
  Object.entries(PROPERTY_SCHEMA).forEach(([name, definition]) => {
    const property = database.properties?.[name];
    const required = definition.required ? 'required' : 'optional';
    const status = (!property && !definition.required) || (property && definition.types.includes(property.type))
      ? 'ok'
      : 'invalid';
    console.log(`- ${name}: ${describeProperty(property)} (${required}, ${status})`);
  });
  schemaValidation.warnings.forEach((warning) => console.warn(`Schema warning: ${warning}`));

  // Query once, then derive aggregate counts locally. Draft metadata is never printed.
  const allPages = await listAllResults((start_cursor) => client.databases.query({
    database_id: databaseId,
    start_cursor,
    page_size: 100,
  }));
  const publishedPages = allPages.filter(
    (page) => page.properties?.Status?.type === 'select'
      && page.properties.Status.select?.name === 'Published'
  );

  console.log(`Total pages visible to integration: ${allPages.length}`);
  console.log(`Published pages: ${publishedPages.length}`);
  console.log(`Non-published pages: ${allPages.length - publishedPages.length}`);

  const contentValidation = validatePublishedPages(publishedPages);
  const errors = [...schemaValidation.errors, ...contentValidation.errors];
  if (publishedPages.length === 0 && process.env.ALLOW_EMPTY_NOTION_SYNC !== '1') {
    errors.push('No published pages found; the production sync would refuse an empty snapshot.');
  }

  printCollectedErrors(errors);
  if (errors.length > 0) {
    throw new Error(`content contract validation failed with ${errors.length} error(s)`);
  }

  console.log('Published metadata validation: ok');
  console.log('Notion doctor complete.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Notion doctor failed: ${error.body || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
