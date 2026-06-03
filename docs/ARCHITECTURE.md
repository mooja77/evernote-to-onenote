# Evernote → OneNote Importer — Architecture Specification

---

## Monorepo Architecture (v3, 2026)

This section documents the npm-workspaces monorepo layout introduced in v1.4+. The original single-package module contracts in sections 1–9 below remain accurate; source files have moved under `packages/engine/src/` (engine modules) or `packages/cli/src/` (CLI modules) — the logical contracts are unchanged.

### Repository Layout

```
evernote-to-onenote/
├── packages/
│   ├── engine/          evernote-onenote-engine  (shared, publishable)
│   └── cli/             evernote-to-onenote      (npm CLI, v1.4.x)
└── apps/
    └── desktop/         evernote-to-onenote-desktop  (private Electron app)
```

**`packages/engine`** (`evernote-onenote-engine`) — the shared, I/O-free core:
- ENEX parsing, ENML→HTML conversion
- OneNote Graph API client (retry, backoff, pagination)
- Resumable progress ledger (`progress.js`)
- Concurrency runner (`parallel.js`)
- Tags handling (`tags.js`)
- Local Evernote SQLite cache reader (`from-local.js`)
- `auth-core` — auth-agnostic token provider (`createTokenProvider`)
- `import-core` — event-emitting import loop (`importNotes`)

**`packages/cli`** (`evernote-to-onenote`) — the npm CLI package:
- Device-code auth flow (`auth-cli`)
- Terminal UI / progress rendering
- CLI flag parsing (`--batch`, `--resume`, `--year-sections`, `--output-html`, etc.)
- Routes import through `import-core` with a terminal event reporter
- `--output-html` mode (CLI-only; no Graph API calls)

**`apps/desktop`** (`evernote-to-onenote-desktop`) — the Electron app:
- Browser-PKCE auth flow (`auth-desktop`)
- Electron main / preload / renderer
- `import-runner` delegates to `import-core` for a single fixed OneNote section

**BOUNDARY RULE:** The engine (`packages/engine`) never performs terminal output, browser interaction, or Electron I/O. It emits events via `onEvent` and exposes pure functions. Front-ends own rendering, auth interaction, and path configuration.

---

### import-core Event Contract

`import-core.importNotes(opts)` runs the import loop. All events are delivered via `opts.onEvent(event)`.

**Common fields** on every event: `{ type, filename, index, total, title }`
- `filename` — the source `.enex` filename
- `index` — 0-based note index within the current file
- `total` — total notes in the current file
- `title` — note title (defaulting to `'Untitled Note'`)

**Return value:** `{ succeeded, failed, skipped, cancelled }`

**Event table:**

| `type` | Additional fields | When emitted |
|---|---|---|
| `noteStart` | _(none)_ | Import of this note is beginning (after skip checks pass) |
| `noteImported` | `pageId`, `tags`, `dryRun` | Note successfully imported (or written in dry-run mode) |
| `noteSkipped` | `reason` | Note skipped; `reason` ∈ `dry-run` \| `verified` \| `verify-inconclusive` \| `conflict` |
| `noteRetry` | `reason: 'page-missing'` | Ledger records note as imported but the page is gone; re-importing |
| `conflict` | `action: 'rename' \| 'overwrite'`, `from?`, `to?` | Existing page conflict resolved; `rename` includes `from`/`to` titles |
| `sectionOverflow` | `newName` | Section full (Graph error 30102/507); overflow section created with `newName` |
| `warning` | `message` | Non-fatal issue (e.g. page-delete failed during overwrite) |
| `error` | `message`, `error` | Note import failed; `error` is the thrown Error object |
| `cancelled` | _(none)_ | Emitted once when `shouldCancel()` returns true; remaining notes are skipped |

**`noteSkipped` reason semantics:**
- `dry-run` — `--dry-run` mode; no API call was made
- `verified` — `--resume` mode; `verifyImport` confirmed the page still exists in OneNote
- `verify-inconclusive` — `--resume` mode; verify returned `unknown` (network/rate-limit); note is conservatively skipped
- `conflict` — `onConflict: 'skip'` and an existing page was found with the same title

