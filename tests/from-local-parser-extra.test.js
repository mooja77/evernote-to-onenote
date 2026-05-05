'use strict';
/**
 * Additional parser unit + round-trip integration tests for --from-local.
 * Acceptance criteria #6 — gaps not covered by local-cache-reader.test.js
 * or from-local-extended.test.js:
 *
 *   ① Large dataset (100 notes) correctness
 *   ② Alternative metadata field names (tags/tagGuids, createdAt/created_at,
 *      updatedAt/updated_at, sourceURL)
 *   ③ openReadOnly on a truly non-existent file path
 *   ④ Unicode body content preserved end-to-end through --output-html
 *   ⑤ Resource marker text ([image not included]) visible in final HTML file
 *   ⑥ enex-parser shape parity — all expected keys present in local reader output
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

const {
  iterateNotes,
  openReadOnly,
  scrubLocalResourceRefs,
} = require('../src/local-cache-reader');

const CLI = path.join(__dirname, '..', 'src', 'index.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `enex-extra-${label}-`));
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

// ─── ① Large dataset — 100 notes ─────────────────────────────────────────────

describe('local-cache-reader (extra) — large dataset', () => {
  test('iterates 100 notes without loss or duplication', () => {
    const db = new Database(':memory:');
    const N = 100;
    const notes = [];
    const cacheRows = [];
    for (let i = 0; i < N; i++) {
      const guid = `note-${String(i).padStart(3, '0')}`;
      notes.push({
        key: guid,
        value: { title: `Note ${i}`, created: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z` },
      });
      cacheRows.push({ key: guid, value: `<p>Body of note ${i}</p>` });
    }
    seedCache(db, { notes, cacheRows });

    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out.length, N, `Expected ${N} notes, got ${out.length}`);

    // Check no duplicates by title
    const titles = new Set(out.map(n => n.title));
    assert.equal(titles.size, N, 'Duplicate titles detected — notes were duplicated');

    // Spot-check first and last
    const sortedTitles = [...titles].sort();
    assert.ok(sortedTitles.includes('Note 0'));
    assert.ok(sortedTitles.includes('Note 99'));
    db.close();
  });

  test('100-note cache with 30 missing bodies — correct skip/yield split', () => {
    const db = new Database(':memory:');
    const notes = [];
    const cacheRows = [];
    for (let i = 0; i < 100; i++) {
      const guid = `n${i}`;
      notes.push({ key: guid, value: { title: `T${i}`, created: '2026-01-01T00:00:00Z' } });
      if (i >= 70) cacheRows.push({ key: guid, value: `<p>body ${i}</p>` });
    }
    seedCache(db, { notes, cacheRows });

    const all = [...iterateNotes(db)];
    const real   = all.filter(n => !n._skip);
    const skipped = all.filter(n => n._skip && n.reason === 'no-body');
    assert.equal(real.length, 30);
    assert.equal(skipped.length, 70);
    db.close();
  });
});

// ─── ② Alternative metadata field names ──────────────────────────────────────

describe('local-cache-reader (extra) — alternative metadata field names', () => {
  test('uses "tags" array when "tagGuids" is absent', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{
        key: 'tg1',
        value: { title: 'Tags-field note', created: '2026-01-01T00:00:00Z', tags: ['tag-a', 'tag-b'] },
      }],
      tags: [
        { key: 'tag-a', value: { name: 'alpha' } },
        { key: 'tag-b', value: { name: 'beta' } },
      ],
      cacheRows: [{ key: 'tg1', value: '<p>body</p>' }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].tags.sort(), ['alpha', 'beta']);
    db.close();
  });

  test('uses "createdAt" when "created" is absent', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{ key: 'ca1', value: { title: 'createdAt note', createdAt: '2026-03-10T14:00:00Z' } }],
      cacheRows: [{ key: 'ca1', value: '<p>body</p>' }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out[0].created, '20260310T140000Z');
    db.close();
  });

  test('uses "created_at" (snake_case) when "created" and "createdAt" are absent', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{ key: 'sc1', value: { title: 'snake_case date', created_at: '2026-04-20T08:30:00Z' } }],
      cacheRows: [{ key: 'sc1', value: '<p>body</p>' }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out[0].created, '20260420T083000Z');
    db.close();
  });

  test('uses "updatedAt" when "updated" is absent', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{ key: 'ua1', value: { title: 'updatedAt note', created: '2026-01-01T00:00:00Z', updatedAt: '2026-05-01T12:00:00Z' } }],
      cacheRows: [{ key: 'ua1', value: '<p>body</p>' }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out[0].updated, '20260501T120000Z');
    db.close();
  });

  test('uses "updated_at" (snake_case) when "updated" and "updatedAt" are absent', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{ key: 'sua1', value: { title: 'snake_case updated', created: '2026-01-01T00:00:00Z', updated_at: '2026-05-02T10:00:00Z' } }],
      cacheRows: [{ key: 'sua1', value: '<p>body</p>' }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out[0].updated, '20260502T100000Z');
    db.close();
  });

  test('uses "sourceURL" (uppercase URL) as fallback for sourceUrl', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{ key: 'su1', value: { title: 'URL-upper', created: '2026-01-01T00:00:00Z', sourceURL: 'https://upper.example.com' } }],
      cacheRows: [{ key: 'su1', value: '<p>body</p>' }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out[0].sourceUrl, 'https://upper.example.com');
    db.close();
  });
});

// ─── ③ openReadOnly on a non-existent file path ───────────────────────────────

describe('local-cache-reader (extra) — openReadOnly error paths', () => {
  test('throws a clear error when the file path does not exist', () => {
    const missingPath = path.join(os.tmpdir(), `does-not-exist-${Date.now()}.sql`);
    assert.throws(
      () => openReadOnly(missingPath),
      (err) => {
        assert.ok(err instanceof Error, 'should throw an Error instance');
        // better-sqlite3 with fileMustExist:true raises SQLITE_CANTOPEN
        // ("unable to open database file") — NOT an ENOENT on all platforms.
        const msg = err.message || '';
        const code = err.code || '';
        assert.ok(
          /ENOENT|no such file|does not exist|unable to open|SQLITE_CANTOPEN/i.test(msg) ||
          /ENOENT|SQLITE_CANTOPEN/i.test(code),
          `Expected a "file not found" style error in: "${msg}" (code: "${code}")`
        );
        return true;
      }
    );
  });
});

// ─── ④ enex-parser shape parity ──────────────────────────────────────────────

describe('local-cache-reader (extra) — enex-parser shape parity', () => {
  test('output object has all keys expected by importNotes()', () => {
    // importNotes() accesses: title, created, updated, tags, content,
    // resources, author, sourceUrl.  The extra _guid key is allowed.
    const required = ['title', 'created', 'updated', 'tags', 'content', 'resources', 'author', 'sourceUrl'];
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{ key: 'shape1', value: { title: 'Shape check', created: '2026-01-01T00:00:00Z', author: 'A', sourceUrl: 'https://x.com' } }],
      cacheRows: [{ key: 'shape1', value: '<p>body</p>' }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out.length, 1);
    const note = out[0];
    for (const key of required) {
      assert.ok(key in note, `Missing required key "${key}" in local-cache note shape`);
    }
    // resources must be an array (even if empty)
    assert.ok(Array.isArray(note.resources), 'resources must be an array');
    // tags must be an array
    assert.ok(Array.isArray(note.tags), 'tags must be an array');
    // content must be a string
    assert.equal(typeof note.content, 'string');
    db.close();
  });

  test('resources array is always empty (v1 text-only) — no .dat files read', () => {
    const db = new Database(':memory:');
    // Note has a resource reference in its body (evernote+resource://)
    // but resources array must be [] — v1 never reads .dat files from disk
    seedCache(db, {
      notes: [{ key: 'res1', value: { title: 'Has resource ref' } }],
      cacheRows: [{
        key: 'res1',
        value: '<p>text</p><img src="evernote+resource://abc123" alt="img"/>',
      }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].resources, [], 'resources must be empty — v1 is text-only, no .dat files read');
    db.close();
  });
});

// ─── ⑤ Unicode body content in --output-html ─────────────────────────────────

describe('CLI (extra) — Unicode body content in --output-html', () => {
  test('Unicode characters in note body are preserved in output HTML file', () => {
    const cacheDir  = makeTempDir('uni-cache');
    const outDir    = makeTempDir('uni-out');
    const cwdDir    = makeTempDir('uni-cwd');
    const cacheFile = path.join(cacheDir, 'UDB-User1+RemoteGraph.sql');
    const unicodeBody = '<p>Héllo Wörld — 日本語テスト — 🦄 emöji — €£¥</p>';
    try {
      seedCacheFile(cacheFile, {
        notes: [{ key: 'u1', value: { title: 'Unicode Body', created: '2026-01-01T00:00:00Z' } }],
        cacheRows: [{ key: 'u1', value: unicodeBody }],
      });
      const { status, stdout } = run(
        ['--from-local', '--cache-path', cacheFile, '--output-html', outDir],
        { cwd: cwdDir },
      );
      assert.equal(status, 0, `non-zero exit; stdout:\n${stdout}`);
      const files = findHtmlFiles(outDir);
      assert.ok(files.length >= 1, 'Expected at least one HTML output file');
      const html = fs.readFileSync(files[0], 'utf8');
      // Core Unicode chars must survive the full pipeline
      assert.match(html, /Héllo/, 'accented characters should be preserved');
      assert.match(html, /日本語/, 'CJK characters should be preserved');
      assert.match(html, /🦄/, 'emoji should be preserved');
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(outDir,   { recursive: true, force: true });
      fs.rmSync(cwdDir,   { recursive: true, force: true });
    }
  });
});

// ─── ⑥ Resource marker text in --output-html ─────────────────────────────────

describe('CLI (extra) — resource marker text in --output-html', () => {
  test('[image not included] marker appears in output HTML when body has evernote+resource:// src', () => {
    const cacheDir  = makeTempDir('marker-cache');
    const outDir    = makeTempDir('marker-out');
    const cwdDir    = makeTempDir('marker-cwd');
    const cacheFile = path.join(cacheDir, 'UDB-User1+RemoteGraph.sql');
    try {
      seedCacheFile(cacheFile, {
        notes: [{ key: 'm1', value: { title: 'Has Image', created: '2026-01-01T00:00:00Z' } }],
        cacheRows: [{
          key: 'm1',
          value: '<p>before</p><img src="evernote+resource://abc-hash-123" alt="photo"/><p>after</p>',
        }],
      });
      const { status, stdout } = run(
        ['--from-local', '--cache-path', cacheFile, '--output-html', outDir],
        { cwd: cwdDir },
      );
      assert.equal(status, 0, `non-zero exit; stdout:\n${stdout}`);
      const files = findHtmlFiles(outDir);
      assert.ok(files.length >= 1);
      const html = fs.readFileSync(files[0], 'utf8');
      assert.match(html, /image not included/i, 'resource marker text should be present in HTML output');
      assert.doesNotMatch(html, /evernote\+resource/, 'raw resource URL must not appear in output HTML');
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(outDir,   { recursive: true, force: true });
      fs.rmSync(cwdDir,   { recursive: true, force: true });
    }
  });

  test('[attachment not included] marker appears for evernote+resource:// anchor links', () => {
    const cacheDir  = makeTempDir('attach-cache');
    const outDir    = makeTempDir('attach-out');
    const cwdDir    = makeTempDir('attach-cwd');
    const cacheFile = path.join(cacheDir, 'UDB-User1+RemoteGraph.sql');
    try {
      seedCacheFile(cacheFile, {
        notes: [{ key: 'a1', value: { title: 'Has Attachment', created: '2026-01-01T00:00:00Z' } }],
        cacheRows: [{
          key: 'a1',
          value: '<p>see <a href="evernote+resource://doc-hash">document.pdf</a> here</p>',
        }],
      });
      run(['--from-local', '--cache-path', cacheFile, '--output-html', outDir], { cwd: cwdDir });
      const files = findHtmlFiles(outDir);
      assert.ok(files.length >= 1);
      const html = fs.readFileSync(files[0], 'utf8');
      assert.match(html, /attachment not included/i);
      assert.doesNotMatch(html, /evernote\+resource/);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(outDir,   { recursive: true, force: true });
      fs.rmSync(cwdDir,   { recursive: true, force: true });
    }
  });

  test('file:// image src is scrubbed and produces marker in output HTML', () => {
    const html = '<p>x</p><img src="file:///C:/Users/john/AppData/evernote/res/abc.png" />';
    const scrubbed = scrubLocalResourceRefs(html);
    assert.match(scrubbed, /image not included/i);
    assert.doesNotMatch(scrubbed, /file:\/\//);
  });
});
