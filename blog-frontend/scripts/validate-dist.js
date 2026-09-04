const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'site.config.json');

function parseOutput(argv) {
  if (argv.length === 0) return process.env.DIST_DIR || 'dist';
  if (argv.length === 2 && argv[0] === '--output') return argv[1];
  throw new Error('Usage: node scripts/validate-dist.js [--output <directory>]');
}

function walkFiles(directory, root = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(absolute, root);
    return [path.relative(root, absolute).split(path.sep).join('/')];
  });
}

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

function normalizeSiteUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) throw new Error('SITE_URL must not be empty');
  const parsed = new URL(text);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`SITE_URL must use http or https: ${value}`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

function belongsToSite(url, siteUrl) {
  return url === `${siteUrl}/` || url.startsWith(`${siteUrl}/`);
}

function matchesFor(value, pattern) {
  return [...value.matchAll(pattern)].map((match) => match[1]);
}

function localReferenceTarget(outputDir, htmlPath, reference) {
  const clean = reference.split('#')[0].split('?')[0];
  if (!clean || clean.startsWith('#')) return null;
  if (/^(?:https?:|mailto:|tel:|data:)/i.test(clean) || clean.startsWith('//')) return null;
  const decoded = decodeURIComponent(clean);
  const candidate = decoded.startsWith('/')
    ? path.resolve(outputDir, `.${decoded}`)
    : path.resolve(path.dirname(path.join(outputDir, htmlPath)), decoded);
  const normalizedOutput = `${path.resolve(outputDir)}${path.sep}`;
  if (candidate !== path.resolve(outputDir) && !candidate.startsWith(normalizedOutput)) {
    return { candidate, escapes: true };
  }
  return { candidate, escapes: false };
}

function existsAsPage(target) {
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return true;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    return fs.existsSync(path.join(target, 'index.html'));
  }
  if (target.endsWith(path.sep)) return fs.existsSync(path.join(target, 'index.html'));
  return false;
}

