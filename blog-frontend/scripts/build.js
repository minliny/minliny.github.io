const path = require('path');
const { spawnSync } = require('child_process');

const scripts = ['generate-posts.js', 'generate-rss.js'];

for (const script of scripts) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log('Build completed.');
