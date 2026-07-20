const test = require('node:test');
const assert = require('node:assert');
const { importNotes } = require('../src/import-core.js');
const importCore = require('../src/import-core.js');

function fakeClient() {
  let pageSeq = 0;
  return {
    sections: [],
    createSection: async (_nbId, name) => ({ id: `sec-${name}`, displayName: name }),
    findPageByTitle: async () => null,
    createPage: async () => ({ id: `page-${++pageSeq}` }),
    createPageWithAttachments: async () => ({ id: `page-${++pageSeq}` }),
    deletePage: async () => {},
  };
}

const noteKeyFn = (filename, note) => `${filename}::${note.title || 'Untitled'}::${note.created || ''}`;

test('emits noteImported for each new note and returns counts', async () => {
  const events = [];
  const progress = { version: 2, files: {} };
  const counts = await importNotes({
    notes: [{ title: 'A', content: '<en-note>hi</en-note>', resources: [] }],
    filename: 'Book.enex',
    client: fakeClient(),
    notebook: { id: 'nb1' },
    progress,
    defaultSectionName: 'Book',
    noteKeyFn,
    saveProgress: () => {},
    onEvent: (e) => events.push(e.type),
  });
  assert.strictEqual(counts.succeeded, 1);
  assert.ok(events.includes('noteStart'));
  assert.ok(events.includes('noteImported'));
});

test('skips a verified already-imported note under resume', async () => {
  const progress = { version: 2, files: { 'Book.enex': { imported: { 'Book.enex::A::': { onenote_page_id: 'p1' } } } } };
  const client = fakeClient();
  const events = [];
  const counts = await importNotes({
    notes: [{ title: 'A', content: '<en-note/>', resources: [] }],
    filename: 'Book.enex', client, notebook: { id: 'nb1' }, progress,
    defaultSectionName: 'Book', resume: true, noteKeyFn,
    verifyImport: async () => 'exists',
    isImported: () => true,
    saveProgress: () => {},
    onEvent: (e) => events.push(e.type),
  });
  assert.strictEqual(counts.skipped, 1);
  assert.ok(events.includes('noteSkipped'));
});

test('targetSection routes every note to the pre-chosen section, no createSection', async () => {
  const client = fakeClient();
  let createSectionCalls = 0;
  client.createSection = async (...a) => { createSectionCalls++; return { id: 'sec-x', displayName: a[1] }; };
  const counts = await importNotes({
    notes: [{ title: 'A', content: '<en-note/>', resources: [] }],
    filename: 'Book.enex', client, notebook: { id: null }, progress: { version: 2, files: {} },
    targetSection: { id: 'chosen-sec' }, noteKeyFn,
    saveProgress: () => {}, onEvent: () => {},
  });
  assert.strictEqual(counts.succeeded, 1);
  assert.strictEqual(createSectionCalls, 0);
});

test('yearFromCreated returns null for non-numeric or short prefixes (fidelity)', () => {
  assert.strictEqual(importCore.yearFromCreated('20240115T101500Z'), '2024');
  assert.strictEqual(importCore.yearFromCreated('bad-date'), null);
  assert.strictEqual(importCore.yearFromCreated(''), null);
  assert.strictEqual(importCore.yearFromCreated(null), null);
});

test('shouldCancel stops importing remaining notes and returns cancelled=true', async () => {
  const events = [];
  let seen = 0;
  const counts = await importNotes({
    notes: [
      { title: 'A', content: '<en-note/>', resources: [] },
      { title: 'B', content: '<en-note/>', resources: [] },
      { title: 'C', content: '<en-note/>', resources: [] },
    ],
    filename: 'Book.enex',
    client: fakeClient(),
    notebook: { id: null },
    progress: { version: 2, files: {} },
    targetSection: { id: 'sec-1' },
    noteKeyFn,
    concurrency: 1,
    saveProgress: () => {},
    shouldCancel: () => seen >= 1,   // cancel after the first note has been processed
    onEvent: (e) => { events.push(e.type); if (e.type === 'noteImported') seen++; },
  });
  assert.strictEqual(counts.cancelled, true);
  assert.strictEqual(counts.succeeded, 1);          // only the first imported
  assert.ok(events.includes('cancelled'));
  assert.ok(events.filter((t) => t === 'cancelled').length === 1, 'cancelled emitted exactly once');
});

