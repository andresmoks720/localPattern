import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const pagesDist = resolve(root, '.pages-dist');

const requiredFiles = [
  resolve(pagesDist, 'index.html'),
  resolve(pagesDist, 'sender/index.html'),
  resolve(pagesDist, 'receiver/index.html'),
  resolve(pagesDist, 'receiver_video/index.html')
];

const devOnlyPathPatterns = [
  /\/src\/main\.(t|j)sx?/i,
  /src\/main\.(t|j)sx?/i,
  /@vite\/client/i,
  /localhost:\d+/i
];

const errors = [];

for (const file of requiredFiles) {
  if (!existsSync(file)) {
    errors.push(`Missing required file: ${file}`);
  }
}

for (const file of requiredFiles.slice(1)) {
  if (!existsSync(file)) {
    continue;
  }

  const html = readFileSync(file, 'utf8');
  for (const pattern of devOnlyPathPatterns) {
    if (pattern.test(html)) {
      errors.push(
        `Found dev-only path in ${file}: pattern ${pattern}`
      );
    }
  }
}

if (errors.length > 0) {
  console.error('GitHub Pages artifact verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('GitHub Pages artifact verification passed.');
for (const file of requiredFiles) {
  console.log(`- Found ${file}`);
}
