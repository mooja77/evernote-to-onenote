'use strict';
/**
 * CLI integration tests for --from-local. We seed a real on-disk SQLite
 * file that mimics the Evernote v10/v11 conduit cache, then run the CLI
 * with `--from-local --cache-path <file> --dry-run` and assert on the
 * stdout summary + report.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

const CLI = path.join(__dirname, '..', 'src', 'index.js');

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `enex-cli-${label}-`));
}

function run(args, opts = {}) {
  const { env = {}, cwd } = opts;
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ONENOTE_ACCESS_TOKEN: '', MSAL_NO_INTERACTIVE: '1', ...env },
    timeout: 30000,
    cwd,
  });
}

function seedCacheFile(cacheFile, { notes, cacheRows }) {
  const db = new Database(cacheFile);
  db.exec(`
    CREATE TABLE Nodes_Note      (TKey TEXT PRIMARY KEY, TValue TEXT);
    CREATE TABLE Nodes_Tag       (TKey TEXT PRIMARY KEY, TValue TEXT);
    CREATE TABLE CacheLookaside  (TKey TEXT PRIMARY KEY, TValue TEXT);
  `);
  const insN = db.prepare('INSERT INTO Nodes_Note (TKey, TValue) VALUES (?, ?)');
  const insC = db.prepare('INSERT INTO CacheLookaside (TKey, TValue) VALUES (?, ?)');
  for (const n of notes) insN.run(n.key, JSON.stringify(n.value));
  for (const c of (cacheRows || [])) insC.run(c.key, c.value);
  db.close();
}

describe('CLI — --from-local', () => {
  test('--help mentions --from-local and --cache-path', () => {
    const { status, stdout } = run(['--help']);
    assert.equal(status, 0);
    assert.match(stdout, /--from-local/);
    assert.match(stdout, /--cache-path/);
  });

  test('--from-local + --batch is rejected with a helpful message', () => {
    const { status, stderr } = run(['--from-local', '--batch', '/some/dir', '--dry-run']);
    assert.equal(status, 1);
    assert.match(stderr, /cannot be combined/i);
  });

  test('--from-local + positional .enex path is rejected', () => {
    const { status, stderr } = run(['--from-local', 'foo.enex', '--dry-run']);
    assert.equal(status, 1);
    assert.match(stderr, /cannot be combined/i);
  });

  test('--cache-path without --from-local is rejected', () => {
    const { status, stderr } = run(['--cache-path', 'foo.sql', '--dry-run']);
    assert.equal(status, 1);
    assert.match(stderr, /can only be used with --from-local/i);
  });

  test('--cache-path with no value is rejected', () => {
    const { status, stderr } = run(['--from-local', '--cache-path']);
    assert.equal(status, 1);
    assert.match(stderr, /requires a path argument/i);
  });

  test('--from-local --dry-run reads notes from a seeded cache', () => {
    const cwdDir = makeTempDir('fromlocal-dry');
    const cacheDir = makeTempDir('fromlocal-cache');
    const cacheFile = path.join(cacheDir, 'UDB-User1+RemoteGraph.sql');
    try {
      seedCacheFile(cacheFile, {
        notes: [
          { key: 'g1', value: { title: 'Cached note one', created: '2026-01-01T00:00:00Z' } },
          { key: 'g2', value: { title: 'Cached note two', created: '2026-02-01T00:00:00Z' } },
        ],
        cacheRows: [
          { key: 'g1', value: '<p>One</p>' },
          { key: 'g2', value: '<p>Two</p>' },
        ],
      });

      const { status, stdout } = run(
        ['--from-local', '--cache-path', cacheFile, '--dry-run'],
        { cwd: cwdDir },
      );
      assert.equal(status, 0, `non-zero exit; stdout was:\n${stdout}`);
      assert.match(stdout, /local Evernote cache/i);
      assert.match(stdout, /2 note\(s\) found in local cache/);
      assert.match(stdout, /Cached note one/);
      assert.match(stdout, /Cached note two/);
      assert.match(stdout, /DRY RUN complete/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('--from-local reports notes whose body has not been downloaded', () => {
    const cwdDir = makeTempDir('fromlocal-skip');
    const cacheDir = makeTempDir('fromlocal-skip-c');
    const cacheFile = path.join(cacheDir, 'UDB-User1+RemoteGraph.sql');
    try {
      seedCacheFile(cacheFile, {
        notes: [
          { key: 'has-body', value: { title: 'A',  created: '2026-01-01T00:00:00Z' } },
          { key: 'no-body-1', value: { title: 'B', created: '2026-01-01T00:00:00Z' } },
          { key: 'no-body-2', value: { title: 'C', created: '2026-01-01T00:00:00Z' } },
        ],
        cacheRows: [{ key: 'has-body', value: '<p>body</p>' }],
      });
      const { status, stdout } = run(
        ['--from-local', '--cache-path', cacheFile, '--dry-run'],
        { cwd: cwdDir },
      );
      assert.equal(status, 0, `non-zero exit; stdout was:\n${stdout}`);
      // Total / withBody / withoutBody banner
      assert.match(stdout, /3 note\(s\) found in local cache/);
      assert.match(stdout, /1 have body text; 2 skipped — body not yet downloaded/);
      // The skip-list preview line names some guids
      assert.match(stdout, /content not yet downloaded/);
      // The big-box message is shown when at-or-more skipped than imported
      assert.match(stdout, /don.?t have content yet/);
      assert.match(stdout, /Make available offline/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('--from-local with --cache-path pointing at an empty dir errors clearly', () => {
    const cacheDir = makeTempDir('fromlocal-empty');
    try {
      const { stdout, stderr } = run(
        ['--from-local', '--cache-path', cacheDir, '--dry-run'],
        { cwd: cacheDir },
      );
      // The reader throws with a message naming the missing pattern;
      // index.js logs that message to stderr and increments totalFailed.
      const combined = (stdout || '') + '\n' + (stderr || '');
      assert.match(combined, /No Evernote cache .*found in/i);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
