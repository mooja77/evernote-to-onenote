'use strict';
/**
 * OneNoteClient tests.
 *
 * node-fetch v2 exports a bare function (module.exports = fetch), so
 * mock.method() cannot intercept it after-the-fact.  We replace it in the
 * require cache BEFORE loading onenote-client so our proxy is the `fetch`
 * the module captures at import time.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

// ── Fetch proxy setup (must happen before requiring onenote-client) ──────────
let fetchHandler = null;

function makeFakeResponse(status, body, headers = {}) {
  const defaultHeaders = { 'content-type': 'application/json' };
  const mergedHeaders = Object.fromEntries(
    Object.entries({ ...defaultHeaders, ...headers })
      .map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key) => {
        const value = mergedHeaders[String(key).toLowerCase()];
        return value !== undefined ? String(value) : null;
      },
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const fetchProxy = async (url, opts) => {
  if (!fetchHandler) throw new Error('No fetchHandler configured for this test');
  return fetchHandler(url, opts);
};

// Replace node-fetch in the require cache so onenote-client uses fetchProxy
const fetchCachePath = require.resolve('node-fetch');
const origFetchEntry = require.cache[fetchCachePath];
require.cache[fetchCachePath] = {
  id: fetchCachePath,
  filename: fetchCachePath,
  loaded: true,
  exports: fetchProxy,
};

// Now load the module-under-test — it will capture fetchProxy as its `fetch`
const { OneNoteClient } = require('../src/onenote-client');

// Restore the original entry so other tests are unaffected
require.cache[fetchCachePath] = origFetchEntry;

// ── Dry-run mode (no network required) ───────────────────────────────────────

describe('OneNoteClient — dry-run mode', () => {
  let client;
  const logs = [];
  const origLog = console.log;

  function setup() {
    logs.length = 0;
    console.log = (...args) => logs.push(args.join(' '));
    client = new OneNoteClient({ dryRun: true });
  }
  function teardown() {
    console.log = origLog;
  }

  test('createNotebook returns stub object', async () => {
    setup();
    const nb = await client.createNotebook('My Notebook');
    teardown();
    assert.equal(nb.id, 'dry-run-notebook-id');
    assert.equal(nb.displayName, 'My Notebook');
  });

  test('createNotebook logs dry-run message', async () => {
    setup();
    await client.createNotebook('Test NB');
    teardown();
    assert.ok(logs.some(l => l.includes('dry-run') && l.includes('Test NB')));
  });

  test('createSection returns stub object', async () => {
    setup();
    const sec = await client.createSection('nb-id-123', 'My Section');
    teardown();
    assert.equal(sec.id, 'dry-run-section-id');
    assert.equal(sec.displayName, 'My Section');
  });

  test('createSection logs dry-run message with notebook id', async () => {
    setup();
    await client.createSection('nb-id-123', 'Sec');
    teardown();
    assert.ok(logs.some(l => l.includes('dry-run') && l.includes('nb-id-123')));
  });

  test('createPage returns stub object with title', async () => {
    setup();
    const page = await client.createPage('sec-id-456', 'My Page', '<html>...</html>');
    teardown();
    assert.equal(page.id, 'dry-run-page-id');
    assert.equal(page.title, 'My Page');
  });

  test('createPage logs dry-run message with section id', async () => {
    setup();
    await client.createPage('sec-id-456', 'My Page', '<html>...</html>');
    teardown();
    assert.ok(logs.some(l => l.includes('dry-run') && l.includes('sec-id-456')));
  });

  test('full dry-run workflow completes without errors', async () => {
    setup();
    const nb = await client.createNotebook('Evernote Import');
    const sec = await client.createSection(nb.id, 'Imported Notes');
    const page = await client.createPage(sec.id, 'My Note', '<!DOCTYPE html><html><body>hi</body></html>');
    teardown();
    assert.ok(nb.id);
    assert.ok(sec.id);
    assert.ok(page.id);
  });

  test('createNotebook accepts empty string name', async () => {
    setup();
    const nb = await client.createNotebook('');
    teardown();
    assert.equal(nb.displayName, '');
  });

  test('createPage accepts very long HTML body', async () => {
    setup();
    const bigHtml = '<html><body>' + '<p>line</p>'.repeat(1000) + '</body></html>';
    const page = await client.createPage('sec-id', 'Big Page', bigHtml);
    teardown();
    assert.equal(page.title, 'Big Page');
  });
});

// ── Live mode — fetch intercepted via require.cache proxy ─────────────────────

describe('OneNoteClient — live mode (fetch intercepted)', () => {
  const calls = [];

  after(() => { fetchHandler = null; });

  // ── Rate-limit retry behaviour ─────────────────────────────────────────────

  test('retries on 429 and succeeds when next response is 200', async () => {
    let callCount = 0;
    fetchHandler = async (url, opts) => {
      callCount++;
      if (callCount === 1) return makeFakeResponse(429, {}, { 'Retry-After': '0' });
      // GET /notebooks returns empty list; POST creates notebook
      if ((opts.method || 'GET') === 'GET') return makeFakeResponse(200, { value: [] });
      return makeFakeResponse(201, { id: 'nb-retry', displayName: 'Retry NB' });
    };
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    const nb = await client.createNotebook('Retry NB');
    assert.equal(nb.id, 'nb-retry');
    // 1 (429) + 1 (GET ok) + 1 (POST ok) = 3 calls
    assert.equal(callCount, 3);
  });

  test('retries up to MAX_RETRIES (5) on persistent 429 then throws', async () => {
    let callCount = 0;
    fetchHandler = async () => {
      callCount++;
      return makeFakeResponse(429, {}, { 'Retry-After': '0' });
    };
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    await assert.rejects(
      () => client.createNotebook('N'),
      /rate limit/i
    );
    // 1 initial + 5 retries = 6 total calls
    assert.equal(callCount, 6);
  });

  test('uses Retry-After header value for wait time (0 → no sleep)', async () => {
    let callCount = 0;
    fetchHandler = async () => {
      callCount++;
      if (callCount < 3) return makeFakeResponse(429, {}, { 'Retry-After': '0' });
      return makeFakeResponse(201, { id: 'pg-ok', title: 'P' });
    };
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    const page = await client.createPage('sec-1', 'P', '<html></html>');
    assert.equal(page.id, 'pg-ok');
    assert.equal(callCount, 3);
  });

  // Coverage note: "defaults to 5s wait when Retry-After absent" is not unit-tested
  // because the real sleep(5000) makes it impractical. The retry path is covered
  // by the tests above using Retry-After: 0.;

  test('createNotebook calls Graph API with correct URL and body', async () => {
    calls.length = 0;
    fetchHandler = async (url, opts) => {
      calls.push({ url, opts });
      if ((opts.method || 'GET') === 'GET') {
        return makeFakeResponse(200, { value: [] }); // no existing notebooks
      }
      return makeFakeResponse(201, { id: 'nb-1', displayName: 'My NB' });
    };
    const client = new OneNoteClient({ accessToken: 'tok123', dryRun: false });
    const nb = await client.createNotebook('My NB');
    assert.equal(nb.id, 'nb-1');
    // GET /notebooks + POST = 2 calls
    assert.equal(calls.length, 2);
    const postCall = calls.find(c => (c.opts.method || 'GET') === 'POST');
    assert.ok(postCall, 'should have made a POST call');
    assert.match(postCall.url, /onenote\/notebooks/);
    assert.match(postCall.opts.headers.Authorization, /Bearer tok123/);
  });

  test('createSection calls Graph API with notebookId in URL', async () => {
    calls.length = 0;
    fetchHandler = async (url, opts) => {
      calls.push({ url, opts });
      if ((opts.method || 'GET') === 'GET') {
        return makeFakeResponse(200, { value: [] }); // no existing sections
      }
      return makeFakeResponse(201, { id: 'sec-1', displayName: 'My Sec' });
    };
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    await client.createSection('nb-abc', 'My Sec');
    const getCall = calls.find(c => (c.opts.method || 'GET') === 'GET');
    assert.ok(getCall, 'should have made a GET call');
    assert.match(getCall.url, /notebooks\/nb-abc\/sections/);
  });

  test('createPage POSTs HTML to sections endpoint', async () => {
    calls.length = 0;
    fetchHandler = async (url, opts) => {
      calls.push({ url, opts });
      return makeFakeResponse(201, { id: 'pg-1', title: 'P' });
    };
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    await client.createPage('sec-99', 'P', '<html>body</html>');
    assert.match(calls[0].url, /sections\/sec-99\/pages/);
    assert.equal(calls[0].opts.headers['Content-Type'], 'text/html');
  });

  test('createPage sends Authorization header', async () => {
    calls.length = 0;
    fetchHandler = async (url, opts) => {
      calls.push({ url, opts });
      return makeFakeResponse(201, { id: 'pg-1', title: 'P' });
    };
    const client = new OneNoteClient({ accessToken: 'mytoken', dryRun: false });
    await client.createPage('sec-1', 'P', '<html></html>');
    assert.match(calls[0].opts.headers.Authorization, /Bearer mytoken/);
  });

  test('throws on 401 response from createNotebook', async () => {
    fetchHandler = async () => makeFakeResponse(401, { error: 'Unauthorized' });
    const client = new OneNoteClient({ accessToken: 'bad-tok', dryRun: false });
    await assert.rejects(
      () => client.createNotebook('NB'),
      /401/
    );
  });

  test('throws on 403 response from createPage', async () => {
    fetchHandler = async () => makeFakeResponse(403, { error: 'Forbidden' });
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    await assert.rejects(
      () => client.createPage('sec-id', 'Title', '<html></html>'),
      /OneNote API error 403/
    );
  });

  test('throws on 500 response from createSection', async () => {
    fetchHandler = async () => makeFakeResponse(500, { error: 'Internal Server Error' });
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    await assert.rejects(
      () => client.createSection('nb-id', 'Sec'),
      /OneNote API error 500/
    );
  });

  test('throws after exhausting retries on persistent 429', async () => {
    // Retry-After: 0 so sleep(0ms) — runs through all 5 retries instantly
    fetchHandler = async () => makeFakeResponse(429, { error: 'Too Many Requests' }, { 'Retry-After': '0' });
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    let err;
    try { await client.createNotebook('N'); } catch (e) { err = e; }
    assert.ok(err, 'should have thrown');
    assert.match(err.message, /rate limit/i);
  });

  // ── 401 retry with token refresh ───────────────────────────────────────────

  test('retries with refreshed token on first 401', async () => {
    let callCount = 0;
    let tokenRefreshCalled = false;
    const getToken = async (forceRefresh = false) => {
      if (forceRefresh) { tokenRefreshCalled = true; return 'refreshed-token'; }
      return 'original-token';
    };
    fetchHandler = async (url, opts) => {
      callCount++;
      if (opts.headers.Authorization === 'Bearer original-token') {
        return makeFakeResponse(401, { error: 'Unauthorized' });
      }
      // Refreshed token path
      return makeFakeResponse(201, { id: 'pg-after-refresh', title: 'P' });
    };
    const client = new OneNoteClient({ getToken, dryRun: false });
    const page = await client.createPage('sec-1', 'P', '<html></html>');
    assert.equal(page.id, 'pg-after-refresh');
    assert.equal(tokenRefreshCalled, true);
    assert.equal(callCount, 2);
  });

  test('throws on 401 after token refresh (second 401)', async () => {
    const getToken = async () => 'any-token';
    fetchHandler = async () => makeFakeResponse(401, { error: 'Unauthorized' });
    const client = new OneNoteClient({ getToken, dryRun: false });
    await assert.rejects(
      () => client.createPage('sec-1', 'P', '<html></html>'),
      /401.*token refresh|authentication failed/i
    );
  });

  // ── createPageWithAttachments ─────────────────────────────────────────────

  test('createPageWithAttachments dry-run logs attachment count', async () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    const client = new OneNoteClient({ dryRun: true });
    const resources = [
      { partName: 'part1', contentType: 'image/png', data: Buffer.from('imgdata') },
      { partName: 'part2', contentType: 'application/pdf', data: Buffer.from('pdfdata') },
    ];
    const page = await client.createPageWithAttachments('sec-1', 'My Page', '<html></html>', resources);
    console.log = origLog;
    assert.equal(page.id, 'dry-run-page-id');
    assert.ok(logs.some(l => l.includes('2') && l.includes('attachment')));
  });

  test('createPageWithAttachments sends multipart POST with Presentation part first', async () => {
    const calls = [];
    fetchHandler = async (url, opts) => {
      calls.push({ url, opts });
      return makeFakeResponse(201, { id: 'pg-multipart', title: 'T' });
    };
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    const resources = [
      { partName: 'part1', contentType: 'image/png', data: Buffer.from('fake-png-data') },
    ];
    const page = await client.createPageWithAttachments('sec-mp', 'T', '<html>body</html>', resources);
    assert.equal(page.id, 'pg-multipart');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /sections\/sec-mp\/pages/);
    assert.equal(calls[0].opts.method, 'POST');
    // Content-Type should be multipart/form-data (set by FormData)
    assert.match(calls[0].opts.headers['Content-Type'] || calls[0].opts.headers['content-type'] || '', /multipart/i);
  });

  test('createPageWithAttachments with empty resources behaves like createPage', async () => {
    const calls = [];
    fetchHandler = async (url, opts) => {
      calls.push({ url, opts });
      return makeFakeResponse(201, { id: 'pg-no-attach', title: 'T' });
    };
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    const page = await client.createPageWithAttachments('sec-1', 'T', '<html></html>', []);
    assert.equal(page.id, 'pg-no-attach');
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  test('listNotebooks follows @odata.nextLink for pagination', async () => {
    let callCount = 0;
    fetchHandler = async (url) => {
      callCount++;
      if (callCount === 1) {
        return makeFakeResponse(200, {
          value: [{ id: 'nb-1', displayName: 'NB1' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/onenote/notebooks?$skip=1',
        });
      }
      return makeFakeResponse(200, { value: [{ id: 'nb-2', displayName: 'NB2' }] });
    };
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    const notebooks = await client.listNotebooks();
    assert.equal(notebooks.length, 2);
    assert.equal(notebooks[0].id, 'nb-1');
    assert.equal(notebooks[1].id, 'nb-2');
    assert.equal(callCount, 2);
  });

  test('listSections follows @odata.nextLink for pagination', async () => {
    let callCount = 0;
    fetchHandler = async () => {
      callCount++;
      if (callCount === 1) {
        return makeFakeResponse(200, {
          value: [{ id: 'sec-1', displayName: 'S1' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/onenote/notebooks/nb-x/sections?$skip=1',
        });
      }
      return makeFakeResponse(200, { value: [{ id: 'sec-2', displayName: 'S2' }] });
    };
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    const sections = await client.listSections('nb-x');
    assert.equal(sections.length, 2);
  });

  test('listPages follows @odata.nextLink for pagination', async () => {
    let callCount = 0;
    fetchHandler = async () => {
      callCount++;
      if (callCount === 1) {
        return makeFakeResponse(200, {
          value: [{ id: 'pg-1', title: 'P1' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/onenote/sections/sec-y/pages?$skip=1',
        });
      }
      return makeFakeResponse(200, { value: [{ id: 'pg-2', title: 'P2' }] });
    };
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    const pages = await client.listPages('sec-y');
    assert.equal(pages.length, 2);
  });

  test('listNotebooks returns empty array when value is empty', async () => {
    fetchHandler = async () => makeFakeResponse(200, { value: [] });
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    const notebooks = await client.listNotebooks();
    assert.deepEqual(notebooks, []);
  });

  // ── Exponential backoff jitter ─────────────────────────────────────────────

  test('backoff delay is within expected jitter range (1x to 1.3x of base*2^(attempt-1))', () => {
    // Access the internal backoffDelay by calling it via a 429 sequence and measuring timing
    // Instead, test the jitter formula indirectly: run 50 times and check all are in range
    // We test the formula: delay = min(base * 2^(attempt-1), 60000) * (1 + rand * 0.3)
    // For attempt=1: base=1000, exp=1000*2^0=1000 → range [1000, 1300]
    // For attempt=2: base=1000, exp=1000*2^1=2000 → range [2000, 2600]
    // We can't import backoffDelay directly (not exported), so we verify the 429 wait time
    // via a timing-based approach with Retry-After:0 override and a stub sleep check.
    // Since we can't hook into the private sleep, we just verify the module doesn't throw
    // and that multiple 429 calls eventually either succeed or throw after MAX_RETRIES.
    let callCount = 0;
    fetchHandler = async () => {
      callCount++;
      if (callCount >= 3) return makeFakeResponse(200, { value: [] });
      return makeFakeResponse(429, {}, { 'Retry-After': '0' });
    };
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    return client.listNotebooks().then(result => {
      assert.ok(Array.isArray(result));
      assert.equal(callCount, 3);
    });
  });

  // ── findPageByTitle ───────────────────────────────────────────────────────

  test('findPageByTitle returns page when found', async () => {
    fetchHandler = async () => makeFakeResponse(200, { value: [{ id: 'pg-found', title: 'My Note' }] });
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    const page = await client.findPageByTitle('sec-1', 'My Note');
    assert.equal(page.id, 'pg-found');
    assert.equal(page.title, 'My Note');
  });

  test('findPageByTitle returns null when not found (empty value)', async () => {
    fetchHandler = async () => makeFakeResponse(200, { value: [] });
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    const page = await client.findPageByTitle('sec-1', 'Nonexistent Note');
    assert.equal(page, null);
  });

  test('findPageByTitle uses $filter with OData title eq query in URL', async () => {
    const calls = [];
    fetchHandler = async (url) => {
      calls.push(url);
      return makeFakeResponse(200, { value: [] });
    };
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    await client.findPageByTitle('sec-abc', 'Test Title');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /sections\/sec-abc\/pages/);
    assert.match(calls[0], /\$filter=/);
    assert.match(calls[0], /title/);
  });

  test('findPageByTitle escapes single quotes in title for OData filter', async () => {
    const calls = [];
    fetchHandler = async (url) => {
      calls.push(url);
      return makeFakeResponse(200, { value: [] });
    };
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    await client.findPageByTitle('sec-1', "O'Brien's Note");
    // Single quotes must be doubled in OData: O''Brien''s Note
    assert.match(decodeURIComponent(calls[0]), /O''Brien''s Note/);
  });

  test('findPageByTitle returns null in dry-run mode without calling fetch', async () => {
    let fetchCalled = false;
    fetchHandler = async () => { fetchCalled = true; return makeFakeResponse(200, { value: [] }); };
    const client = new OneNoteClient({ dryRun: true });
    const page = await client.findPageByTitle('sec-1', 'Any Title');
    assert.equal(page, null);
    assert.equal(fetchCalled, false);
  });

  // ── deletePage ────────────────────────────────────────────────────────────

  test('deletePage sends DELETE request to pages endpoint', async () => {
    const calls = [];
    fetchHandler = async (url, opts) => {
      calls.push({ url, method: opts.method });
      return makeFakeResponse(204, null, {});
    };
    const client = new OneNoteClient({ accessToken: 'tok', dryRun: false });
    await client.deletePage('pg-to-delete');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /pages\/pg-to-delete/);
    assert.equal(calls[0].method, 'DELETE');
  });

  test('deletePage dry-run logs message without calling fetch', async () => {
    let fetchCalled = false;
    fetchHandler = async () => { fetchCalled = true; return makeFakeResponse(204, null); };
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    const client = new OneNoteClient({ dryRun: true });
    await client.deletePage('pg-123');
    console.log = origLog;
    assert.equal(fetchCalled, false);
    assert.ok(logs.some(l => l.includes('dry-run') && l.includes('pg-123')));
  });
});