---

### Auth Boundary

`auth-core.createTokenProvider({ buildApp, scopes, acquireInteractive, noInteractive })` owns:
- Silent MSAL token acquisition (reads `E2O_MSAL_CACHE` or `./msal-cache.json`)
- Transparent silent refresh on token expiry
- Cache persistence after each acquisition

Each front-end injects:
- **`buildApp`** — constructs the MSAL PublicClientApplication with front-end–specific authority and client ID
- **`acquireInteractive`** — the interactive fallback flow:
  - CLI (`auth-cli`): device-code flow (prints URL to terminal)
  - Desktop (`auth-desktop`): browser-PKCE flow (opens Electron browser window)
- **`noInteractive`** — whether to throw instead of prompting (e.g. mid-import or headless CI)

Environment variables relocate state without code changes:
- `E2O_MSAL_CACHE` — override MSAL cache path (desktop sets this to Electron `userData`)
- `E2O_PROGRESS_FILE` — override progress ledger path (desktop sets this to `userData`)

---

### Backward-Compatibility: `noteKeyFn` and Ledger Keys

`importNotes` accepts a `noteKeyFn(filename, note) => string` parameter so each front-end preserves its historic progress.json key format:

| Front-end | Key format |
|---|---|
| CLI | `${filename}::${title}::${created}` |
| Desktop | `${sectionId}::${filename}::${title}::${created}` |

This injection means existing `progress.json` files keep resolving correctly under `--resume` after upgrading to the monorepo layout. Neither front-end's ledger is invalidated by the refactor.

---

**Version:** 2 (MSAL + v2 progress + multipart attachments)
**Author:** Architect (supervisor agent, 2026-04-19)
**Audience:** Coders A / B / C (file-ownership matrix below)

End-to-end goal: import arbitrary `.enex` files into OneNote with zero manual intervention after a one-time `--auth`. No bearer-token juggling, no re-imports on resume, attachments preserved as first-class OneNote resources.

---

## 1. File-Ownership Matrix

| Owner | Files | Scope |
|---|---|---|
| **Coder A** | `src/index.js`, `src/progress.js` | CLI, main loop, progress schema, --resume / --verify / --force-reimport orchestration |
| **Coder B** | `src/onenote-client.js`, `src/enml-converter.js` | Graph API surface + multipart + backoff; ENML→HTML with resource references |
| **Coder C** | `src/auth.js` | MSAL device-code + silent token acquisition + persistent cache |

Shared (no-merge-conflict contract): `src/enex-parser.js` is stable — do not touch unless a bug is filed. Tests under `tests/` are owned by whichever coder owns the module under test.

---

## 2. Module Contracts (API between modules)

### 2.1 `src/auth.js` — Coder C

```
getAuthenticatedToken() → Promise<string>
  // Returns a valid access token. Silent-first; falls back to device-code.
  // MUST NOT prompt mid-import (callers guard via pre-acquire).

runAuthFlow() → Promise<string>
  // Explicit device-code flow. Used by `--auth` and by getAuthenticatedToken()
  // when silent acquisition fails.

getTokenFromFile() → string | null
  // Legacy escape hatch. Returns ONENOTE_ACCESS_TOKEN env value or the
  // contents of ./.access-token if present. No MSAL involvement.

TOKEN_FILE → string (exported constant for tests)
```

Scopes: `Notes.Create`, `Notes.ReadWrite`, `Notes.Read`, `User.Read`.
Authority: `https://login.microsoftonline.com/consumers` (personal MS accounts).
Cache: `./msal-cache.json` (MUST be in `.gitignore`).

**Refresh invariant:** callers pass `getToken` (not a raw string) to OneNoteClient. `OneNoteClient` invokes `getToken(true)` on 401 to force a silent re-acquire — MSAL transparently uses the refresh token. No device-code re-prompt during a running import.

### 2.2 `src/onenote-client.js` — Coder B

Constructor:
```
new OneNoteClient({ getToken, dryRun })
  // getToken: (forceRefresh?: boolean) => Promise<string>
  // Legacy alternative: { accessToken: string, dryRun }
```

