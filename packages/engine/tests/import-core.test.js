const test = require('node:test');
const assert = require('node:assert');
const { importNotes } = require('../src/import-core.js');

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
