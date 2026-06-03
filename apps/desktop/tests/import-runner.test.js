'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// MUST set the ledger path BEFORE requiring the engine: progress.js binds
// PROGRESS_FILE at module-load time. Unique per process so runs never collide
// and never write into the repo.
const TMP_PROGRESS = path.join(os.tmpdir(), `e2o-desktop-test-${process.pid}.json`);
process.env.E2O_PROGRESS_FILE = TMP_PROGRESS;

const test = require('node:test');
const assert = require('node:assert');
const { runImport } = require('../src/import-runner.js');

function fakeClient() {
  let n = 0;
  return {
    getToken: async () => 'TKN',
    createSection: async (_nb, name) => ({ id: `sec-${name}`, displayName: name }),
    findPageByTitle: async () => null,
    createPage: async () => ({ id: `p-${++n}` }),
    createPageWithAttachments: async () => ({ id: `p-${++n}` }),
    deletePage: async () => {},
  };
}

const SAMPLE_ENEX = path.join(__dirname, 'fixtures', 'sample.enex');

test.beforeEach(() => { try { fs.unlinkSync(TMP_PROGRESS); } catch { /* none */ } });
test.after(() => { try { fs.unlinkSync(TMP_PROGRESS); } catch { /* none */ } });

test('runImport imports the sample enex into a fixed section and reports progress', async () => {
  const phases = [];
  const result = await runImport({
    enexPath: SAMPLE_ENEX,
    sectionId: 'sec-test',
    getToken: async () => 'TKN',
    client: fakeClient(),
    force: true,                         // ignore any resume state — we are testing a fresh import
    onProgress: (e) => phases.push(e.phase + (e.status ? ':' + e.status : '')),
  });
  assert.ok(result.imported >= 1, 'at least one note imported');
  assert.strictEqual(result.cancelled, false);
  assert.ok(phases.includes('parsing'));
  assert.ok(phases.includes('start'));
  assert.ok(phases.some((p) => p === 'note:imported'));
  assert.ok(phases.includes('done'));
});

test('runImport stops when shouldCancel returns true', async () => {
  const result = await runImport({
    enexPath: SAMPLE_ENEX,
    sectionId: 'sec-test',
    getToken: async () => 'TKN',
    client: fakeClient(),
    shouldCancel: () => true,
    onProgress: () => {},
  });
  assert.strictEqual(result.cancelled, true);
  assert.strictEqual(result.imported, 0);
});
