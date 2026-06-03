# Unify CLI and Desktop around a shared engine — Design

**Date:** 2026-06-03
**Status:** Approved (design); pending spec review → implementation plan
**Author:** Claude (brainstorming session with John Moore)

## Problem

The repository holds two products on **unrelated git histories** (no merge-base):

- `master` (checked out locally, full history, PRs #1–#17): the CLI `evernote-to-onenote` **v1.4.2**, with the full test suite (566 tests, 559 pass / 7 skip / 0 fail).
- `main` (GitHub **default** branch, orphan, 2 commits): the Electron desktop app `evernote-to-onenote-desktop` **v1.0.4**, last commit 2026-05-18.

The desktop app copies the engine into `src/lib/` (4 of 6 files byte-identical to the CLI; `auth.js` and `progress.js` diverge) and **reimplements** the CLI's import loop in `src/import-runner.js`. Keeping two copies of the engine and two import loops in sync is the core pain.

## Goal

One shared engine consumed by two **first-class** front-ends — the CLI (published to npm) and the desktop app — in a single monorepo. Resolve the `auth`/`progress` divergence. Preserve the CLI's rich history and existing users' resumable `progress.json` ledgers.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Product strategy | Reconcile/unify; **both** front-ends first-class |
| Repo structure | **Full monorepo** with npm workspaces |
| Trunk history | Keep **master** (CLI) history as the trunk |
| Default branch | Rename trunk `master` → **`main`**; set as GitHub default |
| Versioning | **Independent** per-package |
| Engine boundary | **Approach A** — auth-agnostic engine + shared event-emitting import core |
| Engine distribution | **Publish engine to npm** as its own package |

## Architecture (Approach A)

```
evernote-to-onenote/              # repo root · default branch: main (was master)
├─ package.json                   # private root; "workspaces": ["packages/*","apps/*"]
├─ .github/workflows/             # ci.yml + publish.yml, reworked for workspaces
├─ docs/                          # ARCHITECTURE.md updated to the 3-package model
├─ packages/
│  ├─ engine/                     # shared machinery — pure, no terminal/Electron
│  │  ├─ package.json             # name "@e2o/engine" (or published name), independent version
│  │  ├─ src/
│  │  │  ├─ enex-parser.js  enml-converter.js  onenote-client.js
│  │  │  ├─ progress.js           # env-overridable path (superset of both copies)
│  │  │  ├─ parallel.js  tags.js  local-cache-reader.js
│  │  │  ├─ auth-core.js          # NEW: silent acquire + MSAL cache; config injected
│  │  │  ├─ import-core.js        # NEW: event-emitting import loop (no I/O)
│  │  │  └─ index.js              # public API barrel
│  │  └─ tests/                   # engine-level tests (most of today's suite)
│  └─ cli/                        # evernote-to-onenote (npm) — continues 1.4.2
│     ├─ package.json             # bin: evernote-to-onenote; dep on engine
│     ├─ src/ index.js  auth-cli.js (device-code)  ui.js
│     └─ tests/                   # cli.test.js, cli-from-local, ui.test.js
└─ apps/
   └─ desktop/                    # evernote-to-onenote-desktop — continues 1.0.4
      ├─ package.json             # electron + electron-builder; dep on engine
      ├─ src/ main.js  preload.js  auth-desktop.js (browser-PKCE)
      │       import-runner.js (thin event→IPC adapter)  renderer/
      └─ build/
```

**Boundary rule:** the engine never touches a terminal, a browser, or Electron. Anything that prints, prompts, opens a window, or opens a browser lives in a front-end. The engine exposes functions and emits events; front-ends render them.

## Engine public API

- **Parse/convert:** `parseEnexFile`, `enmlToHtml`, `enmlToHtmlWithResources`, `toOneNoteHtml`
- **Graph client:** `OneNoteClient` (unchanged — already takes an injected `getToken`)
- **Progress ledger:** `loadProgress`, `saveProgress`, `markImported`, `isImported`, `verifyImport` (path from `E2O_PROGRESS_FILE`, default `./progress.json`)
- **Concurrency:** `runParallel`, `createGlobalBackoff`
- **Tags / local cache:** `tags` helpers, `readLocalCache` (the `--from-local` SQLite reader)
- **`auth-core`:** `createTokenProvider({ clientId, authority, cachePath, acquireInteractive })` → `getToken(forceRefresh?)`. Silent-first via MSAL; on a miss calls the front-end's injected `acquireInteractive()`. Engine owns the cache + silent path; it never picks a flow, authority, or client ID — those are front-end config.
- **`import-core`:** `importNotes({ notes, client, progress, options, noteKeyFn, onEvent })` — the loop extracted from the CLI's `index.js`, emitting structured events: `noteStart`, `noteImported`, `noteSkipped`, `conflict`, `sectionOverflow`, `fileDone`, `error`. CLI subscribes → terminal; desktop subscribes → IPC to renderer. Replaces today's reimplemented loop in `import-runner.js`.

## Auth model

Two genuinely different interactive flows, kept in the front-ends:

| | CLI (`auth-cli.js`) | Desktop (`auth-desktop.js`) |
|---|---|---|
| Interactive flow | Device-code (terminal) | Authorization-code + PKCE (system browser + localhost loopback) |
| Authority | `consumers` (personal MS only) | `common` (personal + work/school) |
| Client ID | Azure CLI public client `04b07795-…` | Own Entra app `824932cc-…` |
| Cache path | package/cwd default | `userData` via `E2O_MSAL_CACHE` |
| Browser opener | n/a | injects `openBrowser(url)` |

`auth-core` (engine) centralizes the shared MSAL plumbing: `PublicClientApplication` setup, persistent cache at the injected path, `acquireTokenSilent`, and the `getToken(forceRefresh)` contract `OneNoteClient` already expects. Each front-end injects its config + `acquireInteractive()`.

## Backward-compatibility (two traps)

1. **Resume ledger key must not change format.** CLI `noteKey` = `filename::title::created`; desktop = `sectionId::filename::title::created`. `import-core` accepts an injected **`noteKeyFn`**, so each front-end preserves its historic format and no existing `progress.json` breaks under `--resume`.
2. **Progress + cache paths are supersets, not changes.** `E2O_PROGRESS_FILE` defaults to `./progress.json` (CLI unchanged); desktop points it at `userData`. Same pattern for `E2O_MSAL_CACHE`.

## Versioning & publishing

Independent per-package. For the published CLI to resolve its engine dependency when installed via npm, the **engine is published to npm as its own package** (independent version). CLI and desktop both pin a normal semver range; local dev uses the workspace symlink. `electron-builder` packs `node_modules`, so the desktop build resolves the symlink at build time.

`publish.yml` publishes **engine first, then CLI** (so the CLI's engine dep resolves), each gated on the existing idempotent version-already-exists check (PR #2).

## Testing & CI

- Today's 566 tests stay green — they move (import paths rewired), they don't change behavior. Engine tests → `packages/engine/tests`; CLI tests → `packages/cli/tests`.
- New tests: `import-core` event sequencing; `auth-core` silent/interactive split (injected fake `acquireInteractive`); a thin desktop `import-runner` adapter test (desktop has none today).
- Root `npm test` runs all workspaces (`npm test --workspaces`). `ci.yml` runs the matrix at the root.

## Migration sequence

Executed on the trunk; each step keeps the suite green before the next:

1. Scaffold the workspace skeleton (root `package.json`, `packages/`, `apps/`).
2. Move engine files into `packages/engine`; apply `progress.js` env-path superset; split `auth.js` → `auth-core` (engine) + `auth-cli` (CLI device-code).
3. Extract `import-core` from CLI `index.js`; rewire `index.js` to consume `import-core` + `auth-cli` via injected `noteKeyFn`; move CLI tests; suite green.
4. Bring desktop files from `origin/main` into `apps/desktop`; repoint at the engine package; replace `import-runner.js` internals with `import-core` (keep its event→IPC adapter); split desktop auth → `auth-desktop` over `auth-core`.
5. Rewire all test imports; full suite green (566 + new).
6. Update `ci.yml`/`publish.yml` for workspaces; update `docs/ARCHITECTURE.md`.
7. **Cutover:** tag the old orphan desktop branch as `archive/desktop-v1.0.4`; rename `master` → `main`; force-update remote `main` to the unified trunk; set GitHub default; delete stale branches.

**Irreversible action:** step 7 rewrites remote `main`. The current `main` (desktop orphan) is preserved as `archive/desktop-v1.0.4` first. The history-replacing push will not run without explicit go-ahead.

## Out of scope (YAGNI)

- The `typescript-rewrite-spike-2026-05-03` branch — not part of this work; leave as-is.
- Resource dedup across notes (pre-existing deferred optimization, ARCHITECTURE.md §9).
- Any new product features — this is a structural reconciliation only.

## Open risks

1. **Force-updating remote `main`** is the one destructive step; mitigated by the archive tag and an explicit confirmation gate.
2. **Engine API surface** must cover every call sites in both `index.js` and `import-runner.js`; step 3/4 verify by getting the suite green, not by inspection alone.
3. **Engine package name** (`@e2o/engine` scope vs an unscoped name) to be finalized at implementation time based on npm availability.
