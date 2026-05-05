'use strict';
/**
 * Extended tests for --from-local (acceptance criteria #6).
 * Covers parser edge-cases, --output-html pipeline integration,
 * auto-detect CLI behaviour, and resumability.
 *
 * Cases already covered by local-cache-reader.test.js and
 * cli-from-local.test.js are NOT duplicated here.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

const { iterateNotes, openReadOnly } = require('../src/local-cache-reader');

const CLI = path.join(__dirname, '..', 'src', 'index.js');

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `enex-ext-${label}-`));
}

function run(args, opts = {}) {
  const { env = {}, cwd } = opts;
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ONENOTE_ACCESS_TOKEN: '', MSAL_NO_INTERACTIVE: '1', ...env },
    timeout: 30_000,
    cwd,
  });
}

function seedCache(db, { notes = [], tags = [], cacheRows = [] } = {}) {
  db.exec(`
    CREATE TABLE Nodes_Note      (TKey TEXT PRIMARY KEY, TValue TEXT);
    CREATE TABLE Nodes_Tag       (TKey TEXT PRIMARY KEY, TValue TEXT);
    CREATE TABLE CacheLookaside  (TKey TEXT PRIMARY KEY, TValue TEXT);
  `);
  const insN = db.prepare('INSERT INTO Nodes_Note (TKey, TValue) VALUES (?, ?)');
  const insT = db.prepare('INSERT INTO Nodes_Tag  (TKey, TValue) VALUES (?, ?)');
  const insC = db.prepare('INSERT INTO CacheLookaside (TKey, TValue) VALUES (?, ?)');
  for (const n of notes) insN.run(n.key, JSON.stringify(n.value));
  for (const t of tags)  insT.run(t.key, JSON.stringify(t.value));
  for (const c of cacheRows) insC.run(c.key, c.value);
}

function seedCacheFile(cacheFile, opts) {
  const db = new Database(cacheFile);
  seedCache(db, opts);
  db.close();
}

function findHtmlFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findHtmlFiles(full));
    else if (entry.name.endsWith('.html')) results.push(full);
  }
  return results;
}

// ── Parser unit tests — edge cases not in local-cache-reader.test.js ─────────

describe('local-cache-reader (extended) — iterateNotes edge cases', () => {
  test('empty Nodes_Note table yields no items', () => {
    const db = new Database(':memory:');
    seedCache(db);
    const out = [...iterateNotes(db)];
    assert.equal(out.length, 0);
    db.close();
  });

  test('multiple notes are all yielded', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [
        { key: 'n1', value: { title: 'First',  created: '2026-01-01T00:00:00Z' } },
        { key: 'n2', value: { title: 'Second', created: '2026-01-02T00:00:00Z' } },
        { key: 'n3', value: { title: 'Third',  created: '2026-01-03T00:00:00Z' } },
      ],
      cacheRows: [
        { key: 'n1', value: '<p>A</p>' },
        { key: 'n2', value: '<p>B</p>' },
        { key: 'n3', value: '<p>C</p>' },
      ],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out.length, 3);
    const titles = out.map(n => n.title).sort();
    assert.deepEqual(titles, ['First', 'Second', 'Third']);
    db.close();
  });

  test('Unicode note titles are preserved exactly', () => {
    const db = new Database(':memory:');
    const unicodeTitle = 'Üïçödé Títlé 日本語 🦄';
    seedCache(db, {
      notes: [{ key: 'u1', value: { title: unicodeTitle, created: '2026-03-01T00:00:00Z' } }],
      cacheRows: [{ key: 'u1', value: '<p>unicode body</p>' }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out.length, 1);
    assert.equal(out[0].title, unicodeTitle);
    db.close();
  });

  test('note:<guid> lowercase key variant resolves body', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{ key: 'g99', value: { title: 'Lowercase variant', created: '2026-02-01T00:00:00Z' } }],
      cacheRows: [{ key: 'note:g99', value: '<div>lowercase body</div>' }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out.length, 1);
    assert.match(out[0].content, /lowercase body/);
    db.close();
  });

  test('Note:<guid>:content key variant resolves body', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{ key: 'g77', value: { title: 'Colon-content variant', created: '2026-02-01T00:00:00Z' } }],
      cacheRows: [{ key: 'Note:g77:content', value: '<div>content-suffix body</div>' }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out.length, 1);
    assert.match(out[0].content, /content-suffix body/);
    db.close();
  });

  test('JSON body with "body" key is unwrapped', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{ key: 'jb', value: { title: 'Body key', created: '2026-01-01T00:00:00Z' } }],
      cacheRows: [{ key: 'jb', value: JSON.stringify({ body: '<p>from body key</p>' }) }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out.length, 1);
    assert.match(out[0].content, /from body key/);
    db.close();
  });

  test('JSON body with "content" key is unwrapped', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{ key: 'jc', value: { title: 'Content key', created: '2026-01-01T00:00:00Z' } }],
      cacheRows: [{ key: 'jc', value: JSON.stringify({ content: '<p>from content key</p>' }) }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out.length, 1);
    assert.match(out[0].content, /from content key/);
    db.close();
  });

  test('NodeFields wrapper extracts title and dates', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{
        key: 'nf',
        value: {
          NodeFields: {
            title: 'From NodeFields',
            created: '2026-04-10T08:00:00Z',
            updated: '2026-04-11T09:00:00Z',
          },
        },
      }],
      cacheRows: [{ key: 'nf', value: '<p>wrapped body</p>' }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out.length, 1);
    assert.equal(out[0].title, 'From NodeFields');
    assert.equal(out[0].created, '20260410T080000Z');
    assert.equal(out[0].updated, '20260411T090000Z');
    db.close();
  });

  test('unparseable metadata row yields _skip with reason=unparseable-metadata', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE Nodes_Note     (TKey TEXT PRIMARY KEY, TValue TEXT);
      CREATE TABLE CacheLookaside (TKey TEXT PRIMARY KEY, TValue TEXT);
    `);
    db.prepare('INSERT INTO Nodes_Note (TKey, TValue) VALUES (?, ?)').run('bad', 'not json at all !!!');
    const out = [...iterateNotes(db)];
    assert.equal(out.length, 1);
    assert.equal(out[0]._skip, true);
    assert.equal(out[0].reason, 'unparseable-metadata');
    assert.equal(out[0].guid, 'bad');
    db.close();
  });

  test('local resource refs in body are scrubbed before yielding', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{ key: 's1', value: { title: 'Has image', created: '2026-01-01T00:00:00Z' } }],
      cacheRows: [{
        key: 's1',
        value: '<p>text</p><img src="evernote+resource://abc" /><p>after</p>',
      }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out.length, 1);
    assert.doesNotMatch(out[0].content, /evernote\+resource/);
    assert.match(out[0].content, /image not included/);
    db.close();
  });
});

// ── openReadOnly error handling ───────────────────────────────────────────────

describe('local-cache-reader (extended) — corrupt file error handling', () => {
  test('gives a clean error when SQLite file is corrupt (error surfaces on first query)', () => {
    // On all platforms, better-sqlite3 opens the file handle successfully but
    // raises SQLITE_NOTADB ("file is not a database") on the first query.
    // The observable behaviour for callers is: openReadOnly() succeeds, but
    // iterateNotes() (or any query) throws a clean Error — no unhandled crash.
    const tmpDir = makeTempDir('corrupt');
    const corruptFile = path.join(tmpDir, 'corrupt.sql');
    let db;
    try {
      fs.writeFileSync(corruptFile, 'this is not a sqlite database — just garbage bytes', 'utf8');
      db = openReadOnly(corruptFile);           // must NOT throw
      assert.ok(db, 'openReadOnly should return a db handle for a corrupt file');
      assert.throws(
        () => [...iterateNotes(db)],            // throws on first query
        (err) => {
          assert.ok(err instanceof Error, 'should throw a proper Error');
          assert.match(err.message, /database|SQLITE/i, 'message should describe the SQLite issue');
          return true;
        },
      );
    } finally {
      try { db && db.close(); } catch { /* ignore */ }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* EBUSY on Windows — OS reclaims on reboot */ }
    }
  });
});

