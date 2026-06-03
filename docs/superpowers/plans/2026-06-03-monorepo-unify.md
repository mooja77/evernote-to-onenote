# Monorepo Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the CLI (`master`) and Electron desktop app (orphan `main`) into one npm-workspaces monorepo with a shared, auth-agnostic, event-emitting engine consumed by both front-ends.

**Architecture:** Three packages — `packages/engine` (pure machinery: parsing, conversion, Graph client, progress ledger, concurrency, tags, local-cache reader, `auth-core`, `import-core`), `packages/cli` (device-code auth + terminal UI + flag parsing), `apps/desktop` (browser-PKCE auth + Electron + IPC). The engine emits events; front-ends render them. Each front-end injects its own auth flow and `noteKeyFn` so existing resume ledgers never break.

**Tech Stack:** Node ≥20, npm workspaces, `node:test` runner, `@azure/msal-node`, `better-sqlite3`, `xml2js`, `node-fetch`, `electron` + `electron-builder` (desktop only).

**Engine package name:** `evernote-onenote-engine` (unscoped; provisional — rename in one place if desired).

**Branch:** all work happens on `feat/monorepo-unify` (already created off `master`). The destructive `main` rewrite is the final phase and is gated on explicit user confirmation.

**Reference spec:** `docs/superpowers/specs/2026-06-03-unify-cli-desktop-design.md`

---

## Phase 0 — Safety net & baseline

### Task 0: Capture the green baseline and archive the desktop orphan

**Files:** none (git + verification only)

- [ ] **Step 1: Confirm the current suite is green before touching anything**

Run: `npm test 2>&1 | tail -5`
Expected: `# pass 559`, `# fail 0`, `# skipped 7` (566 tests total).

- [ ] **Step 2: Record the baseline counts in the plan working notes**

Write the exact pass/fail/skip numbers from Step 1 into a scratch note. Every later phase must end at ≥559 pass / 0 fail (plus new tests).

- [ ] **Step 3: Archive the desktop orphan branch as a tag (nothing lost)**

```bash
git fetch origin
git tag archive/desktop-v1.0.4 origin/main
git push origin archive/desktop-v1.0.4
```
Expected: tag created and pushed. This preserves the desktop history before any `main` rewrite.

- [ ] **Step 4: Confirm we are on the work branch**

Run: `git branch --show-current`
Expected: `feat/monorepo-unify`

---

## Phase 1 — Workspace scaffold

### Task 1: Create the root workspace and empty package skeletons

**Files:**
- Modify: `package.json` (root → becomes private workspace root)
- Create: `packages/engine/package.json`
- Create: `packages/cli/package.json`
- Create: `apps/desktop/package.json`

- [ ] **Step 1: Move the current root package.json aside as the CLI package**

