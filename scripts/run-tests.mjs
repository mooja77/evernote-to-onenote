import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const testsDir = path.join(root, 'tests');

function collectTestFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

const nodeArgs = process.argv.slice(2).filter(arg => arg !== '--runInBand');
const testFiles = collectTestFiles(testsDir);

if (testFiles.length === 0) {
  console.error('No test files found under tests/.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...nodeArgs, ...testFiles], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test' },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
