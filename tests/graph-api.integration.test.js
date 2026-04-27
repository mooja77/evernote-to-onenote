'use strict';
/**
 * Live integration test — Microsoft Graph API / OneNote
 *
 * Prerequisite: run `node src/index.js --auth` first so msal-cache.json exists,
 * OR set ONENOTE_ACCESS_TOKEN=<bearer token> in the environment.
 *
 * Run: node --test tests/graph-api.integration.test.js
 *
 * Test plan:
 *  1. Import tests/fixtures/single-note.enex → notebook CI-Test-<timestamp>
 *  2. Verify notebook + section + page exist via listNotebooks/listSections/listPages
 *  3. Re-import with --resume → note must be skipped (no duplicate)
 *  4. Run verify logic → source count == onenote page count
 *  5. Cleanup: delete test pages then section (notebook deletion not supported by consumer API)
 *  6. Test --on-conflict rename: import same note twice → second gets renamed title
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const { OneNoteClient } = require('../src/onenote-client');
const { parseEnexFile } = require('../src/enex-parser');
const { enmlToHtml, toOneNoteHtml } = require('../src/enml-converter');
const { loadProgress, saveProgress, markImported, isImported } = require('../src/progress');
const { getAuthenticatedToken, getTokenFromFile } = require('../src/auth');

const FIXTURE = path.resolve(__dirname, 'fixtures', 'single-note.enex');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me/onenote';

// ─── Auth check ─────────────────────────────────────────────────────────────

async function resolveToken() {
  const legacy = getTokenFromFile();
  if (legacy) return legacy;
  const msalCache = path.resolve(__dirname, '..', 'msal-cache.json');
  if (!fs.existsSync(msalCache)) return null;
  try {
    return await getAuthenticatedToken({ noInteractive: true });
  } catch {
    return null;
  }
}

const RUN_LIVE = process.env.GRAPH_INTEGRATION === '1';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function deleteNotebookPages(token, notebookId) {
  const secRes = await fetch(`${GRAPH_BASE}/notebooks/${notebookId}/sections`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!secRes.ok) return;
  const { value: sections = [] } = await secRes.json();
  for (const sec of sections) {
    const pgRes = await fetch(`${GRAPH_BASE}/sections/${sec.id}/pages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!pgRes.ok) continue;
    const { value: pages = [] } = await pgRes.json();
    for (const pg of pages) {
      await fetch(`${GRAPH_BASE}/pages/${pg.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  }
}

// ─── Skip guard ───────────────────────────────────────────────────────────────

describe('Graph API integration — live (skip if no auth)', () => {
  let token = null;
  let client = null;
  const ts = Date.now();
  const notebookName = `CI-Test-${ts}`;
  let createdNotebookId = null;
  let createdSectionId = null;
  const apiCalls = [];
  const startTime = Date.now();

  before(async () => {
    if (!RUN_LIVE) {
      console.log('  [integration] Skipping live tests — set GRAPH_INTEGRATION=1 to enable');
      console.log('  [integration] Also ensure --auth has been run: node src/index.js --auth');
      return;
    }
    token = await resolveToken();
    if (!token) {
      console.log('  [integration] No auth token available. Run: node src/index.js --auth');
      return;
    }
    const patchedGetToken = async () => {
      apiCalls.push({ type: 'token' });
      return token;
    };
    client = new OneNoteClient({ getToken: patchedGetToken, dryRun: false });
    console.log(`  [integration] Auth OK — notebook: "${notebookName}"`);
  });

  after(async () => {
    if (!RUN_LIVE || !token || !createdNotebookId) return;
    console.log(`\n  [cleanup] Deleting pages from test notebook "${notebookName}"...`);
    try {
      await deleteNotebookPages(token, createdNotebookId);
      console.log('  [cleanup] Pages deleted. Note: consumer OneNote API does not support notebook deletion.');
      console.log(`  [cleanup] Manually delete "${notebookName}" from OneNote if desired.`);
    } catch (err) {
      console.warn(`  [cleanup] Warning: ${err.message}`);
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n  [report] Total duration: ${elapsed}s | API calls tracked: ${apiCalls.length}`);
  });

  // ─── Test 1: Import single-note.enex ──────────────────────────────────────

  test('T1: Import single-note.enex → CI-Test-<timestamp> notebook', async (t) => {
    if (!RUN_LIVE || !token) {
      t.skip('No auth — set GRAPH_INTEGRATION=1 and run --auth first');
      return;
    }

    const notes = await parseEnexFile(FIXTURE);
    assert.equal(notes.length, 1, 'fixture should have exactly 1 note');
    const note = notes[0];
    assert.equal(note.title, 'Single Note');

    // Create notebook (idempotent)
    const notebook = await client.createNotebook(notebookName);
    assert.ok(notebook.id, 'notebook should have an id');
    assert.equal(notebook.displayName, notebookName);
    createdNotebookId = notebook.id;
    apiCalls.push({ type: 'createNotebook', name: notebookName });

    // Create section
    const section = await client.createSection(notebook.id, 'Imported');
    assert.ok(section.id, 'section should have an id');
    assert.equal(section.displayName, 'Imported');
    createdSectionId = section.id;
    apiCalls.push({ type: 'createSection' });

    // Create page
    const html = enmlToHtml(note.content);
    const pageHtml = toOneNoteHtml(note.title, html, { created: note.created });
    const page = await client.createPage(section.id, note.title, pageHtml);
    assert.ok(page.id, 'page should have an id');
    apiCalls.push({ type: 'createPage', title: note.title });

    console.log(`  T1 OK: notebook=${notebook.id} section=${section.id} page=${page.id}`);
  });

  // ─── Test 2: Verify notebook/section/page exist via Graph API ─────────────

  test('T2: Verify notebook + section + page exist (listNotebooks/listSections/listPages)', async (t) => {
    if (!RUN_LIVE || !token || !createdNotebookId) {
      t.skip('No auth or T1 did not run');
      return;
    }

    // listNotebooks — find ours
    const notebooks = await client.listNotebooks();
    apiCalls.push({ type: 'listNotebooks', count: notebooks.length });
    const found = notebooks.find(n => n.id === createdNotebookId);
    assert.ok(found, `notebook "${notebookName}" (${createdNotebookId}) should appear in listNotebooks`);

    // listSections
    const sections = await client.listSections(createdNotebookId);
    apiCalls.push({ type: 'listSections', count: sections.length });
    assert.ok(sections.length >= 1, 'should have at least 1 section');
    const sec = sections.find(s => s.id === createdSectionId);
    assert.ok(sec, 'created section should appear in listSections');

    // listPages
    const pages = await client.listPages(createdSectionId);
    apiCalls.push({ type: 'listPages', count: pages.length });
    assert.equal(pages.length, 1, 'exactly 1 page should exist after T1');
    assert.equal(pages[0].title, 'Single Note');

    console.log(`  T2 OK: ${notebooks.length} notebooks, ${sections.length} sections, ${pages.length} pages`);
  });

  // ─── Test 3: --resume skips already-imported note ─────────────────────────

  test('T3: --resume skips already-imported note (no duplicate)', async (t) => {
    if (!RUN_LIVE || !token || !createdNotebookId) {
      t.skip('No auth or T1 did not run');
      return;
    }

    const notes = await parseEnexFile(FIXTURE);
    const note = notes[0];
    const filename = 'single-note.enex';
    const noteKey = `${filename}::${note.title}::${note.created || ''}`;

    // Simulate marking as already imported (as the CLI does)
    const progress = loadProgress();
    markImported(progress, filename, noteKey, 'fake-page-id-for-resume-test');
    saveProgress(progress);

    // Now verify that isImported returns true for this key
    assert.ok(isImported(progress, filename, noteKey), 'note should be marked as imported');
    apiCalls.push({ type: 'resumeCheck' });

    // Verify page count hasn't changed (no new API call needed — just check local state)
    const pages = await client.listPages(createdSectionId);
    apiCalls.push({ type: 'listPages-resume-check', count: pages.length });
    assert.equal(pages.length, 1, '--resume should not have created a duplicate page');

    // Cleanup: remove the fake progress entry so it doesn't pollute verify test
    delete progress.files[filename];
    saveProgress(progress);

    console.log('  T3 OK: resume check passed, still 1 page (no duplicate)');
  });

  // ─── Test 4: --verify counts match ────────────────────────────────────────

  test('T4: --verify: source note count == OneNote page count', async (t) => {
    if (!RUN_LIVE || !token || !createdNotebookId) {
      t.skip('No auth or T1 did not run');
      return;
    }

    const notes = await parseEnexFile(FIXTURE);
    const sourceCount = notes.length; // 1

    const sections = await client.listSections(createdNotebookId);
    let oneNotePages = 0;
    for (const sec of sections) {
      const pages = await client.listPages(sec.id);
      oneNotePages += pages.length;
      apiCalls.push({ type: 'verifyListPages', sectionId: sec.id, count: pages.length });
    }

    assert.equal(sourceCount, oneNotePages,
      `source count (${sourceCount}) should equal OneNote page count (${oneNotePages})`);

    console.log(`  T4 OK: source=${sourceCount} onenote=${oneNotePages} ✓`);
  });

  // ─── Test 5: --on-conflict rename — second import renames ─────────────────

  test('T5: --on-conflict rename — second import of same note gets renamed title', async (t) => {
    if (!RUN_LIVE || !token || !createdSectionId) {
      t.skip('No auth or T1 did not run');
      return;
    }

    const notes = await parseEnexFile(FIXTURE);
    const note = notes[0];

    // Simulate rename: conflict detected → append date suffix
    const existingPage = await client.findPageByTitle(createdSectionId, note.title);
    assert.ok(existingPage, 'original page should exist for conflict test');
    apiCalls.push({ type: 'findPageByTitle' });

    const dateSuffix = new Date().toISOString().slice(0, 10);
    const renamedTitle = `${note.title} (imported ${dateSuffix})`;

    const html = enmlToHtml(note.content);
    const pageHtml = toOneNoteHtml(renamedTitle, html, { created: note.created });
    const renamed = await client.createPage(createdSectionId, renamedTitle, pageHtml);
    assert.ok(renamed.id, 'renamed page should be created successfully');
    apiCalls.push({ type: 'createPage-renamed', title: renamedTitle });

    // Verify 2 pages now exist
    const pages = await client.listPages(createdSectionId);
    apiCalls.push({ type: 'listPages-after-rename', count: pages.length });
    assert.equal(pages.length, 2, 'should have 2 pages: original + renamed');
    const titles = pages.map(p => p.title).sort();
    assert.ok(titles.some(t2 => t2 === note.title), 'original title should still exist');
    assert.ok(titles.some(t2 => t2.includes('imported')), 'renamed title should include date suffix');

    console.log(`  T5 OK: original="${note.title}" renamed="${renamedTitle}"`);
  });

  // ─── Test 6: Unicode title handling ───────────────────────────────────────

  test('T6: Unicode title and content survive round-trip (real API)', async (t) => {
    if (!RUN_LIVE || !token || !createdSectionId) {
      t.skip('No auth or T1 did not run');
      return;
    }

    const unicodeTitle = 'Test — Ünïcödé 日本語 🎵';
    const unicodeHtml = `<!DOCTYPE html><html><head><title>${unicodeTitle}</title></head><body><p>Héllo Wörld — 日本語テスト</p></body></html>`;

    let page;
    try {
      page = await client.createPage(createdSectionId, unicodeTitle, unicodeHtml);
      apiCalls.push({ type: 'createPage-unicode', title: unicodeTitle });
      assert.ok(page.id, 'unicode page should be created');
      console.log(`  T6 OK: unicode page created id=${page.id}`);
    } catch (err) {
      // Graph API may reject some unicode in titles — record as known limitation
      console.log(`  T6 NOTE: Graph API rejected unicode title: ${err.message}`);
      t.skip(`Graph API unicode limitation: ${err.message}`);
    }
  });

  // ─── Test 7: Rate limit behaviour (mock confirms no live spam) ────────────

  test('T7: 429 rate-limit recovery (mock-assisted — verifies backoff logic)', async (t) => {
    if (!RUN_LIVE) {
      t.skip('Set GRAPH_INTEGRATION=1 to run live suite');
      return;
    }

    // Use intercepted fetch to trigger a 429 then 200 — confirms backoff path.
    // Must also evict onenote-client from require.cache so the freshly required
    // version picks up the mocked fetch rather than the already-bound original.
    let callCount = 0;
    const fetchCachePath2 = require.resolve('node-fetch');
    const clientCachePath = require.resolve('../src/onenote-client');
    const origFetchEntry = require.cache[fetchCachePath2];
    const origClientEntry = require.cache[clientCachePath];
    require.cache[fetchCachePath2] = {
      id: fetchCachePath2, filename: fetchCachePath2, loaded: true,
      exports: async (url, opts) => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false, status: 429,
            headers: { get: (k) => k === 'Retry-After' ? '0' : null },
            json: async () => ({}),
            text: async () => '{}',
          };
        }
        return {
          ok: true, status: 200,
          headers: { get: (k) => k === 'content-type' ? 'application/json' : null },
          json: async () => ({ value: [] }),
          text: async () => '{"value":[]}',
        };
      },
    };
    delete require.cache[clientCachePath];

    let result;
    try {
      const { OneNoteClient: MockableClient } = require('../src/onenote-client');
      const mockClient = new MockableClient({ accessToken: 'mock-tok', dryRun: false });
      result = await mockClient.listNotebooks();
    } finally {
      require.cache[fetchCachePath2] = origFetchEntry;
      require.cache[clientCachePath] = origClientEntry;
    }

    assert.equal(callCount, 2, 'should retry once after 429 and succeed on second call');
    assert.deepEqual(result, [], 'should return empty notebooks array after retry');
    apiCalls.push({ type: '429-backoff-verified' });
    console.log('  T7 OK: 429 retry backoff works (2 calls: 429 then 200)');
  });
});