```bash
git mv package.json packages/cli/package.json
git mv package-lock.json packages/cli/package-lock.json.bak  # will be regenerated at root
```
(If `git mv` complains the target dir doesn't exist, `mkdir -p packages/cli` first — `git mv` does not create parents on all platforms.)

- [ ] **Step 2: Write the new root `package.json`**

```json
{
  "name": "evernote-to-onenote-monorepo",
  "version": "0.0.0",
  "private": true,
  "license": "MIT",
  "engines": { "node": ">=20" },
  "workspaces": [
    "packages/engine",
    "packages/cli",
    "apps/desktop"
  ],
  "scripts": {
    "test": "npm test --workspaces --if-present",
    "test:engine": "npm test -w evernote-onenote-engine",
    "test:cli": "npm test -w evernote-to-onenote"
  }
}
```

- [ ] **Step 3: Write `packages/engine/package.json`**

```json
{
  "name": "evernote-onenote-engine",
  "version": "1.0.0",
  "description": "Shared engine for Evernote ENEX → OneNote import: parsing, ENML conversion, Graph client, resumable progress ledger.",
  "license": "MIT",
  "engines": { "node": ">=20" },
  "main": "src/index.js",
  "files": ["src/", "LICENSE"],
  "scripts": { "test": "node ../../scripts/run-tests.mjs" },
  "dependencies": {
    "@azure/msal-node": "^5.1.2",
    "better-sqlite3": "^12.9.0",
    "form-data": "^4.0.5",
    "node-fetch": "^2.7.0",
    "xml2js": "^0.6.2"
  }
}
```

- [ ] **Step 4: Rewrite `packages/cli/package.json`**

Keep `name`, `version` (1.4.2), `bin`, `keywords`, `repository`, `bugs`, `homepage` from the old root file. Replace `dependencies` and `scripts`:

```json
{
  "name": "evernote-to-onenote",
  "version": "1.4.2",
  "description": "Import Evernote .enex exports into Microsoft OneNote via the Graph API — resumable, scriptable, parallel",
  "license": "MIT",
  "engines": { "node": ">=20" },
  "bin": { "evernote-to-onenote": "src/index.js" },
  "files": ["src/", "LICENSE", "README.md", "SECURITY.md", "PRIVACY.md"],
  "keywords": ["evernote","onenote","migration","enex","microsoft-graph","notes","import","cli"],
  "repository": { "type": "git", "url": "git+https://github.com/mooja77/evernote-to-onenote.git" },
  "bugs": { "url": "https://github.com/mooja77/evernote-to-onenote/issues" },
  "homepage": "https://github.com/mooja77/evernote-to-onenote#readme",
  "scripts": {
    "start": "node src/index.js",
    "test": "node ../../scripts/run-tests.mjs",
    "pack:check": "node ../../scripts/prepublish-check.mjs",
    "prepublishOnly": "node ../../scripts/prepublish-check.mjs && npm test"
  },
  "dependencies": {
    "evernote-onenote-engine": "^1.0.0",
    "open": "^11.0.0"
  }
}
```
(The engine carries the parsing/Graph deps; the CLI keeps only what it uses directly — `open` for launching URLs. `msal-node` etc. arrive transitively via the engine.)

- [ ] **Step 5: Write `apps/desktop/package.json`**

```json
{
  "name": "evernote-to-onenote-desktop",
  "productName": "Evernote to OneNote",
  "version": "1.0.4",
  "description": "Desktop app that migrates an Evernote .enex export into Microsoft OneNote — for non-technical users.",
  "main": "src/main.js",
  "author": "John Moore",
  "license": "MIT",
  "private": true,
  "repository": { "type": "git", "url": "https://github.com/mooja77/evernote-to-onenote.git" },
  "scripts": {
    "start": "electron .",
    "dist": "electron-builder --win"
  },
  "dependencies": {
    "evernote-onenote-engine": "^1.0.0",
    "open": "^11.0.0"
  },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0"
  },
  "build": {
    "appId": "com.jmsdevlab.evernote-to-onenote",
    "productName": "Evernote to OneNote",
    "files": ["src/**/*", "package.json", "node_modules/**/*"],
    "win": { "target": "nsis", "icon": "build/icon.png" },
    "nsis": { "oneClick": false, "perMachine": false, "allowToChangeInstallationDirectory": true }
  }
}
```

- [ ] **Step 6: Install at the root to wire the workspace symlinks**

```bash
rm -f packages/cli/package-lock.json.bak
npm install
```
Expected: a single root `package-lock.json` is created; `node_modules/evernote-onenote-engine` is a symlink into `packages/engine`. No errors. (Engine has no published version yet; the `^1.0.0` range resolves to the local workspace.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold npm-workspaces monorepo (engine/cli/desktop)"
```

---

## Phase 2 — Engine package (move + reconcile)

> The engine source currently lives at `src/*.js` on this branch (the CLI tree). Move the shared modules into `packages/engine/src`, leaving CLI-only modules (`index.js`, `ui.js`) behind for Phase 3.

### Task 2: Move shared engine modules and the test harness

**Files:**
- Move: `src/enex-parser.js`, `src/enml-converter.js`, `src/onenote-client.js`, `src/progress.js`, `src/parallel.js`, `src/tags.js`, `src/local-cache-reader.js` → `packages/engine/src/`
- Move: `scripts/run-tests.mjs`, `scripts/prepublish-check.mjs` → repo-root `scripts/` (stay at root; referenced as `../../scripts/...`)
- Move the engine-level tests → `packages/engine/tests/`:
  `enex-parser.test.js`, `enml-converter.test.js`, `onenote-client.test.js`, `progress.test.js`, `parallel.test.js`, `tags.test.js`, `local-cache-reader.test.js`, `metadata.test.js`, `metadata-filter.test.js`, `conflict.test.js`, `checkpoint.test.js`, `edge-cases.test.js`, `reliability.test.js`, `attachment-fixtures.test.js`, `from-local-extended.test.js`, `from-local-parser-extra.test.js`, `graph-api.integration.test.js`, and the `tests/fixtures/` directory.

- [ ] **Step 1: Move the shared engine source files**

```bash
git mv src/enex-parser.js src/enml-converter.js src/onenote-client.js src/progress.js src/parallel.js src/tags.js src/local-cache-reader.js packages/engine/src/
```

- [ ] **Step 2: Move the engine-level tests and fixtures**

```bash
git mv tests/enex-parser.test.js tests/enml-converter.test.js tests/onenote-client.test.js tests/progress.test.js tests/parallel.test.js tests/tags.test.js tests/local-cache-reader.test.js tests/metadata.test.js tests/metadata-filter.test.js tests/conflict.test.js tests/checkpoint.test.js tests/edge-cases.test.js tests/reliability.test.js tests/attachment-fixtures.test.js tests/from-local-extended.test.js tests/from-local-parser-extra.test.js tests/graph-api.integration.test.js packages/engine/tests/
git mv tests/fixtures packages/engine/tests/fixtures
```

- [ ] **Step 3: Confirm `scripts/run-tests.mjs` globs the right path**

Read `scripts/run-tests.mjs`. It discovers test files (likely `tests/**/*.test.js` relative to cwd). Because each package runs `node ../../scripts/run-tests.mjs` from its own dir, the script's cwd is the package dir, so it must glob `./tests/**/*.test.js` relative to cwd. If it hardcodes a path that assumes the old layout, change the glob root to `process.cwd()`.

Expected after reading: the discovery root is `process.cwd()`/`tests`. If not, edit it to be cwd-relative.

- [ ] **Step 4: Rewire intra-engine requires (should already be relative and unchanged)**

The engine modules require each other by relative path (e.g. `onenote-client` is required by tests, not by siblings). Confirm none of the moved files `require('../src/...')` with a path that broke. Run:

```bash
grep -rn "require('\.\./src" packages/engine || echo "no stale ../src requires"
```
Expected: `no stale ../src requires`. If any test does `require('../src/foo')`, change to `require('../src/foo')` relative to its new `packages/engine/tests/` location — which is still `../src/foo`, so most are unaffected.

- [ ] **Step 5: Run the engine test suite**

```bash
npm run test:engine 2>&1 | tail -6
```
Expected: all moved engine tests pass; 0 fail. (Count will be lower than 566 — CLI/UI/wizard/auth/batch tests move in later phases.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move shared engine modules + tests into packages/engine"
```

### Task 3: Reconcile `progress.js` to the env-overridable path (superset)

**Files:**
- Modify: `packages/engine/src/progress.js:7`

- [ ] **Step 1: Write the failing test for env-overridable path**

Add to `packages/engine/tests/progress.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

test('PROGRESS_FILE honours E2O_PROGRESS_FILE override', () => {
  const prev = process.env.E2O_PROGRESS_FILE;
  process.env.E2O_PROGRESS_FILE = path.join('/tmp', 'custom-progress.json');
  delete require.cache[require.resolve('../src/progress.js')];
  const fresh = require('../src/progress.js');
  assert.strictEqual(fresh.PROGRESS_FILE_FOR_TEST, path.resolve('/tmp', 'custom-progress.json'));
  if (prev === undefined) delete process.env.E2O_PROGRESS_FILE; else process.env.E2O_PROGRESS_FILE = prev;
  delete require.cache[require.resolve('../src/progress.js')];
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/engine && node --test tests/progress.test.js 2>&1 | grep -A2 "E2O_PROGRESS_FILE"`
Expected: FAIL — `PROGRESS_FILE_FOR_TEST` is undefined / value is the default cwd path.

- [ ] **Step 3: Apply the superset path + export it for the test**

In `packages/engine/src/progress.js`, replace line 7:

```js
// Was: const PROGRESS_FILE = path.resolve('progress.json');
const PROGRESS_FILE = process.env.E2O_PROGRESS_FILE || path.resolve('progress.json');
```

And in the `module.exports = { ... }` block add:

```js
  PROGRESS_FILE_FOR_TEST: PROGRESS_FILE,
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd packages/engine && node --test tests/progress.test.js 2>&1 | tail -4`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/progress.js packages/engine/tests/progress.test.js
git commit -m "feat(engine): make progress file path overridable via E2O_PROGRESS_FILE"
```

### Task 4: Add `auth-core` (engine) — silent acquisition with injected interactive step

**Files:**
- Create: `packages/engine/src/auth-core.js`
- Create: `packages/engine/tests/auth-core.test.js`

The engine owns MSAL app construction, the persistent cache, and silent acquisition. It never picks an authority, client ID, or interactive flow — those are injected.

- [ ] **Step 1: Write the failing test**

`packages/engine/tests/auth-core.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { createTokenProvider } = require('../src/auth-core.js');

// A fake MSAL-like app so the test needs no network.
function fakeApp({ silentToken = null, account = { homeAccountId: 'a' } } = {}) {
  return {
    getTokenCache: () => ({ getAllAccounts: async () => (account ? [account] : []) }),
    acquireTokenSilent: async () => {
      if (silentToken) return { accessToken: silentToken };
      const e = new Error('no token'); e.name = 'InteractionRequiredAuthError'; throw e;
    },
  };
}

test('returns the silent token without calling acquireInteractive', async () => {
  let interactiveCalls = 0;
  const getToken = createTokenProvider({
    buildApp: () => fakeApp({ silentToken: 'SILENT' }),
    scopes: ['Notes.Create'],
    acquireInteractive: async () => { interactiveCalls++; return 'INTERACTIVE'; },
  });
  assert.strictEqual(await getToken(), 'SILENT');
  assert.strictEqual(interactiveCalls, 0);
});

test('falls back to acquireInteractive when silent fails', async () => {
  const getToken = createTokenProvider({
    buildApp: () => fakeApp({ silentToken: null, account: null }),
    scopes: ['Notes.Create'],
    acquireInteractive: async () => 'INTERACTIVE',
  });
  assert.strictEqual(await getToken(), 'INTERACTIVE');
});

test('throws when noInteractive and silent fails', async () => {
  const getToken = createTokenProvider({
    buildApp: () => fakeApp({ silentToken: null, account: null }),
    scopes: ['Notes.Create'],
    acquireInteractive: async () => 'INTERACTIVE',
    noInteractive: true,
  });
  await assert.rejects(() => getToken(), /interactive/i);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/engine && node --test tests/auth-core.test.js 2>&1 | tail -5`
Expected: FAIL — `Cannot find module '../src/auth-core.js'`.

- [ ] **Step 3: Implement `auth-core.js`**

```js
'use strict';

// Auth-agnostic token provider for the engine. Owns silent acquisition and
// the MSAL app lifecycle; the *interactive* flow (device-code, browser-PKCE,
// …) is injected by the front-end via `acquireInteractive`. Never opens a
// browser, prints a code, or chooses an authority/client — that is front-end
// policy passed in as config.

/**
 * @param {object}   cfg
 * @param {Function} cfg.buildApp          () => MSAL PublicClientApplication (or compatible)
 * @param {string[]} cfg.scopes
 * @param {Function} cfg.acquireInteractive async (app, scopes) => accessToken
 * @param {boolean}  [cfg.noInteractive]   if true, never run interactive; throw instead
 * @returns {(forceRefresh?: boolean) => Promise<string>} getToken
 */
function createTokenProvider({ buildApp, scopes, acquireInteractive, noInteractive = false }) {
  let app;
  function app_() { return (app ||= buildApp()); }

  return async function getToken(forceRefresh = false) {
    const a = app_();
    const accounts = await a.getTokenCache().getAllAccounts();
    if (accounts && accounts.length > 0) {
      try {
        const res = await a.acquireTokenSilent({ account: accounts[0], scopes, forceRefresh });
        if (res && res.accessToken) return res.accessToken;
      } catch (_err) {
        // fall through to interactive / throw
      }
    }
    if (noInteractive) {
      throw new Error('Authentication required but interactive sign-in is disabled.');
    }
    return acquireInteractive(a, scopes);
  };
}

module.exports = { createTokenProvider };
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd packages/engine && node --test tests/auth-core.test.js 2>&1 | tail -4`
Expected: PASS, 3 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/auth-core.js packages/engine/tests/auth-core.test.js
git commit -m "feat(engine): add auth-core token provider (silent + injected interactive)"
```

### Task 5: Add `import-core` (engine) — event-emitting import loop

**Files:**
- Create: `packages/engine/src/import-core.js`
- Create: `packages/engine/tests/import-core.test.js`

This extracts the **OneNote-import path** of the CLI's `importNotes()` (the non-`outputHtmlDir` branch) into a pure function. Output-HTML mode stays in the CLI (it is a CLI-only feature). The function takes injected `noteKeyFn` and emits events instead of writing to stdout.

- [ ] **Step 1: Write the failing test (event sequence for a fresh import)**

`packages/engine/tests/import-core.test.js`:

```js
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/engine && node --test tests/import-core.test.js 2>&1 | tail -5`
Expected: FAIL — `Cannot find module '../src/import-core.js'`.

- [ ] **Step 3: Implement `import-core.js`**

Port the OneNote branch of `importNotes()` from the old `src/index.js:269-502`, with these mechanical substitutions:
- Replace every `process.stdout.write(...)` / `console.log(...)` / `console.warn(...)` with `onEvent({ type, ... })` calls.
- Take `isImported`, `verifyImport`, `markImported`, `saveProgress`, `runParallel`, and engine converters as injected deps (default to the engine's own implementations via `require`).
- Take `noteKeyFn` (no internal `noteKey`).
- Drop the `outputHtmlDir` branch entirely (CLI-only).

```js
'use strict';

const crypto = require('node:crypto');
const { enmlToHtml, enmlToHtmlWithResources, toOneNoteHtml } = require('./enml-converter');
const { applyTagsToHtml, resolveSectionForTags } = require('./tags');
const { runParallel } = require('./parallel');
const progressLib = require('./progress');

function prepareResources(rawResources) {
  return (rawResources || [])
    .filter((r) => r.data && (Buffer.isBuffer(r.data) ? r.data.length : r.data.trim()))
    .map((r) => {
      const buf = Buffer.isBuffer(r.data) ? r.data : Buffer.from(String(r.data).replace(/\s+/g, ''), 'base64');
      return { hash: crypto.createHash('md5').update(buf).digest('hex'), mime: r.mime || 'application/octet-stream', filename: r.fileName || r.filename || '', data: buf };
    });
}

function yearFromCreated(created) {
  if (!created || created.length < 4) return null;
  return created.slice(0, 4);
}

/**
 * Import notes from one .enex into OneNote. Emits events; no terminal/GUI I/O.
 *
 * @param {object}   o
 * @param {Array}    o.notes
 * @param {string}   o.filename
 * @param {object}   o.client                OneNoteClient
 * @param {object}   o.notebook              { id }
 * @param {object}   o.progress
 * @param {Function} o.noteKeyFn             (filename, note) => string
 * @param {object}   [o.targetSection]       pre-chosen { id } — when set, every note goes here and no section is created (desktop fixed-section import)
 * @param {string}   [o.defaultSectionName]
 * @param {boolean}  [o.dryRun]
 * @param {boolean}  [o.resume]
 * @param {boolean}  [o.forceReimport]
 * @param {boolean}  [o.yearSections]
 * @param {string}   [o.tagsStrategy]        'page-metadata' | 'section-groups'
 * @param {string}   [o.onConflict]          'skip' | 'rename' | 'overwrite' | 'ask'
 * @param {Function} [o.askConflict]         async (title) => 'skip'|'rename'|'overwrite' (required if onConflict==='ask')
 * @param {number}   [o.concurrency]
 * @param {object}   [o.globalBackoff]
 * @param {boolean}  [o.preserveMetadata]
 * @param {Function} [o.onEvent]             (event) => void
 * @param {Function} [o.isImported]          defaults to progress.isImported
 * @param {Function} [o.verifyImport]        defaults to progress.verifyImport
 * @param {Function} [o.markImported]        defaults to progress.markImported
 * @param {Function} [o.saveProgress]        defaults to progress.saveProgress
 */
async function importNotes(o) {
  const {
    notes, filename, client, notebook, progress, noteKeyFn, targetSection = null,
    defaultSectionName, dryRun = false, resume = false, forceReimport = false,
    yearSections = false, tagsStrategy = 'page-metadata', onConflict = null,
    askConflict = null, concurrency = 1, globalBackoff = null, preserveMetadata = true,
    onEvent = () => {},
    isImported = progressLib.isImported,
    verifyImport = progressLib.verifyImport,
    markImported = progressLib.markImported,
    saveProgress = () => progressLib.saveProgress(progress),
  } = o;

  const counts = { succeeded: 0, failed: 0, skipped: 0 };
  const sectionCache = new Map();
  const sectionCreating = new Map();
  const sectionGroupCache = new Map();

  async function getSection(sectionName) {
    if (sectionCache.has(sectionName)) return sectionCache.get(sectionName);
    if (!sectionCreating.has(sectionName)) {
      const p = client.createSection(notebook.id, sectionName).then((section) => {
        const entry = { section, baseName: sectionName, overflowCount: 0 };
        sectionCache.set(sectionName, entry);
        return entry;
      });
      sectionCreating.set(sectionName, p);
    }
    return sectionCreating.get(sectionName);
  }

  const effectiveConcurrency = onConflict === 'ask' ? 1 : concurrency;
  const backoff = globalBackoff || { wait: async () => {}, active: false, set: () => {} };

  await runParallel(notes, effectiveConcurrency, backoff, async (note, i) => {
    const title = note.title || 'Untitled Note';
    const key = noteKeyFn(filename, note);
    const ctx = { filename, index: i, total: notes.length, title };
    try {
      if (resume && !forceReimport && isImported(progress, filename, key)) {
        if (dryRun) { onEvent({ type: 'noteSkipped', reason: 'dry-run', ...ctx }); counts.skipped++; return; }
        const state = await verifyImport(progress, filename, key, client);
        if (state === 'exists') { onEvent({ type: 'noteSkipped', reason: 'verified', ...ctx }); counts.skipped++; return; }
        if (state === 'unknown') { onEvent({ type: 'noteSkipped', reason: 'verify-inconclusive', ...ctx }); counts.skipped++; return; }
        onEvent({ type: 'noteRetry', reason: 'page-missing', ...ctx });
      }

      onEvent({ type: 'noteStart', ...ctx });

      const resources = prepareResources(note.resources || []);
      let html, usedResources;
      if (resources.length > 0) ({ html, usedResources } = enmlToHtmlWithResources(note.content, resources));
      else { html = enmlToHtml(note.content); usedResources = []; }

      if (tagsStrategy === 'page-metadata' && note.tags && note.tags.length > 0) html = applyTagsToHtml(html, note.tags);

      let sectionRef;
      if (targetSection) {
        sectionRef = { section: targetSection, baseName: '', overflowCount: 0 };
      }
      if (!sectionRef && tagsStrategy === 'section-groups' && note.tags && note.tags.length > 0) {
        const tagSection = await resolveSectionForTags(note.tags, notebook.id, client, sectionGroupCache);
        if (tagSection) sectionRef = { section: tagSection, baseName: note.tags[0], overflowCount: 0 };
      }
      if (!sectionRef) {
        const base = defaultSectionName || 'Imported';
        const sectionName = yearSections ? `${base} ${yearFromCreated(note.created) || ''}`.trim() : base;
        sectionRef = await getSection(sectionName);
      }

      let effectiveTitle = title;
      if (!dryRun && onConflict) {
        const existing = await client.findPageByTitle(sectionRef.section.id, title);
        if (existing) {
          let action = onConflict;
          if (onConflict === 'ask') action = await askConflict(title);
          if (action === 'skip') { onEvent({ type: 'noteSkipped', reason: 'conflict', ...ctx }); counts.skipped++; return; }
          if (action === 'rename') { effectiveTitle = `${title} (imported ${new Date().toISOString().slice(0, 10)})`; onEvent({ type: 'conflict', action: 'rename', from: title, to: effectiveTitle, ...ctx }); }
          if (action === 'overwrite') { onEvent({ type: 'conflict', action: 'overwrite', ...ctx }); try { await client.deletePage(existing.id); } catch (e) { onEvent({ type: 'warning', message: `delete failed: ${e.message}`, ...ctx }); } }
        }
      }

      const meta = preserveMetadata ? { created: note.created, author: note.author, sourceUrl: note.sourceUrl } : null;
      const page = toOneNoteHtml(effectiveTitle, html, meta);

      let pageId;
      try {
        const created = usedResources.length > 0
          ? await client.createPageWithAttachments(sectionRef.section.id, effectiveTitle, page, usedResources)
          : await client.createPage(sectionRef.section.id, effectiveTitle, page);
        pageId = created && created.id;
      } catch (apiErr) {
        if (apiErr.message.includes('30102') || apiErr.message.includes('507')) {
          sectionRef.overflowCount++;
          const newName = `${sectionRef.baseName} (${sectionRef.overflowCount})`;
          onEvent({ type: 'sectionOverflow', newName, ...ctx });
          sectionRef.section = await client.createSection(notebook.id, newName);
          const created = usedResources.length > 0
            ? await client.createPageWithAttachments(sectionRef.section.id, effectiveTitle, page, usedResources)
            : await client.createPage(sectionRef.section.id, effectiveTitle, page);
          pageId = created && created.id;
        } else throw apiErr;
      }

      markImported(progress, filename, key, pageId || null);
      saveProgress(progress);
      onEvent({ type: 'noteImported', pageId: pageId || null, tags: note.tags || [], dryRun, ...ctx });
      counts.succeeded++;
    } catch (err) {
      onEvent({ type: 'error', message: err.message, error: err, ...ctx });
      counts.failed++;
    }
  });

  return counts;
}

module.exports = { importNotes, prepareResources, yearFromCreated };
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd packages/engine && node --test tests/import-core.test.js 2>&1 | tail -4`
Expected: PASS, 2 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/import-core.js packages/engine/tests/import-core.test.js
git commit -m "feat(engine): add event-emitting import-core loop"
```

### Task 6: Engine public API barrel

**Files:**
- Create: `packages/engine/src/index.js`
- Create: `packages/engine/tests/barrel.test.js`

- [ ] **Step 1: Write the failing test**

`packages/engine/tests/barrel.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const engine = require('../src/index.js');

test('barrel exposes the full public API', () => {
  for (const name of [
    'parseEnexFile', 'enmlToHtml', 'enmlToHtmlWithResources', 'toOneNoteHtml',
    'OneNoteClient', 'loadProgress', 'saveProgress', 'markImported', 'isImported', 'verifyImport',
    'runParallel', 'createGlobalBackoff', 'createWriteQueue',
    'applyTagsToHtml', 'resolveSectionForTags', 'VALID_STRATEGIES',
    'createTokenProvider', 'importNotes', 'readLocalCache',
  ]) {
    assert.ok(engine[name] !== undefined, `missing export: ${name}`);
  }
});
```
(Use the actual local-cache export name from `local-cache-reader.js` — read its `module.exports` and substitute for `readLocalCache` if different.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/engine && node --test tests/barrel.test.js 2>&1 | tail -4`
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 3: Implement the barrel**

```js
'use strict';

module.exports = {
  ...require('./enex-parser'),
  ...require('./enml-converter'),
  ...require('./onenote-client'),
  ...require('./progress'),
  ...require('./parallel'),
  ...require('./tags'),
  ...require('./local-cache-reader'),
  ...require('./auth-core'),
  ...require('./import-core'),
};
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd packages/engine && node --test tests/barrel.test.js 2>&1 | tail -4`
Expected: PASS. If a name is missing, add the missing module's exports or fix the expected name to match actual exports.

- [ ] **Step 5: Run the whole engine suite, then commit**

```bash
npm run test:engine 2>&1 | tail -5
git add packages/engine/src/index.js packages/engine/tests/barrel.test.js
git commit -m "feat(engine): add public API barrel (src/index.js)"
```
Expected: engine suite green, 0 fail.

---

## Phase 3 — CLI package (consume the engine)

### Task 7: Move CLI source/tests and split out `auth-cli`

**Files:**
- Move: `src/index.js`, `src/ui.js` → `packages/cli/src/`
- Move: `src/auth.js` → `packages/cli/src/auth-cli.js` (CLI device-code flow, refactored onto `auth-core`)
- Move CLI/UX tests → `packages/cli/tests/`: `cli.test.js`, `cli-from-local.test.js`, `ui.test.js`, `auth.test.js`, `wizard.test.js`, `verify.test.js`, `batch-html-resume.test.js`
- Modify: `packages/cli/src/index.js` requires

- [ ] **Step 1: Move the files**

```bash
git mv src/index.js src/ui.js packages/cli/src/
git mv src/auth.js packages/cli/src/auth-cli.js
git mv tests/cli.test.js tests/cli-from-local.test.js tests/ui.test.js tests/auth.test.js tests/wizard.test.js tests/verify.test.js tests/batch-html-resume.test.js packages/cli/tests/
```

- [ ] **Step 2: Repoint engine requires in `packages/cli/src/index.js`**

Replace the top-of-file requires (old lines 8-14) so engine modules come from the package, and CLI-local modules stay relative:

```js
const {
  parseEnexFile, enmlToHtml, enmlToHtmlWithResources, toOneNoteHtml,
  OneNoteClient, loadProgress, saveProgress, markImported, isImported, verifyImport,
  applyTagsToHtml, resolveSectionForTags, VALID_STRATEGIES,
  createGlobalBackoff, createWriteQueue, runParallel,
} = require('evernote-onenote-engine');
const { getAuthenticatedToken, runAuthFlow, getTokenFromFile } = require('./auth-cli');
const { ProgressBar, describeError, interactiveSetup } = require('./ui');
```
The `version` require changes to `require('../package.json')` (already correct — it points at the CLI package.json).

- [ ] **Step 3: Refactor `auth-cli.js` onto `auth-core`**

`auth-cli.js` keeps the CLI's device-code specifics (authority `consumers`, client `04b07795-…`, cache in package dir) but delegates silent acquisition to the engine. Replace its `getAuthenticatedToken` body:

```js
const { createTokenProvider } = require('evernote-onenote-engine');
// buildMsalApp(), SCOPES, runAuthFlow() (device-code) stay as-is in this file.

async function getAuthenticatedToken({ noInteractive = false } = {}) {
  const getToken = createTokenProvider({
    buildApp: buildMsalApp,
    scopes: SCOPES,
    noInteractive: noInteractive || process.env.MSAL_NO_INTERACTIVE === '1',
    acquireInteractive: async () => runAuthFlow(),  // device-code
  });
  return getToken();
}

module.exports = { getAuthenticatedToken, runAuthFlow, getTokenFromFile, TOKEN_FILE };
```
Keep `runAuthFlow`, `getTokenFromFile`, `buildMsalApp`, `buildCachePlugin`, constants exactly as they were — only `getAuthenticatedToken` is rewired.

- [ ] **Step 4: Run the CLI suite**

```bash
npm run test:cli 2>&1 | tail -6
```
Expected: all CLI tests pass. Fix any require paths the tests use (tests that did `require('../src/foo')` for an engine module must now `require('evernote-onenote-engine')`; tests for `auth` must `require('../src/auth-cli')`).

- [ ] **Step 5: Smoke-test the CLI binary end-to-end (no API)**

```bash
node packages/cli/src/index.js --help 2>&1 | head -3
node packages/cli/src/index.js test.enex --output-html /tmp/e2o-smoke 2>&1 | tail -3
```
Expected: help prints; the sample `test.enex` converts to HTML under `/tmp/e2o-smoke` with no errors. (Output-HTML mode remains in the CLI, exercising the CLI's own loop path.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(cli): consume engine package; split device-code auth into auth-cli"
```

### Task 8: Route the CLI's OneNote import through `import-core`

**Files:**
- Modify: `packages/cli/src/index.js` (the `importNotes` call site ~old line 1146, and the local `importNotes`/`noteKey` definitions)

The CLI keeps its `--output-html` branch in a local function, but its OneNote-import path now calls the engine's `import-core`, passing a terminal-rendering `onEvent` and its historic `noteKeyFn` (so existing `progress.json` ledgers keep resuming).

- [ ] **Step 1: Add a terminal renderer + keep the historic key**

In `packages/cli/src/index.js`, near the existing helpers, add:

```js
const { importNotes: importNotesCore } = require('evernote-onenote-engine');

// Historic CLI ledger key — MUST stay byte-identical to pre-monorepo format
// so existing users' progress.json files keep resolving under --resume.
function cliNoteKey(filename, note) {
  return `${filename}::${note.title || 'Untitled'}::${note.created || ''}`;
}

// Render engine events to the terminal (replaces the inline stdout writes).
function makeCliReporter({ fileIndex, fileCount, quiet, bar }) {
  return (e) => {
    const label = `[file ${fileIndex}/${fileCount}: ${e.filename}] [note ${e.index + 1}/${e.total}]`;
    if (e.type === 'noteStart' && !quiet) process.stdout.write(`  → ${label} "${e.title}"\n`);
    else if (e.type === 'noteImported') { if (!e.dryRun && !quiet) console.log('    ✓ Imported'); bar?.tick(); }
    else if (e.type === 'noteSkipped') { if (!quiet) process.stdout.write(`  ↷ ${label} "${e.title}" (skipped: ${e.reason})\n`); bar?.tick(); }
    else if (e.type === 'noteRetry' && !quiet) process.stdout.write(`  ⚠ ${label} "${e.title}" (${e.reason} — re-importing)\n`);
    else if (e.type === 'sectionOverflow') console.log(`    ⚠ Section full — creating "${e.newName}"`);
    else if (e.type === 'conflict' && !quiet) process.stdout.write(`  ↷ ${label} conflict → ${e.action}\n`);
    else if (e.type === 'warning') console.warn(`    ⚠ ${e.message}`);
    else if (e.type === 'error') { console.error(`    ✗ Failed: ${e.message}`); const hint = describeError(e.error); if (hint) console.error(hint); bar?.tick(); }
  };
}
```
Note: `import-core` calls `bar?.tick()` indirectly — here the reporter ticks on terminal events. Remove the `bar` arg from the engine path; ticking is a render concern.

- [ ] **Step 2: Replace the OneNote-import call site**

Find the block that currently calls the local `importNotes({...})` for the API path (old ~line 1146). For the non-output-HTML path, replace with:

```js
const { succeeded, failed, skipped } = await importNotesCore({
  notes, filename, client, notebook, progress,
  noteKeyFn: cliNoteKey,
  defaultSectionName, dryRun, resume, forceReimport, yearSections,
  tagsStrategy, onConflict, askConflict, concurrency, globalBackoff,
  preserveMetadata,
  isImported, verifyImport, markImported,
  saveProgress: () => (enqueueWrite ? enqueueWrite(() => saveProgress(progress)) : saveProgress(progress)),
  onEvent: makeCliReporter({ fileIndex, fileCount, quiet, bar }),
});
```
Keep the `--output-html` path calling the CLI-local function (rename the local one to `writeNotesAsHtml` to avoid confusion with the engine import). Move the output-HTML body (old lines 351-393) into that local function unchanged.

- [ ] **Step 3: Remove the now-duplicated OneNote loop from the CLI**

Delete the OneNote-import portion of the old local `importNotes` (the section/conflict/createPage logic now living in the engine). Keep only `writeNotesAsHtml` (output-HTML) and `askConflict`.

- [ ] **Step 4: Run the full CLI suite**

```bash
npm run test:cli 2>&1 | tail -6
```
Expected: 0 fail. Pay attention to `cli.test.js` mode-detection and `batch-html-resume.test.js` — if they assert on exact stdout strings, align the reporter strings above to the originals (copy the exact glyphs/words from the pre-refactor `git show HEAD~6:src/index.js`).

- [ ] **Step 5: Re-run the smoke test from Task 7 Step 5; commit**

```bash
node packages/cli/src/index.js test.enex --output-html /tmp/e2o-smoke2 2>&1 | tail -2
git add packages/cli/src/index.js
git commit -m "refactor(cli): route OneNote import through engine import-core with terminal reporter"
```

---

## Phase 4 — Desktop app (consume the engine)

### Task 9: Bring desktop files into `apps/desktop`

**Files:**
- Create (from `archive/desktop-v1.0.4`): `apps/desktop/src/main.js`, `preload.js`, `import-runner.js`, `renderer/{app.js,index.html,styles.css}`, and `build/` assets if present.

- [ ] **Step 1: Extract the desktop tree from the archived branch into the app dir**

```bash
git checkout archive/desktop-v1.0.4 -- src
# That populates ./src with the desktop layout (src/main.js, src/preload.js,
# src/import-runner.js, src/lib/*, src/renderer/*). Move into apps/desktop:
mkdir -p apps/desktop/src
git mv src/main.js src/preload.js src/import-runner.js apps/desktop/src/
git mv src/renderer apps/desktop/src/renderer
rm -rf src/lib   # the engine copy is replaced by the shared package
# If the archived branch has build/icon.png etc.:
git checkout archive/desktop-v1.0.4 -- build 2>/dev/null && git mv build apps/desktop/build || true
```
Expected: `apps/desktop/src` holds main/preload/import-runner/renderer; no leftover `src/lib`.

- [ ] **Step 2: Confirm the old root `src/` is now empty of desktop leftovers**

Run: `ls src 2>/dev/null || echo "src gone"`
Expected: `src` is empty or gone. (CLI source moved to `packages/cli/src` in Phase 3; engine to `packages/engine/src` in Phase 2.) Remove an empty `src/` with `rmdir src` if present.

- [ ] **Step 3: Commit the raw import before rewiring**

```bash
git add -A
git commit -m "chore(desktop): import desktop app source into apps/desktop from archive tag"
```

### Task 10: Rewire desktop onto the engine + `auth-desktop`

**Files:**
- Modify: `apps/desktop/src/main.js` (requires)
- Modify: `apps/desktop/src/import-runner.js` (consume `import-core`)
- Create: `apps/desktop/src/auth-desktop.js` (browser-PKCE on `auth-core`)
- Create: `apps/desktop/tests/import-runner.test.js`

- [ ] **Step 1: Create `auth-desktop.js` from the archived desktop auth, on `auth-core`**

Recover the desktop auth (browser-PKCE, authority `common`, client `824932cc-…`, `openBrowser`, `E2O_MSAL_CACHE`) and refactor its silent path onto the engine:

```bash
git show archive/desktop-v1.0.4:src/lib/auth.js > apps/desktop/src/auth-desktop.js
```
Then edit `apps/desktop/src/auth-desktop.js` so `getAuthenticatedToken` delegates silent acquisition to `createTokenProvider`:

```js
const { createTokenProvider } = require('evernote-onenote-engine');
// buildMsalApp(), SCOPES, runAuthFlow(openBrowser) (browser-PKCE) stay as-is.

async function getAuthenticatedToken({ noInteractive = false, openBrowser } = {}) {
  const getToken = createTokenProvider({
    buildApp: buildMsalApp,
    scopes: SCOPES,
    noInteractive,
    acquireInteractive: async () => runAuthFlow(openBrowser),  // browser-PKCE
  });
  return getToken();
}

module.exports = { getAuthenticatedToken, runAuthFlow };
```

- [ ] **Step 2: Repoint `main.js` requires**

In `apps/desktop/src/main.js`, change:

```js
// was: const auth = require('./lib/auth');
const auth = require('./auth-desktop');
// was: const { OneNoteClient } = require('./lib/onenote-client');
const { OneNoteClient } = require('evernote-onenote-engine');
// was: const { runParallel, createGlobalBackoff } = require('./lib/parallel');
const { runParallel, createGlobalBackoff } = require('evernote-onenote-engine');
const { runImport } = require('./import-runner');
```

- [ ] **Step 3: Rewrite `import-runner.js` to delegate to `import-core`**

Replace its hand-rolled loop with a thin adapter: it parses the .enex, then calls the engine `importNotes`, translating engine events into the desktop's existing `onProgress` event shape, and supplying the desktop's section-scoped key.

```js
'use strict';
const { parseEnexFile, importNotes, loadProgress, saveProgress, isImported, markImported, verifyImport } = require('evernote-onenote-engine');

function desktopNoteKey(sectionId) {
  return (filename, note) => `${sectionId}::${filename}::${note.title || 'Untitled'}::${note.created || ''}`;
}

async function runImport({ enexPath, sectionId, getToken, onProgress = () => {}, shouldCancel = () => false, force = false }) {
  const path = require('node:path');
  const filename = path.basename(enexPath);
  const notes = await parseEnexFile(enexPath);
  const progress = loadProgress();
  const { OneNoteClient } = require('evernote-onenote-engine');
  const client = new OneNoteClient({ getToken });

  const counts = await importNotes({
    notes, filename, client,
    notebook: { id: null },          // section already chosen; createSection unused for fixed-section import
    progress,
    noteKeyFn: desktopNoteKey(sectionId),
    defaultSectionName: null,
    resume: !force, forceReimport: force,
    concurrency: 1,
    isImported, verifyImport, markImported,
    saveProgress: () => saveProgress(progress),
    onEvent: (e) => {
      if (shouldCancel()) throw new Error('cancelled');
      if (e.type === 'noteStart') onProgress({ phase: 'note', title: e.title, index: e.index, total: e.total });
      else if (e.type === 'noteImported') onProgress({ phase: 'imported', title: e.title, index: e.index, total: e.total });
      else if (e.type === 'noteSkipped') onProgress({ phase: 'skipped', title: e.title, reason: e.reason });
      else if (e.type === 'error') onProgress({ phase: 'error', title: e.title, message: e.message });
    },
  });
  return counts;
}

module.exports = { runImport };
```
NOTE: this relies on the engine's `targetSection` param (defined in Task 5): when set, every note goes to that section and no `createSection` call is made. Pass `targetSection: { id: sectionId }` (shown above) — `notebook.id` is then unused, so `{ id: null }` is fine.

- [ ] **Step 4: Add a desktop adapter test**

`apps/desktop/tests/import-runner.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { runImport } = require('../src/import-runner.js');

test('runImport imports the sample enex into a fixed section and reports progress', async () => {
  const events = [];
  // Point the engine ledger at a temp file so the test is isolated.
  process.env.E2O_PROGRESS_FILE = path.join(require('node:os').tmpdir(), `e2o-desktop-${process.pid}.json`);
  const counts = await runImport({
    enexPath: path.join(__dirname, '..', '..', '..', 'test.enex'),
    sectionId: 'sec-test',
    getToken: async () => 'TKN',
    onProgress: (e) => events.push(e.phase),
  });
  assert.ok(counts.succeeded >= 1);
  assert.ok(events.includes('imported'));
  delete process.env.E2O_PROGRESS_FILE;
});
```
This needs a fake Graph client. Since `runImport` builds its own `OneNoteClient`, inject a test seam: have `runImport` accept an optional `client` param (default `new OneNoteClient({ getToken })`) and pass a fake in the test. Add that param to `runImport`.

- [ ] **Step 5: Add the desktop test script**

In `apps/desktop/package.json` add to `scripts`: `"test": "node ../../scripts/run-tests.mjs"`.

- [ ] **Step 6: Run the desktop tests**

```bash
npm test -w evernote-to-onenote-desktop 2>&1 | tail -5
```
Expected: import-runner test passes, 0 fail.

- [ ] **Step 7: Launch-smoke the Electron app (manual, optional in CI)**

```bash
cd apps/desktop && npx electron . &
```
Expected: window opens, "Sign in with Microsoft" visible. Close it. (Skip in headless CI.)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(desktop): consume engine import-core + auth-core; add import-runner test"
```

---

## Phase 5 — CI, docs, and the branch cutover

### Task 11: Rework CI and publish workflows for workspaces

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/publish.yml`

- [ ] **Step 1: Update `ci.yml` to install + test at the root**

The test step becomes `npm ci` then `npm test` at the repo root (runs all workspaces via the root script). Keep the existing Node version matrix. Remove any `cd`/path assumptions pointing at the old flat `src/`.

- [ ] **Step 2: Update `publish.yml` to publish engine then CLI**

Two publish jobs, engine first:
```yaml
# 1) publish evernote-onenote-engine  (npm publish -w evernote-onenote-engine)
# 2) publish evernote-to-onenote      (npm publish -w evernote-to-onenote), needs: engine
```
Keep the existing idempotent "skip if version already exists" guard (from PR #2) in both jobs. The CLI tarball resolves its engine dep from the just-published engine version.

- [ ] **Step 3: Validate the CLI packs correctly**

```bash
npm run pack:check -w evernote-to-onenote 2>&1 | tail -10
npm pack -w evernote-to-onenote --dry-run 2>&1 | tail -20
```
Expected: the dry-run tarball lists `src/`, `README.md`, `LICENSE`, `SECURITY.md`, `PRIVACY.md`, and resolves `evernote-onenote-engine` as a dependency (not bundled). No missing-file warnings.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/publish.yml
git commit -m "ci: run workspaces at root; publish engine before CLI"
```

### Task 12: Update docs to the 3-package model

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `README.md` (CLI install/usage stays accurate; add a short "repo layout" note)
- Move CLI-facing docs as needed; keep `README.md` at `packages/cli/README.md` for npm (the `files` field references it).

- [ ] **Step 1: Add a "Repository layout" section to `docs/ARCHITECTURE.md`**

Document the three packages, the engine boundary rule, the event contract emitted by `import-core` (list every event `type` and its fields from Task 5), and the injected-`noteKeyFn` backward-compat rule.

- [ ] **Step 2: Ensure the CLI README ships with the package**

```bash
git mv README.md packages/cli/README.md 2>/dev/null || cp README.md packages/cli/README.md
```
Add a short root `README.md` describing the monorepo and linking to each package. Update the CLI README's badge/links if they referenced the old root paths.

- [ ] **Step 3: Run the full suite once more from the root**

```bash
npm test 2>&1 | tail -8
```
Expected: engine + cli + desktop suites all green; total ≥566 (original) + the new engine/desktop tests; 0 fail.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: document monorepo layout, engine event contract, and noteKey compat"
```

### Task 13: Branch cutover (DESTRUCTIVE — explicit confirmation gate)

**Files:** none (git remote operations)

- [ ] **Step 1: STOP and confirm with the user**

Do not proceed without an explicit "yes, rewrite main". Show the user: the archive tag exists (`archive/desktop-v1.0.4`), the work branch is green, and the next step force-updates remote `main`.

- [ ] **Step 2: Merge the work branch into the trunk locally**

```bash
git checkout master
git merge --no-ff feat/monorepo-unify -m "feat: unify CLI + desktop into one monorepo with a shared engine"
```

- [ ] **Step 3: Rename trunk master → main locally**

```bash
git branch -m master main
```

- [ ] **Step 4: Force-update remote main and set default**

```bash
git push origin main --force-with-lease
gh repo edit --default-branch main   # already main as default; ensures it points at the new tip
```
Expected: remote `main` now contains the monorepo. `archive/desktop-v1.0.4` still preserves the old desktop app.

- [ ] **Step 5: Clean up stale remote branches**

```bash
git push origin --delete master 2>/dev/null || true
# Delete merged feature branches that are now in history:
for b in feat/from-local fix/output-html-resources fix/v11-schema-detect ux/v1.1-refinements release-v1.2.0; do
  git push origin --delete "$b" 2>/dev/null || true
done
```
Keep `typescript-rewrite-spike-2026-05-03` (explicitly out of scope) and `archive/desktop-v1.0.4`.

- [ ] **Step 6: Final verification**

```bash
gh repo view --json defaultBranchRef -q .defaultBranchRef.name   # → main
git ls-remote --heads origin
npm test 2>&1 | tail -5                                          # green
```
Expected: default branch `main`; monorepo on `main`; suite green.

---

## Self-review notes (author)

- **Spec coverage:** layout (Task 1), engine API barrel (Task 6), auth-core (Task 4), import-core event model (Task 5), backward-compat noteKeyFn (Tasks 5/8/10) + env path (Task 3), publish-engine-then-CLI (Task 11), testing moves (Tasks 2/7) + new tests (Tasks 4/5/10), migration sequence + destructive-cutover gate (Task 13). All spec sections map to tasks.
- **Open risk carried from spec:** engine package name is provisional (`evernote-onenote-engine`) — used concretely throughout; rename in `packages/engine/package.json` + the dependency lines in the two front-end package.json files + the require strings if changed.
- **Type consistency:** `import-core`'s `targetSection` param is defined and unit-tested in Task 5 and consumed in Task 10 (desktop fixed-section import); `noteKeyFn` signature `(filename, note) => string` is identical across engine (Task 5), CLI `cliNoteKey` (Task 8), and desktop `desktopNoteKey` (Task 10). `getAuthenticatedToken` keeps its existing call signature in both front-ends; only its body is rewired onto `createTokenProvider`.