test('no shouldCancel → cancelled is false and all import', async () => {
  const counts = await importNotes({
    notes: [{ title: 'A', content: '<en-note/>', resources: [] }, { title: 'B', content: '<en-note/>', resources: [] }],
    filename: 'Book.enex', client: fakeClient(), notebook: { id: null },
    progress: { version: 2, files: {} }, targetSection: { id: 'sec-1' }, noteKeyFn,
    concurrency: 1, saveProgress: () => {}, onEvent: () => {},
  });
  assert.strictEqual(counts.cancelled, false);
  assert.strictEqual(counts.succeeded, 2);
});

test('overwrite creates replacement before deleting the original', async () => {
  const order = [];
  const client = fakeClient();
  client.findPageByTitle = async () => ({ id: 'old-page' });
  client.createPage = async () => { order.push('create'); return { id: 'new-page' }; };
  client.deletePage = async () => { order.push('delete'); };
  const counts = await importNotes({
    notes: [{ title: 'A', content: '<en-note/>', resources: [] }],
    filename: 'Book.enex', client, notebook: { id: 'nb1' },
    progress: { version: 2, files: {} }, defaultSectionName: 'Book',
    noteKeyFn, onConflict: 'overwrite', saveProgress: () => {}, onEvent: () => {},
  });
  assert.strictEqual(counts.succeeded, 1);
  assert.deepStrictEqual(order, ['create', 'delete']);
});

test('overwrite preserves the original when replacement creation fails', async () => {
  let deleted = false;
  const client = fakeClient();
  client.findPageByTitle = async () => ({ id: 'old-page' });
  client.createPage = async () => { throw new Error('network unavailable'); };
  client.deletePage = async () => { deleted = true; };
  const counts = await importNotes({
    notes: [{ title: 'A', content: '<en-note/>', resources: [] }],
    filename: 'Book.enex', client, notebook: { id: 'nb1' },
    progress: { version: 2, files: {} }, defaultSectionName: 'Book',
    noteKeyFn, onConflict: 'overwrite', saveProgress: () => {}, onEvent: () => {},
  });
  assert.strictEqual(counts.failed, 1);
  assert.strictEqual(deleted, false);
});

test('507 storage-full errors are propagated without creating overflow sections', async () => {
  let sectionCalls = 0;
  const client = fakeClient();
  client.createPage = async () => { throw new Error('OneDrive storage full (507 Insufficient Storage)'); };
  client.createSection = async () => { sectionCalls++; return { id: 'unexpected' }; };
  const counts = await importNotes({
    notes: [{ title: 'A', content: '<en-note/>', resources: [] }],
    filename: 'Book.enex', client, notebook: { id: null },
    progress: { version: 2, files: {} }, targetSection: { id: 'chosen' },
    noteKeyFn, saveProgress: () => {}, onEvent: () => {},
  });
  assert.strictEqual(counts.failed, 1);
  assert.strictEqual(sectionCalls, 0);
});

test('dry-run stores no synthetic Graph page ID', async () => {
  const progress = { version: 2, files: {} };
  let saves = 0;
  const counts = await importNotes({
    notes: [{ title: 'A', content: '<en-note/>', resources: [] }],
    filename: 'Book.enex', client: fakeClient(), notebook: { id: 'nb1' },
    progress, defaultSectionName: 'Book', noteKeyFn, dryRun: true,
    saveProgress: () => { saves++; }, onEvent: () => {},
  });
  assert.strictEqual(counts.succeeded, 1);
  const entry = progress.files['Book.enex'].imported['Book.enex::A::'];
  assert.strictEqual(entry.onenote_page_id, null);
  assert.strictEqual(saves, 1);
});
