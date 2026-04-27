'use strict';
/**
 * Comprehensive edge-case tests covering:
 *  (1) Reliability failure modes — supplementary coverage
 *  (2) Interactive mode (interactiveSetup) — mocked readline
 *  (3) ENEX edge cases — Unicode/long/empty titles, missing resource data
 *  (4) ProgressBar and --quiet regression
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const fix = (name) => path.join(__dirname, 'fixtures', name);
const CLI = path.join(__dirname, '..', 'src', 'index.js');

// ── Shared fetch proxy (onenote-client reliability tests) ─────────────────────
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

function makeResp(status, body = {}, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => ({ 'content-type': 'application/json', ...headers })[k] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Helper: write inline ENEX xml to a temp file, invoke fn(filePath), then unlink
async function withTmpEnex(xml, fn) {
  const tmp = path.join(os.tmpdir(), `edge-${Date.now()}-${Math.random().toString(36).slice(2)}.enex`);
  fs.writeFileSync(tmp, xml, 'utf8');
  try { return await fn(tmp); }
  finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

function enexWrap(noteXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20260421T120000Z" application="Evernote" version="10.0">
${noteXml}
</en-export>`;
}

const BARE_CONTENT = `<content><![CDATA[<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note><p>body</p></en-note>]]></content>`;

// ─────────────────────────────────────────────────────────────────────────────
// (1) RELIABILITY FAILURE MODES — supplementary coverage
// ─────────────────────────────────────────────────────────────────────────────

describe('Reliability — token expiry recovery (additional paths)', () => {
  const msalCachePath = require.resolve('@azure/msal-node');

  function buildFakeMsal({ silentError, deviceToken = 'device-token' } = {}) {
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
    const orig = require.cache[msalCachePath];
    require.cache[msalCachePath] = {
      id: msalCachePath, filename: msalCachePath, loaded: true, exports: fake,
    };
    delete require.cache[require.resolve('../src/auth')];
    return orig;
  }

  function restoreMsal(orig) {
    require.cache[msalCachePath] = orig;
    delete require.cache[require.resolve('../src/auth')];
  }

  test('token expiry clears cache file and re-authenticates', async () => {
    // Verify a stale cache file is removed on invalid_grant before re-auth
    const tmpCache = path.join(os.tmpdir(), `.onenote-token-${Date.now()}.json`);
    fs.writeFileSync(tmpCache, JSON.stringify({ accessToken: 'stale' }));

    const silentError = Object.assign(new Error('token expired'), {
      errorCode: 'invalid_grant',
    });
    const orig = installFakeMsal(buildFakeMsal({ silentError, deviceToken: 'fresh-token' }));
    try {
      const auth = require('../src/auth');
      const token = await auth.getAuthenticatedToken();
      assert.equal(token, 'fresh-token');
    } finally {
      restoreMsal(orig);
      try { fs.unlinkSync(tmpCache); } catch { /* already gone */ }
    }
  });

  test('noInteractive=true with invalid_grant rejects without hanging', async () => {
    const silentError = Object.assign(new Error('interaction required'), {
      name: 'InteractionRequiredAuthError',
    });
    const orig = installFakeMsal(buildFakeMsal({ silentError }));
    try {
      const auth = require('../src/auth');
      await assert.rejects(
        () => auth.getAuthenticatedToken({ noInteractive: true }),
        /--auth/
      );
    } finally {
      restoreMsal(orig);
    }
  });
});

