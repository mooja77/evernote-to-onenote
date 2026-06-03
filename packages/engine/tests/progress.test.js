'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Each test gets its own temp dir so PROGRESS_FILE is isolated
let tmpDir;
let origCwd;

function freshProgress() {
  delete require.cache[require.resolve('../src/progress')];
  // Override PROGRESS_FILE by setting cwd to tmpDir
  return require('../src/progress');
}

describe('progress module', () => {
  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-test-'));
    process.chdir(tmpDir);
    // Clear cached module so PROGRESS_FILE resolves relative to new cwd
    delete require.cache[require.resolve('../src/progress')];
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../src/progress')];
  });

  // ── loadProgress ─────────────────────────────────────────────────────────

  test('returns fresh v2 schema when no progress.json exists', () => {
    const { loadProgress } = require('../src/progress');
    const p = loadProgress();
    assert.equal(p.version, 2);
    assert.deepEqual(p.files, {});
  });

  test('returns fresh v2 schema when progress.json is corrupt JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'progress.json'), '{invalid json!!!', 'utf8');
    const { loadProgress } = require('../src/progress');
    const p = loadProgress();
    assert.equal(p.version, 2);
    assert.deepEqual(p.files, {});
  });

  test('loads a valid v2 progress file', () => {
    const data = {
      version: 2,
      files: {
        'notes.enex': {
          notebook_id: 'nb-1',
          section_ids: ['sec-1'],
          imported: {
            'notes.enex::My Note::20260101T000000Z': { onenote_page_id: 'pg-1', timestamp: '2026-01-01T00:00:00.000Z' },
          },
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'progress.json'), JSON.stringify(data, null, 2), 'utf8');
    const { loadProgress } = require('../src/progress');
    const p = loadProgress();
    assert.equal(p.version, 2);
    assert.ok(p.files['notes.enex']);
    assert.ok(p.files['notes.enex'].imported['notes.enex::My Note::20260101T000000Z']);
  });

  // ── v1 → v2 migration ────────────────────────────────────────────────────

  test('migrates v1 format to v2', () => {
    const v1 = {
      'export.enex': {
        imported: ['export.enex::Note A::20250101T000000Z', 'export.enex::Note B::20250202T000000Z'],
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'progress.json'), JSON.stringify(v1, null, 2), 'utf8');
    const { loadProgress } = require('../src/progress');
    const p = loadProgress();
    assert.equal(p.version, 2);
    const imported = p.files['export.enex'].imported;
    assert.ok(imported['export.enex::Note A::20250101T000000Z']);
    assert.ok(imported['export.enex::Note B::20250202T000000Z']);
    // v1 migrated entries have null page ID and timestamp
    assert.equal(imported['export.enex::Note A::20250101T000000Z'].onenote_page_id, null);
    assert.equal(imported['export.enex::Note A::20250101T000000Z'].timestamp, null);
  });

  test('migration skips non-object entries in v1', () => {
    const v1 = { badEntry: 'not-an-object' };
    fs.writeFileSync(path.join(tmpDir, 'progress.json'), JSON.stringify(v1, null, 2), 'utf8');
    const { loadProgress } = require('../src/progress');
    const p = loadProgress();
    assert.equal(p.version, 2);
    assert.ok(!p.files['badEntry']);
  });

  test('migration handles v1 entry with empty imported array', () => {
    const v1 = { 'empty.enex': { imported: [] } };
    fs.writeFileSync(path.join(tmpDir, 'progress.json'), JSON.stringify(v1, null, 2), 'utf8');
    const { loadProgress } = require('../src/progress');
    const p = loadProgress();
    assert.equal(p.version, 2);
    assert.deepEqual(p.files['empty.enex'].imported, {});
  });

  // ── markImported ──────────────────────────────────────────────────────────

  test('markImported creates file entry if not present', () => {
    const { loadProgress, markImported } = require('../src/progress');
    const p = loadProgress();
    markImported(p, 'notes.enex', 'notes.enex::Note::20260101T000000Z', 'pg-123');
    const entry = p.files['notes.enex'].imported['notes.enex::Note::20260101T000000Z'];
    assert.equal(entry.onenote_page_id, 'pg-123');
    assert.ok(entry.timestamp);
  });

  test('markImported stores null page ID when pageId not provided', () => {
    const { loadProgress, markImported } = require('../src/progress');
    const p = loadProgress();
    markImported(p, 'notes.enex', 'notes.enex::Note::20260101T000000Z', null);
    const entry = p.files['notes.enex'].imported['notes.enex::Note::20260101T000000Z'];
    assert.equal(entry.onenote_page_id, null);
  });

  test('markImported sets a valid ISO timestamp', () => {
    const { loadProgress, markImported } = require('../src/progress');
    const p = loadProgress();
    const before = new Date().toISOString();
    markImported(p, 'f.enex', 'key', 'pg-1');
    const after = new Date().toISOString();
    const ts = p.files['f.enex'].imported['key'].timestamp;
    assert.ok(ts >= before);
    assert.ok(ts <= after);
  });

  test('markImported updates existing entry', () => {
    const { loadProgress, markImported } = require('../src/progress');
    const p = loadProgress();
    markImported(p, 'f.enex', 'key', 'pg-1');
    markImported(p, 'f.enex', 'key', 'pg-updated');
    assert.equal(p.files['f.enex'].imported['key'].onenote_page_id, 'pg-updated');
  });

  // ── isImported ────────────────────────────────────────────────────────────

  test('isImported returns false for unknown file', () => {
    const { loadProgress, isImported } = require('../src/progress');
    const p = loadProgress();
    assert.equal(isImported(p, 'unknown.enex', 'key'), false);
  });

  test('isImported returns false for unknown key in known file', () => {
    const { loadProgress, markImported, isImported } = require('../src/progress');
    const p = loadProgress();
    markImported(p, 'f.enex', 'other-key', 'pg-1');
    assert.equal(isImported(p, 'f.enex', 'missing-key'), false);
  });

  test('isImported returns true after markImported', () => {
    const { loadProgress, markImported, isImported } = require('../src/progress');
    const p = loadProgress();
    markImported(p, 'f.enex', 'note-key', 'pg-1');
    assert.equal(isImported(p, 'f.enex', 'note-key'), true);
  });

  // ── saveProgress (atomic write) ───────────────────────────────────────────

  test('saveProgress writes valid JSON to progress.json', () => {
    const { loadProgress, markImported, saveProgress } = require('../src/progress');
    const p = loadProgress();
    markImported(p, 'f.enex', 'key', 'pg-1');
    saveProgress(p);
    const raw = fs.readFileSync(path.join(tmpDir, 'progress.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 2);
    assert.ok(parsed.files['f.enex'].imported['key']);
  });

  test('saveProgress does not leave a .tmp file on disk', () => {
    const { loadProgress, saveProgress } = require('../src/progress');
    const p = loadProgress();
    saveProgress(p);
    const tmpFile = path.join(tmpDir, 'progress.json.tmp');
    assert.ok(!fs.existsSync(tmpFile), '.tmp file should not remain after save');
  });

  test('saveProgress round-trips correctly through loadProgress', () => {
    const { loadProgress, markImported, saveProgress } = require('../src/progress');
    const p = loadProgress();
    markImported(p, 'notes.enex', 'notes.enex::Title::20260101T000000Z', 'pg-42');
    saveProgress(p);

    delete require.cache[require.resolve('../src/progress')];
    const { loadProgress: load2 } = require('../src/progress');
    const p2 = load2();
    assert.equal(p2.version, 2);
    assert.equal(p2.files['notes.enex'].imported['notes.enex::Title::20260101T000000Z'].onenote_page_id, 'pg-42');
  });

  // ── verifyImport ──────────────────────────────────────────────────────────

  test('verifyImport returns "missing" for unimported note', async () => {
    const { loadProgress, verifyImport } = require('../src/progress');
    const p = loadProgress();
    const fakeClient = { getToken: async () => 'tok' };
    const result = await verifyImport(p, 'f.enex', 'missing-key', fakeClient);
    assert.equal(result, 'missing');
  });

  test('verifyImport returns "missing" for v1-migrated entry (no page ID)', async () => {
    const { loadProgress, markImported, verifyImport } = require('../src/progress');
    const p = loadProgress();
    markImported(p, 'f.enex', 'key', null); // no page ID
    const fakeClient = { getToken: async () => 'tok' };
    const result = await verifyImport(p, 'f.enex', 'key', fakeClient);
    assert.equal(result, 'missing');
  });

  test('verifyImport returns "exists" when API responds 200', async () => {
    // Patch node-fetch BEFORE re-loading progress.js so it captures the mock fetch
    const fetchPath = require.resolve('node-fetch');
    const origEntry = require.cache[fetchPath];
    require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: async () => ({ ok: true, status: 200 }) };
    delete require.cache[require.resolve('../src/progress')];

    const { loadProgress, markImported, verifyImport } = require('../src/progress');
    const p = loadProgress();
    markImported(p, 'f.enex', 'key', 'pg-real');
    const result = await verifyImport(p, 'f.enex', 'key', { getToken: async () => 'tok' });

    require.cache[fetchPath] = origEntry;
    delete require.cache[require.resolve('../src/progress')];
    assert.equal(result, 'exists');
  });

  test('verifyImport returns "missing" when API responds 404', async () => {
    const fetchPath = require.resolve('node-fetch');
    const origEntry = require.cache[fetchPath];
    require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: async () => ({ ok: false, status: 404 }) };
    delete require.cache[require.resolve('../src/progress')];

    const { loadProgress, markImported, verifyImport } = require('../src/progress');
    const p = loadProgress();
    markImported(p, 'f.enex', 'key', 'pg-gone');
    const result = await verifyImport(p, 'f.enex', 'key', { getToken: async () => 'tok' });

    require.cache[fetchPath] = origEntry;
    delete require.cache[require.resolve('../src/progress')];
    assert.equal(result, 'missing');
  });

  test('verifyImport returns "unknown" when API responds 401 (auth failure, not genuinely missing)', async () => {
    const fetchPath = require.resolve('node-fetch');
    const origEntry = require.cache[fetchPath];
    require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: async () => ({ ok: false, status: 401 }) };
    delete require.cache[require.resolve('../src/progress')];

    const { loadProgress, markImported, verifyImport } = require('../src/progress');
    const p = loadProgress();
    markImported(p, 'f.enex', 'key', 'pg-auth-fail');
    const result = await verifyImport(p, 'f.enex', 'key', { getToken: async () => 'tok' });

    require.cache[fetchPath] = origEntry;
    delete require.cache[require.resolve('../src/progress')];
    assert.equal(result, 'unknown');
  });

  test('verifyImport returns "unknown" when fetch throws (network error — must NOT trigger re-import)', async () => {
    const fetchPath = require.resolve('node-fetch');
    const origEntry = require.cache[fetchPath];
    require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: async () => { throw new Error('Network failure'); } };
    delete require.cache[require.resolve('../src/progress')];

    const { loadProgress, markImported, verifyImport } = require('../src/progress');
    const p = loadProgress();
    markImported(p, 'f.enex', 'key', 'pg-net-err');
    const result = await verifyImport(p, 'f.enex', 'key', { getToken: async () => 'tok' });

    require.cache[fetchPath] = origEntry;
    delete require.cache[require.resolve('../src/progress')];
    assert.equal(result, 'unknown');
  });
});
