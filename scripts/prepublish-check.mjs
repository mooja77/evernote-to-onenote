import { execFileSync } from 'node:child_process';

const privatePatterns = [
  /^all-notes\//,
  /^output\//,
  /^html-preview\//,
  /^test-output\//,
  /^test-batch\//,
  /^test-batch-integration\//,
  /^progress\.json$/,
  /^progress\.json\.tmp$/,
  /^msal-cache\.json$/,
  /^\.access-token$/,
  /^import-log.*\.txt$/,
  /^.*\.log$/,
  /^.*\.enex$/,
];

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function runNpm(args) {
  if (process.platform === 'win32') {
    return execFileSync('cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return run('npm', args);
}

function fail(message, items = []) {
  console.error(`prepublish-check failed: ${message}`);
  for (const item of items) console.error(`- ${item}`);
  process.exit(1);
}

const tracked = run('git', ['ls-files'])
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(Boolean);

const trackedPrivate = tracked.filter(file => {
  if (file.startsWith('tests/fixtures/') && file.endsWith('.enex')) return false;
  return privatePatterns.some(pattern => pattern.test(file));
});

if (trackedPrivate.length > 0) {
  fail('private/generated files are tracked by git', trackedPrivate);
}

const packJson = JSON.parse(runNpm(['pack', '--json', '--dry-run']));
const packed = (packJson[0]?.files || []).map(file => file.path).sort();

const packedPrivate = packed.filter(file => {
  if (file.startsWith('package/tests/fixtures/') && file.endsWith('.enex')) return false;
  return privatePatterns.some(pattern => pattern.test(file.replace(/^package\//, '')));
});

if (packedPrivate.length > 0) {
  fail('private/generated files would be included in npm package', packedPrivate);
}

const required = ['package.json', 'README.md', 'LICENSE', 'src/index.js'];
const missing = required.filter(file => !packed.includes(file));
if (missing.length > 0) {
  fail('required package files are missing from npm dry run', missing);
}

console.log(`prepublish-check passed: ${packed.length} package file(s), no private migration data.`);