function main() {
  const outputArg = parseOutput(process.argv.slice(2));
  const outputDir = path.isAbsolute(outputArg) ? outputArg : path.resolve(ROOT_DIR, outputArg);
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const siteUrl = normalizeSiteUrl(process.env.SITE_URL || config.site.publicUrl);
  const errors = [];
  if (!fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) {
    throw new Error(`Output directory does not exist: ${outputDir}`);
  }

  const files = walkFiles(outputDir).sort();
  const fileSet = new Set(files);
  const required = [
    'index.html', 'about.html', 'post.html', '404.html', 'feed.xml', 'sitemap.xml', 'robots.txt',
    'posts.json', 'redirects.json', 'content-manifest.json', 'style.css', 'theme.js',
    'chrome/background.js', 'chrome/nav.js', 'chrome/init.js', 'runtime/page.js', 'runtime/legacy.js',
  ];
  required.forEach((name) => assert(fileSet.has(name), `Missing required output: ${name}`, errors));

  const forbiddenPatterns = [
    /(^|\/)node_modules\//,
    /(^|\/)\.env(?:\.|$)/,
    /(^|\/)package(?:-lock)?\.json$/,
    /(^|\/)scripts\//,
    /\.md$/,
  ];
  files.forEach((name) => {
    forbiddenPatterns.forEach((pattern) => {
      assert(!pattern.test(name), `Source/private file leaked into output: ${name}`, errors);
    });
  });

  const htmlFiles = files.filter((name) => name.endsWith('.html'));
  const canonicalByFile = new Map();
  htmlFiles.forEach((name) => {
    const html = fs.readFileSync(path.join(outputDir, name), 'utf8');
    assert(/<main(?:\s|>)/i.test(html), `Missing <main> landmark: ${name}`, errors);
    assert(/meta name="description"/i.test(html), `Missing meta description: ${name}`, errors);
    assert(/Content-Security-Policy/i.test(html), `Missing CSP: ${name}`, errors);
    assert(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), `Inline script found: ${name}`, errors);
    assert(!/<[^>]+\son[a-z]+\s*=/i.test(html), `Inline event handler found: ${name}`, errors);
    assert(!/(?:href|src)\s*=\s*["']\s*javascript:/i.test(html), `javascript: URL found: ${name}`, errors);

    const canonicals = matchesFor(html, /<link rel="canonical" href="([^"]+)">/gi);
    const openGraphUrls = matchesFor(html, /<meta property="og:url" content="([^"]+)">/gi);
    if (name === 'post.html') {
      assert(canonicals.length === 0, `Legacy page must not declare a canonical URL: ${name}`, errors);
      assert(openGraphUrls.length === 0, `Legacy page must not declare an og:url: ${name}`, errors);
    } else {
      assert(canonicals.length === 1, `Expected one canonical URL in ${name}, found ${canonicals.length}`, errors);
      assert(openGraphUrls.length === 1, `Expected one og:url in ${name}, found ${openGraphUrls.length}`, errors);
      if (canonicals.length === 1 && openGraphUrls.length === 1) {
        assert(canonicals[0] === openGraphUrls[0], `Canonical and og:url differ in ${name}`, errors);
        assert(belongsToSite(canonicals[0], siteUrl), `Canonical URL does not use SITE_URL in ${name}: ${canonicals[0]}`, errors);
        canonicalByFile.set(name, canonicals[0]);
      }
    }

    const references = [...html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
    references.forEach((reference) => {
      const target = localReferenceTarget(outputDir, name, reference);
      if (!target) return;
      assert(!target.escapes, `Reference escapes output in ${name}: ${reference}`, errors);
      if (!target.escapes) {
        assert(existsAsPage(target.candidate), `Broken local reference in ${name}: ${reference}`, errors);
      }
    });
  });

  if (fileSet.has('posts.json') && fileSet.has('content-manifest.json') && fileSet.has('redirects.json')) {
    const posts = JSON.parse(fs.readFileSync(path.join(outputDir, 'posts.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'content-manifest.json'), 'utf8'));
    const redirects = JSON.parse(fs.readFileSync(path.join(outputDir, 'redirects.json'), 'utf8'));
    assert(Array.isArray(posts), 'posts.json must contain an array', errors);
    assert(manifest.schemaVersion === 1, 'content-manifest.json schemaVersion must be 1', errors);
    assert(manifest.siteUrl === siteUrl, `Manifest siteUrl does not match SITE_URL: ${manifest.siteUrl}`, errors);
    assert(manifest.articleCount === posts.length, 'Manifest articleCount does not match posts.json', errors);
    assert(['fixtures', 'notion'].includes(manifest.source), `Unknown manifest source: ${manifest.source}`, errors);

    const slugs = new Set();
    const expectedHome = `${siteUrl}/`;
    assert(canonicalByFile.get('index.html') === expectedHome, `Home canonical URL must be ${expectedHome}`, errors);
    assert(canonicalByFile.get('about.html') === `${siteUrl}/about.html`, 'About canonical URL does not match SITE_URL', errors);
    assert(canonicalByFile.get('404.html') === `${siteUrl}/404.html`, '404 canonical URL does not match SITE_URL', errors);
    posts.forEach((post) => {
      assert(typeof post.slug === 'string' && post.slug.length > 0, 'Post is missing slug', errors);
      assert(!slugs.has(post.slug), `Duplicate post slug: ${post.slug}`, errors);
      slugs.add(post.slug);
      assert(fileSet.has(`posts/${post.slug}/index.html`), `Missing rendered article: ${post.slug}`, errors);
      assert(redirects.routes?.[post.slug] === `posts/${post.slug}/`, `Missing canonical redirect route: ${post.slug}`, errors);
      const canonical = `${siteUrl}/posts/${post.slug}/`;
      assert(canonicalByFile.get(`posts/${post.slug}/index.html`) === canonical, `Article canonical URL mismatch: ${post.slug}`, errors);
      (post.aliases || []).forEach((alias) => {
        assert(fileSet.has(`posts/${alias}/index.html`), `Missing alias redirect page: ${alias}`, errors);
        assert(redirects.routes?.[alias] === `posts/${post.slug}/`, `Alias route mismatch: ${alias}`, errors);
        assert(canonicalByFile.get(`posts/${alias}/index.html`) === canonical, `Alias canonical URL mismatch: ${alias}`, errors);
      });
    });
  }

  if (fileSet.has('feed.xml')) {
    const feed = fs.readFileSync(path.join(outputDir, 'feed.xml'), 'utf8');
    const links = matchesFor(feed, /<link>([^<]+)<\/link>/g);
    const guids = matchesFor(feed, /<guid>([^<]+)<\/guid>/g);
    assert(links[0] === `${siteUrl}/`, `Feed channel URL does not match SITE_URL: ${links[0]}`, errors);
    [...links, ...guids].forEach((url) => {
      assert(belongsToSite(url, siteUrl), `Feed URL does not use SITE_URL: ${url}`, errors);
    });
  }

  if (fileSet.has('sitemap.xml')) {
    const sitemap = fs.readFileSync(path.join(outputDir, 'sitemap.xml'), 'utf8');
    const locations = matchesFor(sitemap, /<loc>([^<]+)<\/loc>/g);
    assert(locations.length > 0, 'sitemap.xml must contain at least one URL', errors);
    assert(locations[0] === `${siteUrl}/`, `Sitemap home URL does not match SITE_URL: ${locations[0]}`, errors);
    locations.forEach((url) => {
      assert(belongsToSite(url, siteUrl), `Sitemap URL does not use SITE_URL: ${url}`, errors);
    });
  }

  if (fileSet.has('robots.txt')) {
    const robots = fs.readFileSync(path.join(outputDir, 'robots.txt'), 'utf8');
    assert(robots.includes(`Sitemap: ${siteUrl}/sitemap.xml`), 'robots.txt sitemap does not match SITE_URL', errors);
  }

  const mediaFiles = files.filter((name) => name.startsWith('media/'));
  mediaFiles.forEach((name) => {
    assert(/^media\/[a-f0-9]{64}\.[a-z0-9]+$/i.test(name), `Media is not content-addressed: ${name}`, errors);
  });

  if (errors.length > 0) {
    console.error(`Output validation failed with ${errors.length} error(s):`);
    errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
    return;
  }

  console.log(`Output validation passed: ${outputDir}`);
  console.log(`Canonical SITE_URL: ${siteUrl}`);
  console.log(`Validated ${files.length} files, ${htmlFiles.length} HTML pages, ${mediaFiles.length} media files.`);
}

try {
  main();
} catch (error) {
  console.error(`[validate] ${error.message}`);
  process.exitCode = 1;
}