Public methods (all return Promises; all use _fetchWithRetry):
```
createNotebook(name)                        → { id, displayName }
createSection(notebookId, name)             → { id, displayName }
createPage(sectionId, title, htmlContent)   → { id, title, ... }
createPageWithAttachments(
  sectionId, title, htmlContent,
  resources: Array<{ contentType, data: Buffer, partName }>
)                                           → { id, title, ... }
listNotebooks()                             → Array<Notebook>  (paginated via @odata.nextLink)
listSections(notebookId)                    → Array<Section>   (paginated)
listPages(sectionId)                        → Array<Page>      (paginated)
getToken(forceRefresh?)                     → Promise<string>  (exposed for progress.verifyImport)
```

**Idempotency:** `createNotebook` / `createSection` check for existing entities by `displayName` before POSTing. `createPage*` is NOT idempotent — dedup happens at the progress layer, not here.

**Retry matrix** (in `_fetchWithRetry`, max 5 attempts):

| Condition | Action |
|---|---|
| Network error (fetch throws) | backoff + retry |
| 429 | honour `Retry-After` header if present, else backoff + retry |
| 401 | `getToken(true)` once, retry with fresh token; second 401 → throw |
| 503 | backoff + retry |
| Other non-2xx | throw with response body excerpt (≤500 chars) |

Backoff: `min(1000 * 2^(attempt-1), 60000)` ms × `(1 + random() * 0.3)` jitter.

Section-overflow (error code `30102` / HTTP 507): caller (index.js) handles by creating `"<section> (N)"` overflow section and retrying. Client itself does NOT auto-split — overflow is a domain decision.

### 2.3 `src/enml-converter.js` — Coder B

```
enmlToHtml(enml) → string
  // Stripped <en-note>, <en-todo>, <en-crypt>. <en-media> → literal "[attachment]".
  // Used when no resource list is available.

enmlToHtmlWithResources(enml, resources) → { html, usedResources }
  // resources: [{ hash, mime, filename, data: Buffer }]
  // Matches <en-media hash="..." type="..."/> to resource by hash.
  // Images → <img src="name:partN" />
  // Other  → <object data="name:partN" data-attachment="<filename>" type="<mime>"></object>
  // Unmatched hash → "[attachment]" literal (does not throw).
  // usedResources: [{ contentType, data, partName }] — exactly what client.createPageWithAttachments expects.

toOneNoteHtml(title, htmlBody) → string
  // Full HTML document with <h1>title</h1> + body, escaped.
```

