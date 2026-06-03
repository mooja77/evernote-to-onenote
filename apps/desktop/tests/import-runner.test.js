'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const { runImport } = require('../src/import-runner.js');

function fakeClient() {
  let n = 0;
  return {
    createSection: async (_nb, name) => ({ id: `sec-${name}`, displayName: name }),
    findPageByTitle: async () => null,
    createPage: async () => ({ id: `p-${++n}` }),
    createPageWithAttachments: async () => ({ id: `p-${++n}` }),
    deletePage: async () => {},
  };
}

test('runImport imports the sample enex into a fixed section and reports progress', async () => {
  process.env.E2O_PROGRESS_FILE = path.join(os.tmpdir(), `e2o-desktop-${process.pid}.json`);
  const phases = [];
  const result = await runImport({
    enexPath: path.join(__dirname, '..', '..', '..', 'test.enex'),
    sectionId: 'sec-test',
    getToken: async () => 'TKN',
    client: fakeClient(),
    onProgress: (e) => phases.push(e.phase + (e.status ? ':' + e.status : '')),
  });
  assert.ok(result.imported >= 1, 'at least one note imported');
  assert.strictEqual(result.cancelled, false);
  assert.ok(phases.includes('parsing'));
  assert.ok(phases.includes('start'));
  assert.ok(phases.some((p) => p === 'note:imported'));
  assert.ok(phases.includes('done'));
  delete process.env.E2O_PROGRESS_FILE;
});

test('runImport stops when shouldCancel returns true', async () => {
  process.env.E2O_PROGRESS_FILE = path.join(os.tmpdir(), `e2o-desktop-cancel-${process.pid}.json`);
  const result = await runImport({
    enexPath: path.join(__dirname, '..', '..', '..', 'test.enex'),
    sectionId: 'sec-test',
    getToken: async () => 'TKN',
    client: fakeClient(),
    shouldCancel: () => true, // cancel immediately
    onProgress: () => {},
  });
  assert.strictEqual(result.cancelled, true);
  assert.strictEqual(result.imported, 0, 'nothing imported when cancelled immediately');
  delete process.env.E2O_PROGRESS_FILE;
});
