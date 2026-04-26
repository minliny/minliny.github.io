const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const ROOT_DIR = path.resolve(__dirname, '..');
const POSTS_DIR = path.join(ROOT_DIR, 'posts');
const OUTPUT_PATH = path.join(ROOT_DIR, 'posts.json');
const REQUIRED_FIELDS = ['title', 'date', 'excerpt', 'group'];

function assertField(data, fieldName, filePath) {
  if (!data[fieldName]) {
    throw new Error(`Missing required frontmatter "${fieldName}" in ${filePath}`);
  }
}

function normalizeDateValue(value, filePath) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const stringValue = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(stringValue)) {
    return stringValue;
  }

  const parsed = new Date(stringValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date in ${filePath}: ${value}`);
  }

  return parsed.toISOString().slice(0, 10);
}

function main() {
  const entries = fs.readdirSync(POSTS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort();

  const posts = entries.map((entry) => {
    const slug = entry.replace(/\.md$/, '');
    const filePath = path.join(POSTS_DIR, entry);
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = matter(raw);

    REQUIRED_FIELDS.forEach((fieldName) => assertField(parsed.data, fieldName, filePath));

    return {
      slug,
      title: parsed.data.title,
      date: normalizeDateValue(parsed.data.date, filePath),
      excerpt: parsed.data.excerpt,
      group: parsed.data.group,
      tags: Array.isArray(parsed.data.tags) ? parsed.data.tags : [],
      path: `posts/${entry}`,
    };
  }).sort((a, b) => new Date(b.date) - new Date(a.date));

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(posts, null, 2)}\n`, 'utf8');
  console.log(`posts.json generated: ${OUTPUT_PATH}`);
}

main();
