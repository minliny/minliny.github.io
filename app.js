/* ==========================================
   Theme Management
   4 themes in fixed order:
   day       = 日间墨竹
   night     = 夜间墨竹
   day-pure  = 日间普通
   night-pure= 夜间普通
========================================== */

const THEME_KEY = 'xiaogai-theme';
const VALID_THEMES = new Set(['day', 'night', 'day-pure', 'night-pure']);
const GROUP_LABELS = {
  tech: 'Tech',
  notes: 'Notes',
  life: 'Life',
};

function normalizeTheme(mode) {
  return VALID_THEMES.has(mode) ? mode : 'day';
}

function applyTheme(mode) {
  const theme = normalizeTheme(mode);
  document.body.classList.remove('day', 'night', 'day-pure', 'night-pure');
  document.body.classList.add(theme);

  localStorage.setItem(THEME_KEY, theme);

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.mode === theme);
  });
}

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    applyTheme(btn.dataset.mode);
    // 竹叶点击弹跳动画
    btn.classList.remove('leaf-spring');
    void btn.offsetWidth; // 强制 reflow，重启动画
    btn.classList.add('leaf-spring');
  });
  btn.addEventListener('animationend', (e) => {
    if (e.animationName === 'leafSpring') btn.classList.remove('leaf-spring');
  });
});

// Default theme: 日间墨竹
const savedTheme = normalizeTheme(localStorage.getItem(THEME_KEY) || 'day');
applyTheme(savedTheme);

/* ==========================================
   Posts Loader
========================================== */

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function groupPosts(posts) {
  const grouped = new Map();

  posts.forEach((post) => {
    const groupKey = post.group || 'notes';
    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
    grouped.get(groupKey).push(post);
  });

  return grouped;
}

function createEntryItem(post, index) {
  const li = document.createElement('li');
  li.className = 'entry';
  li.style.animationDelay = `${index * 80}ms`;

  const excerpt = post.excerpt
    ? `<p class="entry-excerpt">${post.excerpt}</p>`
    : '';

  li.innerHTML = `
    <div class="entry-title">
      <a href="post.html?slug=${encodeURIComponent(post.slug)}">${post.title}</a>
    </div>
    <div class="entry-meta">${formatDate(post.date)}</div>
    ${excerpt}
  `;

  return li;
}

async function loadPosts() {
  const list = document.getElementById('entries-list');
  const empty = document.getElementById('empty-state');
  const loading = document.getElementById('loading-state');

  try {
    const res = await fetch('posts.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const posts = await res.json();

    loading.style.display = 'none';

    if (!posts || posts.length === 0) {
      empty.style.display = 'block';
      return;
    }

    const sortedPosts = [...posts].sort((a, b) => new Date(b.date) - new Date(a.date));
    const groupedPosts = groupPosts(sortedPosts);
    let entryIndex = 0;

    groupedPosts.forEach((items, groupKey) => {
      const section = document.createElement('section');
      section.className = 'post-group';

      const heading = document.createElement('h2');
      heading.className = 'group-title';
      heading.textContent = GROUP_LABELS[groupKey] || groupKey;
      section.appendChild(heading);

      const groupList = document.createElement('ul');
      groupList.className = 'group-list';

      items.forEach((post) => {
        groupList.appendChild(createEntryItem(post, entryIndex));
        entryIndex += 1;
      });

      section.appendChild(groupList);
      list.appendChild(section);
    });

  } catch (err) {
    loading.style.display = 'none';
    empty.style.display = 'block';
    empty.textContent = '无法加载文章列表。';
    console.error('Failed to load posts:', err);
  }
}

loadPosts();
