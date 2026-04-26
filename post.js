/* ==========================================
   Theme Management (mirrors app.js)
   day       = 日间墨竹
   night     = 夜间墨竹
   day-pure  = 日间普通
   night-pure= 夜间普通
========================================== */

const THEME_KEY = 'xiaogai-theme';
const hljsTheme = document.getElementById('hljs-theme');

const HLJS_DARK  = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css';
const HLJS_LIGHT = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';

const VALID_THEMES = new Set(['day', 'night', 'day-pure', 'night-pure']);
const LIGHT_MODES = new Set(['day', 'day-pure']);

function normalizeTheme(mode) {
  return VALID_THEMES.has(mode) ? mode : 'day';
}

function applyTheme(mode) {
  const theme = normalizeTheme(mode);
  document.body.classList.remove('day', 'night', 'day-pure', 'night-pure');
  document.body.classList.add(theme);

  // highlight.js follows light/dark theme family
  hljsTheme.href = LIGHT_MODES.has(theme) ? HLJS_LIGHT : HLJS_DARK;

  localStorage.setItem(THEME_KEY, theme);

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.mode === theme);
  });
}

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    applyTheme(btn.dataset.mode);
    // Re-highlight after theme swap
    document.querySelectorAll('.post-content pre code').forEach(block => {
      hljs.highlightElement(block);
    });
    // 竹叶点击弹跳动画
    btn.classList.remove('leaf-spring');
    void btn.offsetWidth;
    btn.classList.add('leaf-spring');
  });
  btn.addEventListener('animationend', (e) => {
    if (e.animationName === 'leafSpring') btn.classList.remove('leaf-spring');
  });
});

const savedTheme = normalizeTheme(localStorage.getItem(THEME_KEY) || 'day');
  applyTheme(savedTheme);

/* ==========================================
   Markdown Renderer Setup
========================================== */

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function setupMarked() {
  // Use a custom renderer so code blocks get hljs classes
  const renderer = new marked.Renderer();

  renderer.code = function(code, lang) {
    const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
    const highlighted = hljs.highlight(
      typeof code === 'object' ? code.text : code,
      { language }
    ).value;
    const rawCode = typeof code === 'object' ? code.text : code;
    return `
      <div class="code-block">
        <button class="copy-btn" type="button" aria-label="复制代码">Copy</button>
        <pre><code class="hljs language-${language}" data-raw="${escapeAttribute(rawCode)}">${highlighted}</code></pre>
      </div>
    `;
  };

  marked.use({
    renderer,
    gfm: true,
    breaks: false,
    pedantic: false,
  });
}

/* ==========================================
   Copy Button
========================================== */

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function setupCopyButtons(container) {
  container.querySelectorAll('.copy-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const code = button.parentElement?.querySelector('code');
      if (!code) return;

      const rawCode = code.dataset.raw || code.textContent || '';
      const originalText = button.textContent;

      try {
        await copyText(rawCode);
        button.textContent = 'Copied';
        button.classList.add('is-copied');
      } catch (err) {
        button.textContent = 'Failed';
        button.classList.add('is-failed');
      }

      window.setTimeout(() => {
        button.textContent = originalText;
        button.classList.remove('is-copied', 'is-failed');
      }, 1400);
    });
  });
}

/* ==========================================
   Post Loader
========================================== */

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

async function loadPost() {
  const params = new URLSearchParams(location.search);
  const slug = params.get('slug');

  const titleEl = document.getElementById('post-title');
  const metaEl = document.getElementById('post-meta');
  const contentEl = document.getElementById('post-content');
  const descriptionEl = document.querySelector('meta[name="description"]');

  if (!slug) {
    document.title = '文章不存在 · Minliny';
    titleEl.textContent = '文章不存在';
    metaEl.textContent = '';
    contentEl.innerHTML = `<p>这篇文章不存在，或者链接已经失效。</p><p><a href="index.html">返回首页</a></p>`;
    if (descriptionEl) descriptionEl.setAttribute('content', '文章不存在');
    return;
  }

  try {
    // Load post index for metadata
    const [metaRes, mdRes] = await Promise.all([
      fetch('posts.json'),
      fetch(`posts/${encodeURIComponent(slug)}.md`)
    ]);

    if (!mdRes.ok) throw new Error(`文章未找到 (${mdRes.status})`);

    const posts = metaRes.ok ? await metaRes.json() : [];
    const meta = posts.find(p => p.slug === slug);
    const md = await mdRes.text();

    // Page title
    const title = meta ? meta.title : slug;
    document.title = `${title} · Minliny`;
    titleEl.textContent = title;
    if (descriptionEl) {
      descriptionEl.setAttribute('content', meta?.excerpt || `${title} · Minliny`);
    }

    if (meta && meta.date) {
      metaEl.textContent = formatDate(meta.date);
    }

    // Render Markdown
    setupMarked();
    contentEl.innerHTML = marked.parse(md);

    // Highlight any code blocks not already processed by renderer
    contentEl.querySelectorAll('pre code:not(.hljs)').forEach(block => {
      hljs.highlightElement(block);
    });
    setupCopyButtons(contentEl);

  } catch (err) {
    document.title = '加载失败 · Minliny';
    titleEl.textContent = '文章不存在';
    metaEl.textContent = '';
    contentEl.innerHTML = `<p style="color:var(--mid);font-size:14px">${err.message}</p><p><a href="index.html">返回首页</a></p>`;
    if (descriptionEl) descriptionEl.setAttribute('content', '文章加载失败');
    console.error('Failed to load post:', err);
  }
}

loadPost();
