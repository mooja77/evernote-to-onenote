'use strict';
/**
 * Local-cache reader tests — seed an in-memory SQLite to mimic
 * Evernote v10/v11 conduit storage, exercise the reader, and assert
 * that the produced notes look identical to enex-parser output.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Database = require('better-sqlite3');
const {
  iterateNotes,
  summarizeCache,
  scrubLocalResourceRefs,
  ensureEnexDate,
  detectSchema,
  discoverCacheFile,
  openReadOnly,
  LOCAL_FILENAME_SLOT,
} = require('../src/local-cache-reader');

function seedCache(db, { notes = [], tags = [], cacheRows = [] } = {}) {
  db.exec(`
    CREATE TABLE Nodes_Note  (TKey TEXT PRIMARY KEY, TValue TEXT);
    CREATE TABLE Nodes_Tag   (TKey TEXT PRIMARY KEY, TValue TEXT);
    CREATE TABLE CacheLookaside (TKey TEXT PRIMARY KEY, TValue TEXT);
  `);
  const insN = db.prepare('INSERT INTO Nodes_Note (TKey, TValue) VALUES (?, ?)');
  const insT = db.prepare('INSERT INTO Nodes_Tag  (TKey, TValue) VALUES (?, ?)');
  const insC = db.prepare('INSERT INTO CacheLookaside (TKey, TValue) VALUES (?, ?)');
  for (const n of notes) insN.run(n.key, JSON.stringify(n.value));
  for (const t of tags) insT.run(t.key, JSON.stringify(t.value));
  for (const c of cacheRows) insC.run(c.key, c.value);
}

describe('local-cache-reader — iterateNotes', () => {
  test('yields notes in enex-parser shape, body wrapped in <en-note>', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [
        {
          key: 'guid-1',
          value: {
            title: 'My first note',
            created: '2026-01-15T09:30:00Z',
            updated: '2026-01-16T10:00:00Z',
            tagGuids: ['tag-a'],
            author: 'John',
            sourceUrl: 'https://example.com',
          },
        },
      ],
      tags: [{ key: 'tag-a', value: { name: 'work' } }],
      cacheRows: [{ key: 'guid-1', value: '<p>Hello, world!</p>' }],
    });

    const out = [...iterateNotes(db)];
    assert.equal(out.length, 1);
    const n = out[0];
    assert.equal(n.title, 'My first note');
    assert.equal(n.created, '20260115T093000Z');
    assert.equal(n.updated, '20260116T100000Z');
    assert.deepEqual(n.tags, ['work']);
    assert.equal(n.author, 'John');
    assert.equal(n.sourceUrl, 'https://example.com');
    assert.deepEqual(n.resources, []);
    assert.match(n.content, /^<en-note><p>Hello, world!<\/p><\/en-note>$/);
    db.close();
  });

  test('skips notes whose body has not been downloaded', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [
        { key: 'has-body', value: { title: 'A', created: '2026-01-01T00:00:00Z' } },
        { key: 'no-body',  value: { title: 'B', created: '2026-01-01T00:00:00Z' } },
      ],
      cacheRows: [{ key: 'has-body', value: '<p>body</p>' }],
    });

    const items = [...iterateNotes(db)];
    const real = items.filter(i => !i._skip);
    const skipped = items.filter(i => i._skip);
    assert.equal(real.length, 1);
    assert.equal(real[0].title, 'A');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, 'no-body');
    assert.equal(skipped[0].guid, 'no-body');
    db.close();
  });

  test('looks up body via "Note:<guid>" key variant', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{ key: 'g42', value: { title: 'Prefixed body', created: '2026-02-01T12:00:00Z' } }],
      cacheRows: [{ key: 'Note:g42', value: '<div>prefixed</div>' }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out.length, 1);
    assert.match(out[0].content, /<en-note><div>prefixed<\/div><\/en-note>/);
    db.close();
  });

  test('handles JSON-wrapped body envelopes ({html: …})', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{ key: 'g1', value: { title: 'Wrapped', created: '2026-02-01T12:00:00Z' } }],
      cacheRows: [{
        key: 'g1',
        value: JSON.stringify({ html: '<p>inside-json</p>', other: 'noise' }),
      }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out.length, 1);
    assert.match(out[0].content, /<p>inside-json<\/p>/);
    db.close();
  });

  test('returns empty title fallback and empty tags array', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [{ key: 'g', value: { /* no title */ } }],
      cacheRows: [{ key: 'g', value: '<p>x</p>' }],
    });
    const out = [...iterateNotes(db)].filter(n => !n._skip);
    assert.equal(out[0].title, 'Untitled Note');
    assert.deepEqual(out[0].tags, []);
    db.close();
  });

  test('throws helpful error when Nodes_Note is missing', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE Whatever (x TEXT)');
    assert.throws(() => [...iterateNotes(db)], /does not look like an Evernote cache/);
    db.close();
  });
});

