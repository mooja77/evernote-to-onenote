const test = require('node:test');
const assert = require('node:assert');
const engine = require('../src/index.js');

test('barrel exposes the full public API', () => {
  for (const name of [
    'parseEnexFile', 'enmlToHtml', 'enmlToHtmlWithResources', 'toOneNoteHtml',
    'OneNoteClient', 'loadProgress', 'saveProgress', 'markImported', 'isImported', 'verifyImport',
    'runParallel', 'createGlobalBackoff', 'createWriteQueue',
    'applyTagsToHtml', 'resolveSectionForTags', 'VALID_STRATEGIES',
    'createTokenProvider', 'importNotes',
    'iterateNotes', 'summarizeCache', 'discoverCacheFile',
  ]) {
    assert.ok(engine[name] !== undefined, `missing export: ${name}`);
  }
});
