'use strict';
/**
 * Reliability hardening tests — four failure modes:
 *   (a) auth.js: invalid_grant triggers device-code re-auth without losing state
 *   (b) onenote-client.js: 409 retried with jitter
 *   (c) enex-parser.js: corrupt note is skipped, valid notes returned
 *   (d) onenote-client.js: 507 emits a clear OneDrive quota error
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Shared fetch proxy (installed once, all onenote-client tests share it) ───
let fetchHandler = null;
const fetchProxy = async (url, opts) => {
  if (!fetchHandler) throw new Error('No fetchHandler configured for this test');
  return fetchHandler(url, opts);
};

const fetchCachePath = require.resolve('node-fetch');
const origFetchEntry = require.cache[fetchCachePath];
require.cache[fetchCachePath] = {
  id: fetchCachePath, filename: fetchCachePath, loaded: true, exports: fetchProxy,
};
const { OneNoteClient } = require('../src/onenote-client');
require.cache[fetchCachePath] = origFetchEntry;

function makeResponse(status, body = {}, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => ({ 'content-type': 'application/json', ...headers })[k] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ── (a) auth.js — invalid_grant re-auth ──────────────────────────────────────

describe('auth — invalid_grant triggers device-code re-auth', () => {
  const msalCachePath = require.resolve('@azure/msal-node');

  function buildFakeMsal({ silentError, deviceToken = 'fresh-device-token' } = {}) {
    class FakeTokenCache {
      getAllAccounts() { return Promise.resolve([{ homeAccountId: 'acct-1' }]); }
      deserialize() {}
      serialize() { return '{}'; }
    }
    class FakePublicClientApplication {
      constructor() { this._cache = new FakeTokenCache(); }
      getTokenCache() { return this._cache; }
      acquireTokenSilent() { return Promise.reject(silentError); }
      acquireTokenByDeviceCode({ deviceCodeCallback }) {
        deviceCodeCallback({ message: 'Visit https://microsoft.com/devicelogin' });
        return Promise.resolve({ accessToken: deviceToken });
      }
    }
    return { PublicClientApplication: FakePublicClientApplication };
  }

  function installFakeMsal(fake) {
    require.cache[msalCachePath] = {
      id: msalCachePath, filename: msalCachePath, loaded: true, exports: fake,
    };
    delete require.cache[require.resolve('../src/auth')];
  }

  function restoreMsal(origEntry) {
    require.cache[msalCachePath] = origEntry;
    delete require.cache[require.resolve('../src/auth')];
  }

  test('InteractionRequiredAuthError falls back to device-code', async () => {
    const origEntry = require.cache[msalCachePath];
    const silentError = Object.assign(new Error('interaction required'), {
      name: 'InteractionRequiredAuthError',
    });
    installFakeMsal(buildFakeMsal({ silentError, deviceToken: 'recovered-token' }));
    try {
      const auth = require('../src/auth');
      const token = await auth.getAuthenticatedToken();
      assert.equal(token, 'recovered-token');
    } finally {
      restoreMsal(origEntry);
    }
  });

  test('err.errorCode invalid_grant falls back to device-code', async () => {
    const origEntry = require.cache[msalCachePath];
    const silentError = Object.assign(new Error('token expired'), {
      name: 'ServerError',
      errorCode: 'invalid_grant',
    });
    installFakeMsal(buildFakeMsal({ silentError, deviceToken: 'refreshed-token' }));
    try {
      const auth = require('../src/auth');
      const token = await auth.getAuthenticatedToken();
      assert.equal(token, 'refreshed-token');
    } finally {
      restoreMsal(origEntry);
    }
  });

  test('err.error invalid_grant falls back to device-code', async () => {
    const origEntry = require.cache[msalCachePath];
    const silentError = Object.assign(new Error('oauth error'), {
      name: 'OAuthError',
      error: 'invalid_grant',
    });
    installFakeMsal(buildFakeMsal({ silentError, deviceToken: 'token-via-error-field' }));
    try {
      const auth = require('../src/auth');
      const token = await auth.getAuthenticatedToken();
      assert.equal(token, 'token-via-error-field');
    } finally {
      restoreMsal(origEntry);
    }
  });

  test('message containing invalid_grant falls back to device-code', async () => {
    const origEntry = require.cache[msalCachePath];
    const silentError = new Error('invalid_grant: token expired or revoked');
    silentError.name = 'TokenError';
    installFakeMsal(buildFakeMsal({ silentError, deviceToken: 'message-matched-token' }));
    try {
      const auth = require('../src/auth');
      const token = await auth.getAuthenticatedToken();
      assert.equal(token, 'message-matched-token');
    } finally {
      restoreMsal(origEntry);
    }
  });

  test('noInteractive=true throws descriptive error instead of hanging', async () => {
    const origEntry = require.cache[msalCachePath];
    const silentError = Object.assign(new Error('interaction required'), {
      name: 'InteractionRequiredAuthError',
    });
    installFakeMsal(buildFakeMsal({ silentError }));
    try {
      const auth = require('../src/auth');
      await assert.rejects(
        () => auth.getAuthenticatedToken({ noInteractive: true }),
        /evernote-to-onenote --auth/
      );
    } finally {
      restoreMsal(origEntry);
    }
  });
});

// ── (b) onenote-client.js — 409 conflict retry ───────────────────────────────

describe('OneNoteClient — 409 conflict retry', () => {
  test('409 response is retried and eventually succeeds', async () => {
    let calls = 0;
    fetchHandler = async () => {
      calls++;
      if (calls < 3) return makeResponse(409);
      return makeResponse(201, { id: 'page-1', title: 'Test' });
    };
    const client = new OneNoteClient({ accessToken: 'tok' });
    const page = await client.createPage('sec-1', 'Test', '<html>test</html>');
    assert.equal(page.id, 'page-1');
    assert.equal(calls, 3);
  });

  test('409 after MAX_RETRIES throws with conflict message', async () => {
    fetchHandler = async () => makeResponse(409, { error: 'conflict' });
    const client = new OneNoteClient({ accessToken: 'tok' });
    await assert.rejects(
      () => client.createPage('sec-1', 'Test', '<html>test</html>'),
      /409/
    );
  });
});

// ── (c) enex-parser.js — per-note error isolation ────────────────────────────

describe('enex-parser — per-note error isolation', () => {
  const xml2jsCachePath = require.resolve('xml2js');

  function installFakeXml2js(notes) {
    const orig = require.cache[xml2jsCachePath];
    require.cache[xml2jsCachePath] = {
      id: xml2jsCachePath, filename: xml2jsCachePath, loaded: true,
      exports: {
        Parser: class {
          parseStringPromise() {
            return Promise.resolve({ 'en-export': { note: notes } });
          }
        },
      },
    };
    delete require.cache[require.resolve('../src/enex-parser')];
    return orig;
  }

  function restoreXml2js(orig) {
    require.cache[xml2jsCachePath] = orig;
    delete require.cache[require.resolve('../src/enex-parser')];
  }

  test('valid notes before/after corrupt note are returned', async () => {
    const corruptNote = {};
    Object.defineProperty(corruptNote, 'title', {
      get() { throw new Error('simulated corrupt property'); },
      enumerable: true,
    });

    const orig = installFakeXml2js([
      { title: 'Good Note A', content: '<en-note>A</en-note>', tag: [], resource: null, created: null, updated: null, 'note-attributes': null },
      corruptNote,
      { title: 'Good Note B', content: '<en-note>B</en-note>', tag: [], resource: null, created: null, updated: null, 'note-attributes': null },
    ]);

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    const tmp = path.join(os.tmpdir(), `reliability-test-${Date.now()}.enex`);
    fs.writeFileSync(tmp, '<en-export></en-export>');

    try {
      const { parseEnexFile } = require('../src/enex-parser');
      const notes = await parseEnexFile(tmp);

      assert.equal(notes.length, 2, 'two valid notes should be returned');
      assert.equal(notes[0].title, 'Good Note A');
      assert.equal(notes[1].title, 'Good Note B');
      assert.ok(
        warnings.some(w => w.includes('Skipping corrupt')),
        'should emit a warning for the corrupt note'
      );
    } finally {
      console.warn = origWarn;
      fs.unlinkSync(tmp);
      restoreXml2js(orig);
    }
  });

  test('single corrupt note returns empty array, not a throw', async () => {
    const corruptNote = {};
    Object.defineProperty(corruptNote, 'title', {
      get() { throw new Error('corrupt'); },
      enumerable: true,
    });

    const orig = installFakeXml2js([corruptNote]);
    const origWarn = console.warn;
    console.warn = () => {};
    const tmp = path.join(os.tmpdir(), `reliability-test2-${Date.now()}.enex`);
    fs.writeFileSync(tmp, '<en-export></en-export>');

    try {
      const { parseEnexFile } = require('../src/enex-parser');
      const notes = await parseEnexFile(tmp);
      assert.equal(notes.length, 0);
    } finally {
      console.warn = origWarn;
      fs.unlinkSync(tmp);
      restoreXml2js(orig);
    }
  });

  test('all valid notes still work when no corruption', async () => {
    const orig = installFakeXml2js([
      { title: 'Note 1', content: '<en-note>1</en-note>', tag: [], resource: null, created: null, updated: null, 'note-attributes': null },
      { title: 'Note 2', content: '<en-note>2</en-note>', tag: [], resource: null, created: null, updated: null, 'note-attributes': null },
    ]);
    const tmp = path.join(os.tmpdir(), `reliability-test3-${Date.now()}.enex`);
    fs.writeFileSync(tmp, '<en-export></en-export>');

    try {
      const { parseEnexFile } = require('../src/enex-parser');
      const notes = await parseEnexFile(tmp);
      assert.equal(notes.length, 2);
      assert.equal(notes[0].title, 'Note 1');
      assert.equal(notes[1].title, 'Note 2');
    } finally {
      fs.unlinkSync(tmp);
      restoreXml2js(orig);
    }
  });
});

// ── (d) onenote-client.js — 507 OneDrive quota ───────────────────────────────

describe('OneNoteClient — 507 OneDrive storage full', () => {
  test('507 throws OneDrive storage full error', async () => {
    fetchHandler = async () => makeResponse(507);
    const client = new OneNoteClient({ accessToken: 'tok' });
    await assert.rejects(
      () => client.createPage('sec-1', 'Test', '<html>test</html>'),
      /OneDrive storage full/
    );
  });

  test('507 error message includes actionable guidance', async () => {
    fetchHandler = async () => makeResponse(507);
    const client = new OneNoteClient({ accessToken: 'tok' });
    let caught;
    try {
      await client.createPage('sec-1', 'Test', '<html>test</html>');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'should have thrown');
    assert.match(caught.message, /onedrive\.live\.com/i);
    assert.match(caught.message, /--resume/);
  });

  test('507 is not retried (immediate fail)', async () => {
    let calls = 0;
    fetchHandler = async () => { calls++; return makeResponse(507); };
    const client = new OneNoteClient({ accessToken: 'tok' });
    await assert.rejects(() => client.createPage('sec-1', 'Test', '<html>t</html>'));
    assert.equal(calls, 1, '507 should not be retried');
  });

  test('503 with Retry-After header uses header value', async () => {
    let calls = 0;
    fetchHandler = async () => {
      calls++;
      if (calls === 1) return makeResponse(503, {}, { 'Retry-After': '1' });
      return makeResponse(201, { id: 'p', title: 'T' });
    };
    const client = new OneNoteClient({ accessToken: 'tok' });
    const page = await client.createPage('sec-1', 'T', '<html>t</html>');
    assert.equal(page.id, 'p');
    assert.equal(calls, 2);
  });
});