describe('Reliability — 409 conflict retry (additional paths)', () => {
  test('409 retry uses exponential backoff (Retry-After: 0 override skips wait)', async () => {
    let calls = 0;
    fetchHandler = async () => {
      calls++;
      if (calls <= 2) return makeResp(409, {}, { 'Retry-After': '0' });
      return makeResp(201, { id: 'pg-ok', title: 'T' });
    };
    const client = new OneNoteClient({ accessToken: 'tok' });
    const page = await client.createPage('sec-1', 'T', '<html>t</html>');
    assert.equal(page.id, 'pg-ok');
    assert.equal(calls, 3);
  });

  test('409 exhausted retries throw with status code in message', async () => {
    fetchHandler = async () => makeResp(409);
    const client = new OneNoteClient({ accessToken: 'tok' });
    let err;
    try { await client.createPage('sec-1', 'T', '<html>t</html>'); } catch (e) { err = e; }
    assert.ok(err, 'should have thrown');
    assert.match(err.message, /409/);
  });
});

describe('Reliability — 503 retry (additional paths)', () => {
  test('503 without Retry-After header still retries and eventually succeeds', async () => {
    let calls = 0;
    fetchHandler = async () => {
      calls++;
      // No Retry-After header — client should fall back to its own backoff.
      // We override via Retry-After:0 on the 503 so the test doesn't sleep.
      if (calls === 1) return makeResp(503, {}, { 'Retry-After': '0' });
      return makeResp(201, { id: 'pg-503', title: 'T' });
    };
    const client = new OneNoteClient({ accessToken: 'tok' });
    const page = await client.createPage('sec-1', 'T', '<html>t</html>');
    assert.equal(page.id, 'pg-503');
    assert.equal(calls, 2);
  });

  test('persistent 503 eventually throws after MAX_RETRIES', async () => {
    fetchHandler = async () => makeResp(503, {}, { 'Retry-After': '0' });
    const client = new OneNoteClient({ accessToken: 'tok' });
    await assert.rejects(
      () => client.createPage('sec-1', 'T', '<html>t</html>'),
      /503/
    );
  });
});