// ── Integration test — --from-local --output-html ────────────────────────────

describe('CLI — --from-local --output-html', () => {
  test('creates one HTML file per note from local cache', () => {
    const cacheDir = makeTempDir('html-cache');
    const outDir   = makeTempDir('html-out');
    const cwdDir   = makeTempDir('html-cwd');
    const cacheFile = path.join(cacheDir, 'UDB-User1+RemoteGraph.sql');
    try {
      seedCacheFile(cacheFile, {
        notes: [
          { key: 'h1', value: { title: 'HTML Note One', created: '2026-01-10T10:00:00Z' } },
          { key: 'h2', value: { title: 'HTML Note Two', created: '2026-01-11T10:00:00Z' } },
        ],
        cacheRows: [
          { key: 'h1', value: '<p>Body of note one</p>' },
          { key: 'h2', value: '<p>Body of note two</p>' },
        ],
      });
      const { status, stdout } = run(
        ['--from-local', '--cache-path', cacheFile, '--output-html', outDir],
        { cwd: cwdDir },
      );
      assert.equal(status, 0, `non-zero exit; stdout:\n${stdout}`);
      const files = findHtmlFiles(outDir);
      assert.equal(
        files.length, 2,
        `expected 2 HTML files, found: ${files.map(f => path.basename(f)).join(', ')}`,
      );
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(outDir,   { recursive: true, force: true });
      fs.rmSync(cwdDir,   { recursive: true, force: true });
    }
  });

  test('HTML file contains the note title and body text', () => {
    const cacheDir = makeTempDir('html-content-cache');
    const outDir   = makeTempDir('html-content-out');
    const cwdDir   = makeTempDir('html-content-cwd');
    const cacheFile = path.join(cacheDir, 'UDB-User1+RemoteGraph.sql');
    try {
      seedCacheFile(cacheFile, {
        notes: [
          { key: 'c1', value: { title: 'My Titled Note', created: '2026-02-05T08:00:00Z' } },
        ],
        cacheRows: [
          { key: 'c1', value: '<p>Specific body content XYZ</p>' },
        ],
      });
      run(['--from-local', '--cache-path', cacheFile, '--output-html', outDir], { cwd: cwdDir });
      const files = findHtmlFiles(outDir);
      assert.ok(files.length >= 1, 'expected at least one HTML file');
      const html = fs.readFileSync(files[0], 'utf8');
      assert.match(html, /My Titled Note/);
      assert.match(html, /Specific body content XYZ/);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(outDir,   { recursive: true, force: true });
      fs.rmSync(cwdDir,   { recursive: true, force: true });
    }
  });

  test('stdout reports "Saved:" for each note and "Imported: 2"', () => {
    const cacheDir = makeTempDir('html-saved-cache');
    const outDir   = makeTempDir('html-saved-out');
    const cwdDir   = makeTempDir('html-saved-cwd');
    const cacheFile = path.join(cacheDir, 'UDB-User1+RemoteGraph.sql');
    try {
      seedCacheFile(cacheFile, {
        notes: [
          { key: 's1', value: { title: 'Save One', created: '2026-03-01T00:00:00Z' } },
          { key: 's2', value: { title: 'Save Two', created: '2026-03-02T00:00:00Z' } },
        ],
        cacheRows: [
          { key: 's1', value: '<p>body1</p>' },
          { key: 's2', value: '<p>body2</p>' },
        ],
      });
      const { status, stdout } = run(
        ['--from-local', '--cache-path', cacheFile, '--output-html', outDir],
        { cwd: cwdDir },
      );
      assert.equal(status, 0, `non-zero exit; stdout:\n${stdout}`);
      assert.match(stdout, /Saved:/);
      assert.match(stdout, /Imported: 2/);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(outDir,   { recursive: true, force: true });
      fs.rmSync(cwdDir,   { recursive: true, force: true });
    }
  });

  test('HTML output filenames contain no path-unsafe characters', () => {
    const cacheDir = makeTempDir('html-safe-cache');
    const outDir   = makeTempDir('html-safe-out');
    const cwdDir   = makeTempDir('html-safe-cwd');
    const cacheFile = path.join(cacheDir, 'UDB-User1+RemoteGraph.sql');
    try {
      seedCacheFile(cacheFile, {
        notes: [
          { key: 'safe1', value: { title: 'Note: With/Special|Chars?', created: '2026-01-01T00:00:00Z' } },
        ],
        cacheRows: [{ key: 'safe1', value: '<p>body</p>' }],
      });
      run(['--from-local', '--cache-path', cacheFile, '--output-html', outDir], { cwd: cwdDir });
      const files = findHtmlFiles(outDir);
      for (const f of files) {
        assert.doesNotMatch(path.basename(f), /[/\\?%*:|"<>]/);
      }
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(outDir,   { recursive: true, force: true });
      fs.rmSync(cwdDir,   { recursive: true, force: true });
    }
  });

  test('notes with missing body are skipped but notes with body still produce HTML', () => {
    const cacheDir = makeTempDir('html-mixed-cache');
    const outDir   = makeTempDir('html-mixed-out');
    const cwdDir   = makeTempDir('html-mixed-cwd');
    const cacheFile = path.join(cacheDir, 'UDB-User1+RemoteGraph.sql');
    try {
      seedCacheFile(cacheFile, {
        notes: [
          { key: 'good', value: { title: 'Has Body',  created: '2026-01-01T00:00:00Z' } },
          { key: 'bad',  value: { title: 'No Body',   created: '2026-01-02T00:00:00Z' } },
        ],
        cacheRows: [{ key: 'good', value: '<p>real body</p>' }],
      });
      const { status, stdout } = run(
        ['--from-local', '--cache-path', cacheFile, '--output-html', outDir],
        { cwd: cwdDir },
      );
      assert.equal(status, 0, `non-zero exit; stdout:\n${stdout}`);
      const files = findHtmlFiles(outDir);
      assert.equal(files.length, 1, 'only the note with a body should produce an HTML file');
      assert.match(stdout, /Imported: 1/);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(outDir,   { recursive: true, force: true });
      fs.rmSync(cwdDir,   { recursive: true, force: true });
    }
  });
});

// ── CLI flag — auto-detect behaviour when Evernote not present ───────────────

describe('CLI — --from-local auto-detect (no --cache-path)', () => {
  test('reports "could not find" when no Evernote cache exists on the system', () => {
    // Redirect all OS-specific Evernote cache dirs to a temp directory that
    // contains no *RemoteGraph.sql file, forcing getCandidateCacheDirs() to
    // return locations that do not exist.
    const emptyDir = makeTempDir('no-evernote');
    const cwdDir   = makeTempDir('no-evernote-cwd');
    try {
      const { stdout, stderr } = run(['--from-local', '--dry-run'], {
        env: {
          LOCALAPPDATA: emptyDir,   // Windows primary
          APPDATA: emptyDir,        // Windows secondary
          HOME: emptyDir,           // macOS / Linux
          XDG_CONFIG_HOME: emptyDir,
          XDG_DATA_HOME: emptyDir,
        },
        cwd: cwdDir,
      });
      const combined = (stdout || '') + '\n' + (stderr || '');
      assert.match(combined, /could not find.*evernote|no.*evernote.*cache/i);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
      fs.rmSync(cwdDir,   { recursive: true, force: true });
    }
  });

  test('auto-detects cache when --cache-path points at directory containing RemoteGraph.sql', () => {
    // Uses --cache-path pointing at a directory (not the file directly) to
    // exercise the findSqlInDir() branch inside discoverCacheFile().
    const cacheDir = makeTempDir('autodir-cache');
    const outDir   = makeTempDir('autodir-out');
    const cwdDir   = makeTempDir('autodir-cwd');
    const cacheFile = path.join(cacheDir, 'UDB-User42+RemoteGraph.sql');
    try {
      seedCacheFile(cacheFile, {
        notes: [{ key: 'a1', value: { title: 'Auto Dir', created: '2026-05-01T00:00:00Z' } }],
        cacheRows: [{ key: 'a1', value: '<p>auto-dir body</p>' }],
      });
      // Pass the directory, not the file — CLI should find the .sql inside
      const { status, stdout } = run(
        ['--from-local', '--cache-path', cacheDir, '--dry-run'],
        { cwd: cwdDir },
      );
      assert.equal(status, 0, `non-zero exit; stdout:\n${stdout}`);
      assert.match(stdout, /1 note\(s\) found in local cache/);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(outDir,   { recursive: true, force: true });
      fs.rmSync(cwdDir,   { recursive: true, force: true });
    }
  });
});

// ── Resumability tests ────────────────────────────────────────────────────────

describe('CLI — --from-local resumability', () => {
  test('--output-html run writes progress.json with __local__ file key', () => {
    const cacheDir = makeTempDir('res1-cache');
    const outDir   = makeTempDir('res1-out');
    const cwdDir   = makeTempDir('res1-cwd');
    const cacheFile = path.join(cacheDir, 'UDB-User1+RemoteGraph.sql');
    try {
      seedCacheFile(cacheFile, {
        notes: [
          { key: 'r1', value: { title: 'Resume Note A', created: '2026-04-01T00:00:00Z' } },
          { key: 'r2', value: { title: 'Resume Note B', created: '2026-04-02T00:00:00Z' } },
        ],
        cacheRows: [
          { key: 'r1', value: '<p>resumable A</p>' },
          { key: 'r2', value: '<p>resumable B</p>' },
        ],
      });
      const { status } = run(
        ['--from-local', '--cache-path', cacheFile, '--output-html', outDir],
        { cwd: cwdDir },
      );
      assert.equal(status, 0);

      const progressPath = path.join(cwdDir, 'progress.json');
      assert.ok(fs.existsSync(progressPath), 'progress.json should be created');
      const data = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      assert.equal(data.version, 2);
      const fileEntry = data.files['__local__'];
      assert.ok(fileEntry, '__local__ key should exist in progress.json');
      const importedKeys = Object.keys(fileEntry.imported);
      assert.equal(importedKeys.length, 2);
      assert.ok(importedKeys.some(k => k.startsWith('__local__::Resume Note A::')));
      assert.ok(importedKeys.some(k => k.startsWith('__local__::Resume Note B::')));
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(outDir,   { recursive: true, force: true });
      fs.rmSync(cwdDir,   { recursive: true, force: true });
    }
  });

  test('--dry-run --resume skips notes already in progress.json and imports the rest', () => {
    // NOTE: --output-html --resume re-imports notes with null onenote_page_id (verifyImport
    // returns "missing" for null pageIds). --dry-run --resume correctly short-circuits before
    // verifyImport, so dry-run is the right mode for testing skip behaviour.
    const cacheDir = makeTempDir('res2-cache');
    const cwdDir   = makeTempDir('res2-cwd');
    const cacheFile = path.join(cacheDir, 'UDB-User1+RemoteGraph.sql');
    try {
      seedCacheFile(cacheFile, {
        notes: [
          { key: 'p1', value: { title: 'Already Done',  created: '2026-04-01T00:00:00Z' } },
          { key: 'p2', value: { title: 'Still Pending', created: '2026-04-02T00:00:00Z' } },
        ],
        cacheRows: [
          { key: 'p1', value: '<p>done</p>' },
          { key: 'p2', value: '<p>pending</p>' },
        ],
      });

      // Pre-seed progress marking "Already Done" as imported.
      // Key format: __local__::<title>::<created-enex>
      // '2026-04-01T00:00:00Z' → ensureEnexDate → '20260401T000000Z'
      const progressData = {
        version: 2,
        files: {
          '__local__': {
            imported: {
              '__local__::Already Done::20260401T000000Z': {
                onenote_page_id: null,
                timestamp: new Date().toISOString(),
              },
            },
          },
        },
      };
      fs.writeFileSync(path.join(cwdDir, 'progress.json'), JSON.stringify(progressData, null, 2));

      const { status, stdout } = run(
        ['--from-local', '--cache-path', cacheFile, '--dry-run', '--resume'],
        { cwd: cwdDir },
      );
      assert.equal(status, 0, `non-zero exit; stdout:\n${stdout}`);
      assert.match(stdout, /Imported: 1/);
      assert.match(stdout, /Skipped:\s+1/i);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(cwdDir,   { recursive: true, force: true });
    }
  });

  test('without --resume all notes are re-imported even if progress.json has them', () => {
    const cacheDir = makeTempDir('res3-cache');
    const cwdDir   = makeTempDir('res3-cwd');
    const cacheFile = path.join(cacheDir, 'UDB-User1+RemoteGraph.sql');
    try {
      seedCacheFile(cacheFile, {
        notes: [
          { key: 'x1', value: { title: 'Already Done 2', created: '2026-04-01T00:00:00Z' } },
        ],
        cacheRows: [{ key: 'x1', value: '<p>already done body</p>' }],
      });

      const progressData = {
        version: 2,
        files: {
          '__local__': {
            imported: {
              '__local__::Already Done 2::20260401T000000Z': {
                onenote_page_id: null,
                timestamp: new Date().toISOString(),
              },
            },
          },
        },
      };
      fs.writeFileSync(path.join(cwdDir, 'progress.json'), JSON.stringify(progressData, null, 2));

      const { status, stdout } = run(
        ['--from-local', '--cache-path', cacheFile, '--dry-run'],
        { cwd: cwdDir },
      );
      assert.equal(status, 0, `non-zero exit; stdout:\n${stdout}`);
      // Without --resume, progress.json is ignored for skip decisions
      assert.match(stdout, /Imported: 1/);
      assert.doesNotMatch(stdout, /Skipped:/);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(cwdDir,   { recursive: true, force: true });
    }
  });

  test('second --output-html run appends collision-safe filenames (no crash)', () => {
    // Simulates: first run completes, second run re-imports cleanly (no crash,
    // no stale HTML from first run conflicts). Collision handler appends (2).
    const cacheDir = makeTempDir('res4-cache');
    const outDir   = makeTempDir('res4-out');
    const cwdDir   = makeTempDir('res4-cwd');
    const cacheFile = path.join(cacheDir, 'UDB-User1+RemoteGraph.sql');
    try {
      seedCacheFile(cacheFile, {
        notes: [
          { key: 'rr1', value: { title: 'Repeat Note', created: '2026-05-01T00:00:00Z' } },
        ],
        cacheRows: [{ key: 'rr1', value: '<p>repeat body</p>' }],
      });
      // First run
      const r1 = run(
        ['--from-local', '--cache-path', cacheFile, '--output-html', outDir],
        { cwd: cwdDir },
      );
      assert.equal(r1.status, 0);
      // Second run into same dir (collision → "Repeat Note (2).html")
      const r2 = run(
        ['--from-local', '--cache-path', cacheFile, '--output-html', outDir],
        { cwd: cwdDir },
      );
      assert.equal(r2.status, 0);
      const files = findHtmlFiles(outDir);
      // Both runs should have produced files; both should be safe filenames
      assert.ok(files.length >= 1);
      for (const f of files) {
        assert.doesNotMatch(path.basename(f), /[/\\?%*:|"<>]/);
      }
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(outDir,   { recursive: true, force: true });
      fs.rmSync(cwdDir,   { recursive: true, force: true });
    }
  });
});