**HTML-escaping:** `&`, `<`, `>`, `"` are escaped everywhere user-controlled strings are inlined (title, filename, mime type). Single-quote not escaped (not attribute-break-safe character in OneNote's expected HTML).

### 2.4 `src/progress.js` — Coder A

Schema v2:
```json
{
  "version": 2,
  "files": {
    "<filename.enex>": {
      "notebook_id": "...",
      "section_ids": ["...", "..."],
      "imported": {
        "<noteKey>": {
          "onenote_page_id": "...",
          "timestamp": "ISO-8601"
        }
      }
    }
  }
}
```

`noteKey` = `${filename}::${title || 'Untitled'}::${created || ''}` — stable across re-runs for the same note.

V1 migration (`{ [filename]: { imported: [keys] } }`): preserved keys with `onenote_page_id: null`. Those entries trigger a forced re-import under `--resume` because `verifyImport` cannot confirm them.

```
loadProgress() → progress                   // auto-migrates v1
saveProgress(progress)                      // atomic via .tmp + rename
markImported(progress, filename, key, pageId)
isImported(progress, filename, key) → bool
verifyImport(progress, filename, key, client) → Promise<bool>
  // Requires v2 entry with non-null onenote_page_id.
  // GET /me/onenote/pages/{pageId} — res.ok → true; anything else → false.
```

**Atomic write:** writes to `progress.json.tmp` then `rename`. Prevents corruption on kill mid-write.

### 2.5 `src/enex-parser.js` — stable (no owner, do not modify)

```
parseEnexFile(path) → Promise<Array<Note>>
// Note = { title, created, updated, tags, content (ENML string), resources: [{ mime, fileName, data }] }
// Guards: throws if file > 100 MB.
```

---

## 3. Data Flow Diagram

```
 ┌────────────┐                ┌─────────────┐                ┌────────────────┐
 │  .enex file│ ─parse──────▶  │ enex-parser │ ──Note[]─────▶ │    index.js    │
 └────────────┘                └─────────────┘                │  (main loop)   │
                                                              └───┬───────┬────┘
                                                                  │       │
                                            ┌─────────────────────┘       │
                                            ▼                             ▼
                                  ┌──────────────────┐          ┌──────────────────┐
                                  │  enml-converter  │          │    progress.js   │
                                  │                  │          │  load/save/mark  │
                                  │ enmlToHtmlWith-  │          │     /verify      │
                                  │    Resources     │          └────────┬─────────┘
                                  └────────┬─────────┘                   │
                                           │                             │
                                           │ { html, usedResources }     │
                                           ▼                             │
                                  ┌────────────────────────┐             │
                                  │    onenote-client      │◀────────────┤
                                  │ createPageWith-        │             │
                                  │   Attachments()        │             │
                                  │  (multipart, 429/401/  │  token      │
                                  │   503 retry+backoff)   │─────▶ auth.js (silent/device-code)
                                  └────────┬───────────────┘             ▲
                                           │                             │
                                           │ onenote_page_id             │
                                           └─────────────────────────────┘
```

Loop invariants (per .enex file):
1. Parse → get `Note[]`.
2. Create/lookup notebook named after file (sans `.enex`, sanitised).
3. For each note: skip if `isImported` **and** `verifyImport` passes. Else convert + createPage. Mark imported with pageId. Persist progress **after each note** (not batch-delayed).

---

## 4. CLI Flag Matrix

| Flag | Takes value | Requires API | Combines with | Notes |
|---|---|---|---|---|
| `<file.enex>` | positional | unless `--dry-run` / `--output-html` | any | Single-file mode |
| `--batch <dir>` | yes | unless `--dry-run` / `--output-html` | any (overrides positional) | Imports all `*.enex` in dir |
| `--auth` | no | yes (device-code) | exclusive | Runs device-code flow then exits |
| `--dry-run` | no | no | all | No POSTs; still reads progress |
| `--resume` | no | yes | `--batch`, positional | Skips notes whose pageId verifies on OneNote |
| `--force-reimport` | no | yes | `--resume` | Overrides skip — re-imports everything |
| `--year-sections` | no | yes | any | Sections named by `note.created` year |
| `--verify` | no | yes | any (can stand alone) | Reconciliation table vs OneNote |
| `--output-html <dir>` | yes | no | any (replaces API) | Write HTML files, no API calls |
| `--help` | no | no | exclusive | Print usage and exit |

Argument-parser rule: `FLAGS_WITH_VALUES = ['--batch', '--output-html']`. The positional enex file must not be mistaken for a flag value.

---

## 5. Error-Handling Matrix

| Call | 200 | 401 | 429 | 409 | 5xx | Size/Quota (507/30102) |
|---|---|---|---|---|---|---|
| `createNotebook` | return | refresh+retry | honour `Retry-After` | name-clash → reuse existing (pre-check) | backoff+retry | N/A |
| `createSection` | return | refresh+retry | honour `Retry-After` | name-clash → reuse existing | backoff+retry | N/A |
| `createPage` / `createPageWithAttachments` | return | refresh+retry | honour `Retry-After` | N/A | backoff+retry | bubble to index.js → `Section (N)` overflow |
| `listNotebooks/Sections/Pages` | return (paginate via @odata.nextLink) | refresh+retry | honour `Retry-After` | N/A | backoff+retry | N/A |
| `verifyImport` GET | return ok | swallowed → `false` | swallowed → `false` | N/A | swallowed → `false` | N/A |

All external calls logged: `[api] METHOD URL → STATUS (DURATIONms)`.

Non-API edge cases:
- **ENEX > 100 MB** → parser throws → index.js logs and skips file, increments `totalFailed`.
- **Unicode / special chars in filename:** `sanitizeName()` strips `/\?%*:|"<>'` → `-`.
- **Filename collisions in `--output-html`:** append ` (N)` until unique.
- **Empty `<en-note>` body** → `<p></p>` emitted (tests enforce).
- **`<en-media>` with unknown hash** → `[attachment]` literal, no throw.
- **Process killed mid-import** → `progress.json` reflects last completed note; `--resume` on next run verifies each and continues.
- **MSAL cache corrupted** → silent acquire fails → operator re-runs `--auth`.

---

## 6. Authentication Flow

**One-time:**
```
  node src/index.js --auth
  ↓
  runAuthFlow() → device-code URL printed → user visits microsoft.com/devicelogin
  ↓
  MSAL stores refresh + access tokens in msal-cache.json
  ↓
  exit 0
```

**Every subsequent run (no user action):**
```
  index.js pre-acquires token via getAuthenticatedToken():
    1. Read msal-cache.json
    2. acquireTokenSilent(accounts[0], SCOPES)  — returns fresh access token
    3. (MSAL silently uses refresh token if access expired)
  ↓
  Pass getAuthenticatedToken (the function, not the value) to OneNoteClient.
  ↓
  On any 401 during import, client calls getAuthenticatedToken(true) — forces silent re-acquire.
```

**Failure mode:** if silent fails AND `MSAL_NO_INTERACTIVE=1` OR no cache exists, exit with: "Run `node src/index.js --auth` first."

**Legacy fallback:** `ONENOTE_ACCESS_TOKEN` env var OR `./.access-token` file. Bypasses MSAL entirely — static token, no refresh. Documented as a break-glass path for CI / tests.

---

## 7. Acceptance Criteria (per file)

### `src/auth.js` (Coder C)
- [ ] `--auth` completes device-code flow and writes `msal-cache.json`.
- [ ] Subsequent runs acquire token silently with **zero** user prompts.
- [ ] Token older than ~1 hour is silently refreshed (MSAL handles).
- [ ] `getTokenFromFile()` returns env-var-or-file-or-null without throwing.
- [ ] `msal-cache.json` is in `.gitignore`.

### `src/onenote-client.js` (Coder B)
- [ ] `createPageWithAttachments` POSTs `multipart/form-data` with `Presentation` part first, then one part per resource; `partName` in HTML matches part name in body.
- [ ] 429 response with `Retry-After: 5` waits exactly 5s (±jitter 0).
- [ ] 401 triggers one `getToken(true)` retry; second 401 throws.
- [ ] `listNotebooks` follows `@odata.nextLink` and aggregates all pages.
- [ ] Retry sequence logs attempts with counter (`attempt N/MAX_RETRIES`).

### `src/enml-converter.js` (Coder B)
- [ ] `<en-media hash="abc" type="image/png"/>` with matching resource → `<img src="name:part1" />`.
- [ ] `<en-media hash="abc" type="application/pdf"/>` → `<object data="name:part1" type="application/pdf" ...>`.
- [ ] `usedResources[n].partName` matches the reference in `html`.
- [ ] Unmatched hash → `[attachment]` literal.
- [ ] `toOneNoteHtml` escapes `<`, `>`, `&`, `"` in title.

### `src/progress.js` (Coder A)
- [ ] v1 input auto-migrates to v2 on load (existing keys preserved, `onenote_page_id: null`).
- [ ] `saveProgress` writes via `.tmp` + `rename` (atomic).
- [ ] `verifyImport` returns false when pageId is null or GET is non-2xx; true only on 2xx.
- [ ] `markImported` creates the file-record if missing.

### `src/index.js` (Coder A)
- [ ] `--auth` runs device-code and exits 0 without touching `.enex` files.
- [ ] Single-file mode: `node src/index.js file.enex` creates notebook named after file.
- [ ] `--batch <dir>` discovers all `*.enex` case-insensitively and processes each.
- [ ] `--resume` skips only notes where `verifyImport` returns true.
- [ ] `--force-reimport` overrides `--resume` skip logic.
- [ ] `--year-sections` routes notes to sections by `yearFromCreated(note.created)`; notes without year go to `"Imported"`.
- [ ] Section overflow (507 / 30102) auto-creates `"<name> (N)"` and retries the page.
- [ ] Progress saved after **every** note (not batched).
- [ ] `--verify` prints reconciliation table; exits 1 on any mismatch.
- [ ] `--output-html <dir>` produces one `.html` per note under `<dir>/<notebook>/<title>.html` with collision suffixes.

### End-to-end
- [ ] A 100-note ENEX file imports cleanly on first run after a single `--auth`.
- [ ] Killing mid-import and re-running with `--resume` completes remaining notes with no duplicates in OneNote.
- [ ] Oracle directory (`all-notes/`) notes match imported content structurally.

---

## 8. Test-Ownership

| Test file | Owner | Covers |
|---|---|---|
| `tests/auth.test.js` | Coder C | device-code mock, silent acquire, env-var fallback |
| `tests/onenote-client.test.js` | Coder B | retry matrix, multipart shape, pagination |
| `tests/enml-converter.test.js` | Coder B | en-media resolution, escape, unmatched hash |
| `tests/progress.test.js` | Coder A | v1→v2 migration, atomic write, verifyImport branches |
| `tests/cli.test.js` | Coder A | flag parsing, mode detection |
| `tests/batch-html-resume.test.js` | Coder A | batch + --output-html + --resume interaction |
| `tests/enex-parser.test.js` | shared | 100MB guard, single-note vs array |

Integration harness: `npm test` (no extra deps). Fixture ENEX files live under `tests/fixtures/`.

---

## 9. Risks and Open Questions

1. **MSAL token scope drift.** If Microsoft tightens consent for personal accounts, `Notes.Create` may require re-consent. Mitigation: document re-run of `--auth`.
2. **Section page limit.** Empirically ~200 pages/section but undocumented; 30102/507 is our only signal. Overflow code-path is load-bearing.
3. **`createNotebook` reuse-by-name** is case-sensitive in Graph — same filename with different casing in two `.enex` files would clash; we rely on OS filesystem case semantics upstream.
4. **Resource dedup across notes** not implemented — the same image in 10 notes is uploaded 10 times. Acceptable for v2; defer optimisation.

---

```json
{
  "files": [
    "src/index.js",
    "src/progress.js",
    "src/onenote-client.js",
    "src/enml-converter.js",
    "src/auth.js",
    "src/enex-parser.js"
  ],
  "external_apis": [
    "Microsoft Graph OneNote API v1.0",
    "Microsoft Identity Platform (MSAL device-code + silent)"
  ],
  "auth_method": "MSAL device-code with persistent cache + silent refresh; legacy ONENOTE_ACCESS_TOKEN env-var fallback",
  "acceptance_criteria": [
    "Zero user intervention after one-time --auth",
    "401 triggers silent token refresh mid-import",
    "429 honours Retry-After header with exponential-backoff fallback",
    "--resume verifies each claimed import against OneNote before skipping",
    "Section overflow (507/30102) auto-creates '<name> (N)' and retries",
    "Progress file written atomically after every note (tmp + rename)",
    "v1 progress.json auto-migrates to v2 on load",
    "Multipart createPageWithAttachments preserves <en-media> as <img>/<object> with matching partName",
    "--verify exits non-zero on any source/OneNote count mismatch",
    "100MB .enex guard prevents OOM"
  ],
  "edge_cases_addressed": [
    "filename collisions (--output-html: ' (N)' suffix)",
    "section overflow (30102 → overflow-section retry)",
    "partial failures (atomic progress.json, verifyImport on resume)",
    "resume after crash (progress.json + verifyImport)",
    "unicode/special chars in names (sanitizeName)",
    "large datasets (paginated listNotebooks/Sections/Pages via @odata.nextLink)",
    "empty/null fields (default 'Untitled', '<p></p>' body)",
    "unmatched en-media hashes ('[attachment]' literal, no throw)",
    "ENEX > 100MB (parser throws, loop continues)",
    "401 mid-import (silent refresh once, then fail)",
    "v1 progress schema (auto-migration, forced re-verify)"
  ]
}
```