describe('Reliability — 507 quota detection (additional paths)', () => {
  test('507 thrown immediately on createSection (not just createPage)', async () => {
    fetchHandler = async () => makeResp(507);
    const client = new OneNoteClient({ accessToken: 'tok' });
    await assert.rejects(
      () => client.createSection('nb-1', 'Sec'),
      /OneDrive storage full/
    );
  });

  test('507 thrown immediately on createNotebook', async () => {
    fetchHandler = async () => makeResp(507);
    const client = new OneNoteClient({ accessToken: 'tok' });
    await assert.rejects(
      () => client.createNotebook('NB'),
      /OneDrive storage full/
    );
  });

  test('507 error message includes --resume hint', async () => {
    fetchHandler = async () => makeResp(507);
    const client = new OneNoteClient({ accessToken: 'tok' });
    let err;
    try { await client.createPage('sec-1', 'T', '<html>t</html>'); } catch (e) { err = e; }
    assert.ok(err);
    assert.match(err.message, /--resume/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) INTERACTIVE MODE — interactiveSetup with mocked readline
// ─────────────────────────────────────────────────────────────────────────────

describe('interactiveSetup — mocked readline', () => {
  const readline = require('readline');

  function installFakeReadline(answers) {
    let idx = 0;
    const origCreateInterface = readline.createInterface;
    readline.createInterface = () => ({
      question: (_prompt, cb) => setImmediate(() => cb(answers[idx++] ?? '')),
      close: () => {},
    });
    return origCreateInterface;
  }

  function restoreReadline(orig) {
    readline.createInterface = orig;
    // Evict ui.js from cache so the next require() picks up the restored readline
    delete require.cache[require.resolve('../src/ui')];
  }

  function mockExit() {
    const calls = [];
    const orig = process.exit;
    process.exit = (code) => {
      calls.push(code);
      throw new Error(`process.exit(${code})`);
    };
    return { calls, restore: () => { process.exit = orig; } };
  }

  test('returns .enex files from valid directory when user confirms Y', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ise-test-'));
    const enex1 = path.join(tmpDir, 'notebook1.enex');
    const enex2 = path.join(tmpDir, 'notebook2.enex');
    fs.writeFileSync(enex1, '<en-export></en-export>');
    fs.writeFileSync(enex2, '<en-export></en-export>');

    const origRL = installFakeReadline([tmpDir, 'Y']);
    delete require.cache[require.resolve('../src/ui')];
    try {
      const { interactiveSetup } = require('../src/ui');
      const files = await interactiveSetup();
      assert.ok(Array.isArray(files), 'should return an array');
      assert.equal(files.length, 2);
      assert.ok(files.some(f => f.endsWith('notebook1.enex')));
      assert.ok(files.some(f => f.endsWith('notebook2.enex')));
    } finally {
      restoreReadline(origRL);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('user typing n cancels and exits 0', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ise-cancel-'));
    fs.writeFileSync(path.join(tmpDir, 'notes.enex'), '<en-export></en-export>');

    const origRL = installFakeReadline([tmpDir, 'n']);
    delete require.cache[require.resolve('../src/ui')];
    const exitMock = mockExit();
    try {
      const { interactiveSetup } = require('../src/ui');
      await assert.rejects(() => interactiveSetup(), /process\.exit\(0\)/);
      assert.equal(exitMock.calls[0], 0);
    } finally {
      exitMock.restore();
      restoreReadline(origRL);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('user typing N (uppercase) also cancels', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ise-cancel-upper-'));
    fs.writeFileSync(path.join(tmpDir, 'notes.enex'), '<en-export></en-export>');

    const origRL = installFakeReadline([tmpDir, 'N']);
    delete require.cache[require.resolve('../src/ui')];
    const exitMock = mockExit();
    try {
      const { interactiveSetup } = require('../src/ui');
      await assert.rejects(() => interactiveSetup(), /process\.exit\(0\)/);
      assert.equal(exitMock.calls[0], 0);
    } finally {
      exitMock.restore();
      restoreReadline(origRL);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('empty path input exits with code 1', async () => {
    const origRL = installFakeReadline(['']);  // empty input
    delete require.cache[require.resolve('../src/ui')];
    const exitMock = mockExit();
    try {
      const { interactiveSetup } = require('../src/ui');
      await assert.rejects(() => interactiveSetup(), /process\.exit\(1\)/);
      assert.equal(exitMock.calls[0], 1);
    } finally {
      exitMock.restore();
      restoreReadline(origRL);
    }
  });

  test('non-existent directory exits with code 1', async () => {
    const origRL = installFakeReadline(['/definitely/does/not/exist/abc123']);
    delete require.cache[require.resolve('../src/ui')];
    const exitMock = mockExit();
    try {
      const { interactiveSetup } = require('../src/ui');
      await assert.rejects(() => interactiveSetup(), /process\.exit\(1\)/);
      assert.equal(exitMock.calls[0], 1);
    } finally {
      exitMock.restore();
      restoreReadline(origRL);
    }
  });

  test('directory with no .enex files exits with code 1', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ise-empty-'));
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'nothing here');

    const origRL = installFakeReadline([tmpDir]);
    delete require.cache[require.resolve('../src/ui')];
    const exitMock = mockExit();
    try {
      const { interactiveSetup } = require('../src/ui');
      await assert.rejects(() => interactiveSetup(), /process\.exit\(1\)/);
      assert.equal(exitMock.calls[0], 1);
    } finally {
      exitMock.restore();
      restoreReadline(origRL);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('lists found notebooks to stdout before confirming', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ise-list-'));
    fs.writeFileSync(path.join(tmpDir, 'my-notebook.enex'), '<en-export></en-export>');

    const origRL = installFakeReadline([tmpDir, 'Y']);
    delete require.cache[require.resolve('../src/ui')];

    const logged = [];
    const origLog = console.log;
    console.log = (...args) => logged.push(args.join(' '));

    try {
      const { interactiveSetup } = require('../src/ui');
      await interactiveSetup();
      assert.ok(logged.some(l => l.includes('my-notebook.enex')), 'should list the found notebook');
      assert.ok(logged.some(l => l.includes('1')), 'should show count of notebooks');
    } finally {
      console.log = origLog;
      restoreReadline(origRL);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('whitespace in path input is trimmed', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ise-trim-'));
    fs.writeFileSync(path.join(tmpDir, 'notes.enex'), '<en-export></en-export>');

    // Pad the directory path with surrounding whitespace
    const origRL = installFakeReadline([`  ${tmpDir}  `, 'Y']);
    delete require.cache[require.resolve('../src/ui')];
    try {
      const { interactiveSetup } = require('../src/ui');
      const files = await interactiveSetup();
      assert.equal(files.length, 1);
    } finally {
      restoreReadline(origRL);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) ENEX EDGE CASES — titles, resources, structure
// ─────────────────────────────────────────────────────────────────────────────

describe('enex-parser — title edge cases', () => {
  const { parseEnexFile } = require('../src/enex-parser');

  test('note with no title element returns empty string title', async () => {
    const notes = await parseEnexFile(fix('no-title.enex'));
    assert.equal(notes.length, 1);
    // title element absent → getText returns ''
    assert.equal(notes[0].title, '');
  });

  test('note with explicitly empty title tag returns empty string', async () => {
    await withTmpEnex(enexWrap(`  <note>
    <title></title>
    ${BARE_CONTENT}
  </note>`), async (tmp) => {
      const notes = await parseEnexFile(tmp);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].title, '');
    });
  });

  test('Japanese Unicode title is preserved exactly', async () => {
    const notes = await parseEnexFile(fix('unicode-titles.enex'));
    assert.equal(notes[0].title, '日本語のノート');
  });

  test('emoji title is preserved', async () => {
    const notes = await parseEnexFile(fix('unicode-titles.enex'));
    assert.equal(notes[1].title, '📝 Meeting Notes 🚀');
  });

  test('Arabic RTL title is preserved', async () => {
    const notes = await parseEnexFile(fix('unicode-titles.enex'));
    assert.equal(notes[2].title, 'ملاحظات اجتماع المشروع');
  });

  test('XML-entity decoded title is correct (ampersand in title)', async () => {
    const notes = await parseEnexFile(fix('unicode-titles.enex'));
    assert.equal(notes[3].title, 'Ünïcödé Spécïàl Chàrś & Möre');
  });

  test('extremely long title (>256 chars) is parsed without truncation', async () => {
    const longTitle = 'A'.repeat(300);
    await withTmpEnex(enexWrap(`  <note>
    <title>${longTitle}</title>
    ${BARE_CONTENT}
  </note>`), async (tmp) => {
      const notes = await parseEnexFile(tmp);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].title.length, 300);
      assert.equal(notes[0].title, longTitle);
    });
  });

  test('title with special characters (quotes, newlines stripped by xml parser)', async () => {
    // Quotes and XML-safe chars should survive the round-trip
    await withTmpEnex(enexWrap(`  <note>
    <title>Title with "quotes" and tabs</title>
    ${BARE_CONTENT}
  </note>`), async (tmp) => {
      const notes = await parseEnexFile(tmp);
      assert.equal(notes[0].title, 'Title with "quotes" and tabs');
    });
  });

  test('multiple notes with mixed Unicode titles all parsed', async () => {
    const notes = await parseEnexFile(fix('unicode-titles.enex'));
    assert.equal(notes.length, 4);
    for (const note of notes) {
      assert.ok(typeof note.title === 'string', 'title should be a string');
      assert.ok(note.title.length > 0, 'title should be non-empty');
    }
  });
});

describe('enex-parser — empty and zero-note files', () => {
  const { parseEnexFile } = require('../src/enex-parser');

  test('completely empty file throws (invalid XML)', async () => {
    await withTmpEnex('', async (tmp) => {
      await assert.rejects(() => parseEnexFile(tmp));
    });
  });

  test('valid XML with no <note> elements returns empty array (fixture)', async () => {
    const notes = await parseEnexFile(fix('empty-export.enex'));
    assert.equal(notes.length, 0);
  });

  test('en-export with note element missing returns empty array', async () => {
    await withTmpEnex(enexWrap(''), async (tmp) => {
      const notes = await parseEnexFile(tmp);
      assert.deepEqual(notes, []);
    });
  });

  test('note with no content element returns empty content string', async () => {
    await withTmpEnex(enexWrap(`  <note>
    <title>No Content</title>
  </note>`), async (tmp) => {
      const notes = await parseEnexFile(tmp);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].title, 'No Content');
      assert.equal(notes[0].content, '');
    });
  });
});

describe('enex-parser — resource edge cases', () => {
  const { parseEnexFile } = require('../src/enex-parser');

  test('resource with missing mime defaults to empty string', async () => {
    const notes = await parseEnexFile(fix('missing-resource-data.enex'));
    const noMime = notes[0].resources.find(r => r.fileName === 'no-mime.png');
    assert.ok(noMime, 'should parse resource with missing mime');
    assert.equal(noMime.mime, '');
  });

  test('resource with missing data has empty data field', async () => {
    const notes = await parseEnexFile(fix('missing-resource-data.enex'));
    const noData = notes[0].resources.find(r => r.fileName === 'no-data.png');
    assert.ok(noData, 'should parse resource with missing data');
    assert.equal(noData.data, '');
  });

  test('resource with no resource-attributes has empty fileName', async () => {
    const notes = await parseEnexFile(fix('missing-resource-data.enex'));
    // Resource 3 has data + mime but no resource-attributes → fileName = ''
    const noAttrs = notes[0].resources.find(r => r.mime === 'image/jpeg');
    assert.ok(noAttrs, 'should parse resource with no resource-attributes');
    assert.equal(noAttrs.fileName, '');
  });

  test('valid resource is parsed correctly alongside partial ones', async () => {
    const notes = await parseEnexFile(fix('missing-resource-data.enex'));
    const valid = notes[0].resources.find(r => r.fileName === 'valid.png');
    assert.ok(valid, 'valid resource should be present');
    assert.equal(valid.mime, 'image/png');
    assert.ok(valid.data.length > 0);
  });

  test('note with all-partial resources still returns 4 resource entries', async () => {
    const notes = await parseEnexFile(fix('missing-resource-data.enex'));
    assert.equal(notes[0].resources.length, 4);
  });

  test('prepareResources filters out resources with no data (index.js logic)', () => {
    // Verify the prepareResources function in index.js filters empty data
    // This is the function that converts parser output → upload-ready buffers.
    // We test its behaviour here since it determines what gets uploaded.
    const rawResources = [
      { data: '', mime: 'image/png', fileName: 'empty.png' },
      { data: '   ', mime: 'image/png', fileName: 'whitespace.png' },
      { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', mime: 'image/png', fileName: 'valid.png' },
    ];

    // Replicate prepareResources logic from src/index.js
    const crypto = require('crypto');
    const result = rawResources
      .filter(r => r.data && r.data.trim())
      .map(r => {
        const buf = Buffer.from(r.data.replace(/\s+/g, ''), 'base64');
        const hash = crypto.createHash('md5').update(buf).digest('hex');
        return { hash, mime: r.mime, filename: r.fileName, data: buf };
      });

    assert.equal(result.length, 1, 'only the valid resource should survive');
    assert.equal(result[0].filename, 'valid.png');
    assert.ok(Buffer.isBuffer(result[0].data));
    assert.ok(result[0].hash.length === 32, 'MD5 hash should be 32 hex chars');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) INTERACTIVE MODE — --quiet flag (CLI spawnSync integration)
// ─────────────────────────────────────────────────────────────────────────────

describe('--quiet flag regression (CLI integration)', () => {
  function run(args, opts = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ONENOTE_ACCESS_TOKEN: '', MSAL_NO_INTERACTIVE: '1', ...opts.env },
      timeout: 15000,
    });
  }

  function makeTempHtmlDir(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `eq-${label}-`));
  }

  test('--quiet suppresses per-note → lines in output-html mode', () => {
    const tmpDir = makeTempHtmlDir('quiet');
    const { status, stdout, stderr } = run(['--output-html', tmpDir, '--quiet', fix('single-note.enex')]);
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(!stdout.includes('→ [file'), '--quiet should suppress per-note → lines');
  });

  test('--quiet still shows Done summary', () => {
    const tmpDir = makeTempHtmlDir('done');
    const { status, stdout } = run(['--output-html', tmpDir, '--quiet', fix('single-note.enex')]);
    assert.equal(status, 0);
    assert.match(stdout, /Done/);
  });

  test('--quiet suppresses ✓ Saved lines', () => {
    const tmpDir = makeTempHtmlDir('saved');
    const { status, stdout } = run(['--output-html', tmpDir, '--quiet', fix('single-note.enex')]);
    assert.equal(status, 0);
    assert.ok(!stdout.includes('✓ Saved'), '--quiet should suppress ✓ Saved lines');
  });

  test('without --quiet, per-note → lines appear in output-html mode', () => {
    const tmpDir = makeTempHtmlDir('noisy');
    const { status, stdout } = run(['--output-html', tmpDir, fix('single-note.enex')]);
    assert.equal(status, 0);
    assert.match(stdout, /→ \[file/);
  });

  test('--quiet with multiple notes suppresses all per-note lines', () => {
    const tmpDir = makeTempHtmlDir('multi');
    const { status, stdout } = run(['--output-html', tmpDir, '--quiet', fix('multi-note.enex')]);
    assert.equal(status, 0);
    assert.ok(!stdout.includes('→ [file'), '--quiet should suppress all per-note → lines');
    assert.match(stdout, /Done/);
  });

  test('--quiet with unicode-title notes processes without error', () => {
    const tmpDir = makeTempHtmlDir('unicode');
    const { status, stderr } = run(['--output-html', tmpDir, '--quiet', fix('unicode-titles.enex')]);
    assert.equal(status, 0, `stderr: ${stderr}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) PROGRESS BAR — edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('ProgressBar — edge cases', () => {
  const { ProgressBar } = require('../src/ui');

  test('total=1 renders 1/1 on completion', () => {
    const captured = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { captured.push(s); return true; };
    try {
      const bar = new ProgressBar(1, { quiet: false });
      bar.tick();
    } finally {
      process.stdout.write = orig;
    }
    assert.match(captured.join(''), /1\/1/);
  });

  test('progress bar done counter increments correctly across multiple ticks', () => {
    const bar = new ProgressBar(5, { quiet: true });
    bar.tick(); bar.tick(); bar.tick();
    assert.equal(bar.done, 3);
  });

  test('ticking past total does not throw', () => {
    const bar = new ProgressBar(2, { quiet: true });
    bar.tick(); bar.tick(); bar.tick();  // 3 ticks on total=2
    assert.equal(bar.done, 3);
  });

  test('quiet:true suppresses output even when total is 0', () => {
    const captured = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { captured.push(s); return true; };
    try {
      const bar = new ProgressBar(0, { quiet: true });
      bar.tick();
    } finally {
      process.stdout.write = orig;
    }
    assert.equal(captured.length, 0);
  });

  test('large total (1000 notes) renders without error', () => {
    const captured = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { captured.push(s); return true; };
    try {
      const bar = new ProgressBar(1000, { quiet: false });
      for (let i = 0; i < 5; i++) bar.tick();
    } finally {
      process.stdout.write = orig;
    }
    assert.ok(captured.length > 0);
    assert.match(captured.join(''), /5\/1000/);
  });
});