describe('local-cache-reader — summarizeCache', () => {
  test('counts total / withBody / withoutBody', () => {
    const db = new Database(':memory:');
    seedCache(db, {
      notes: [
        { key: 'a', value: { title: 'A' } },
        { key: 'b', value: { title: 'B' } },
        { key: 'c', value: { title: 'C' } },
      ],
      cacheRows: [
        { key: 'a', value: '<p>1</p>' },
        { key: 'Note:b', value: '<p>2</p>' },
        // c has no body
      ],
    });
    const s = summarizeCache(db);
    assert.equal(s.total, 3);
    assert.equal(s.withBody, 2);
    assert.equal(s.withoutBody, 1);
    assert.equal(s.available, true);
    db.close();
  });

  test('reports available=false when Nodes_Note is missing', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE Other (x TEXT)');
    const s = summarizeCache(db);
    assert.equal(s.available, false);
    assert.equal(s.total, 0);
    db.close();
  });
});

describe('local-cache-reader — scrubLocalResourceRefs', () => {
  test('replaces evernote+resource:// images with marker', () => {
    const html = '<p>before <img src="evernote+resource://abc123" alt="x"/> after</p>';
    const out = scrubLocalResourceRefs(html);
    assert.match(out, /image not included/);
    assert.doesNotMatch(out, /evernote\+resource/);
  });

  test('replaces file:// images and absolute Windows paths', () => {
    const out1 = scrubLocalResourceRefs('<img src="file:///C:/x.png"/>');
    const out2 = scrubLocalResourceRefs('<img src="C:\\Users\\a\\b.png"/>');
    assert.match(out1, /image not included/);
    assert.match(out2, /image not included/);
  });

  test('replaces evernote+resource:// anchor attachments', () => {
    const html = '<a href="evernote+resource://r1">file.pdf</a>';
    const out = scrubLocalResourceRefs(html);
    assert.match(out, /attachment not included/);
  });

  test('leaves regular http(s) images alone', () => {
    const html = '<img src="https://example.com/p.png"/>';
    const out = scrubLocalResourceRefs(html);
    assert.equal(out, html);
  });

  test('handles empty / null input', () => {
    assert.equal(scrubLocalResourceRefs(''), '');
    assert.equal(scrubLocalResourceRefs(null), '');
  });
});

describe('local-cache-reader — ensureEnexDate', () => {
  test('passes ENEX-format dates through unchanged', () => {
    assert.equal(ensureEnexDate('20260101T093000Z'), '20260101T093000Z');
  });

  test('converts ISO-8601 to ENEX format', () => {
    assert.equal(ensureEnexDate('2026-01-01T09:30:00Z'), '20260101T093000Z');
  });

  test('converts numeric epoch ms to ENEX format', () => {
    // 2026-03-15T10:20:30Z
    const ms = Date.UTC(2026, 2, 15, 10, 20, 30);
    assert.equal(ensureEnexDate(ms), '20260315T102030Z');
  });

  test('returns null for unparseable strings', () => {
    assert.equal(ensureEnexDate('not a date'), null);
    assert.equal(ensureEnexDate(null), null);
    assert.equal(ensureEnexDate(undefined), null);
  });
});

describe('local-cache-reader — detectSchema', () => {
  test('identifies expected Evernote tables', () => {
    const db = new Database(':memory:');
    seedCache(db);
    const s = detectSchema(db);
    assert.equal(s.hasNodesNote, true);
    assert.equal(s.hasNodesTag, true);
    assert.equal(s.hasCacheLookaside, true);
    assert.equal(s.hasNodesNotebook, false);
    db.close();
  });
});

describe('local-cache-reader — file IO', () => {
  test('discoverCacheFile + openReadOnly: round-trip on a temp file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enote-cache-'));
    const file = path.join(tmpDir, 'UDB-User1+RemoteGraph.sql');
    try {
      // Build a real on-disk DB with the expected shape.
      const db = new Database(file);
      seedCache(db, {
        notes: [{ key: 'g1', value: { title: 'On-disk', created: '2026-01-01T00:00:00Z' } }],
        cacheRows: [{ key: 'g1', value: '<p>disk</p>' }],
      });
      db.close();

      // Discover by directory pointing at the dir
      const discovered = discoverCacheFile({ explicitPath: tmpDir });
      assert.equal(discovered, file);

      // Open read-only and iterate
      const ro = openReadOnly(file);
      try {
        const out = [...iterateNotes(ro)].filter(n => !n._skip);
        assert.equal(out.length, 1);
        assert.equal(out[0].title, 'On-disk');
      } finally {
        ro.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('discoverCacheFile throws when explicit path does not exist', () => {
    assert.throws(
      () => discoverCacheFile({ explicitPath: path.join(os.tmpdir(), 'definitely-not-here-zzz', 'x.sql') }),
      /Cache path not found/,
    );
  });
});

describe('local-cache-reader — module surface', () => {
  test('exports LOCAL_FILENAME_SLOT', () => {
    assert.equal(LOCAL_FILENAME_SLOT, '__local__');
  });
});
