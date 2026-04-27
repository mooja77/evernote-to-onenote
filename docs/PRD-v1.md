# Evernote → OneNote Importer — PRD v1.0 (world-class open-source release)

**Status:** Draft for coder handoff
**Author:** Architect (supervisor agent)
**Date:** 2026-04-20
**Supersedes (extends):** `docs/ARCHITECTURE.md` (v2 — still source of truth for stable module contracts not changed below)
**Consequence tier:** readonly (no code is modified by this step)

---

## 0. Discrepancy flag

Operator brief specifies "step_index 0 MUST be domain-research on Microsoft Graph OneNote" and this PRD step consumes its output. No file under `docs/` matches `*research*` / `*DOMAIN*` at the time of writing. This PRD is produced from:

1. The existing codebase (6 src modules, 170 tests, progress.json v2).
2. Publicly-known Graph OneNote constraints (§2 below).

**Action for coordination:** when the domain-research artifact lands, reconcile §2 "Graph platform constraints" and the conflict / tags design against it. Any contradiction → treat research as authoritative, revise PRD, re-open affected acceptance criteria.

---

## 1. Vision — what "world-class" means for v1.0

One-sentence pitch: *a transparent, scriptable, resumable, community-maintained CLI that moves a user's entire Evernote export into OneNote in a single command — with receipts.*

A first-time visitor to the GitHub repo must see:

- Clear README with one-paragraph "what this is", 60-second install, 3-command quickstart.
- LICENSE (MIT), CONTRIBUTING.md, CODE_OF_CONDUCT.md, CHANGELOG.md.
- CI badge (passing), npm version badge, Node version support matrix.
- `npm install -g evernote-to-onenote` → `evernote-to-onenote --auth` → `evernote-to-onenote ./exports/` works with zero friction.
- Open issue template, PR template, at least 3 "good-first-issue" tickets seeded.

The differentiator vs Evernote's own migration tool: **transparency + resumability + scriptability**. Users see what will be imported before it happens (`--dry-run` / preview), can stop and resume, can script around it, and can read the code.

## 2. Graph platform constraints (taken as given; reconcile with step-0 research)

| Constraint | Impact | Design consequence |
|---|---|---|
| Consumer-tier OneNote has no `Notes.Tags` / labels API | Evernote tags cannot become first-class OneNote tags | Tags land as hashtag footer in page body (§5.2) |
| Section page limit empirically ~200 (signalled via 30102 / 507) | Large notebooks overflow | Keep existing `<name> (N)` overflow from v2 |
| Page POST can take up to ~30s for large attachments | Timeouts / perceived hangs | Per-request timeout ≥ 120s, logged progress; no silent wait |
| 429 with `Retry-After` is common under concurrency | Parallel imports will hit it | Token-bucket limiter shared across workers (§5.3) |
| Consumer tier DELETE on sections returns 503 intermittently | Cannot rely on cleanup APIs | v1.0 never deletes; `--rollback` is explicitly OUT |
| `@odata.nextLink` pagination, NOT `$skip` beyond first page | Already handled in v2 | Keep existing client behaviour |
| Access tokens expire ~1h; refresh tokens ~90d of inactivity | Long imports | Existing MSAL silent-refresh; force-refresh on 401 |

---

## 3. MVP scope — IN / OUT matrix

### 3.1 IN — v1.0 ships with these

| Feature | Why it matters | Owner module (§7) |
|---|---|---|
| Tags migration (Evernote → hashtag footer + searchable metadata) | Tags are the #1 thing users ask about migrating | `metadata.js` (new) |
| Per-note metadata preservation (author, createdDate, updatedDate, sourceURL) | Feels "lossless" — differentiator vs Evernote's own tool | `metadata.js` (new) |
| Conflict detection + strategies (`--on-conflict=skip|rename|update`) | Prevents duplicates and supports re-imports across libraries | `conflict.js` (new) |
| Bounded parallel imports (`--concurrency N`, default 3, max 8) | 3-5× throughput on large imports | `pool.js` (new) |
| Rate-limit-aware shared token bucket | Parallel imports mustn't dog-pile 429 | `pool.js` (new) |
| Selective import: `--notebooks <glob>`, `--since <ISO>`, `--until <ISO>`, `--tags <csv>` | Real users want partial migrations | `filters.js` (new) |
| Enhanced `--dry-run` preview (projected notebooks/sections/pages, conflict count, total bytes, tag distribution) | Builds trust — "what will happen" before "it happened" | `index.js` + `preview.js` (new) |
| Structured JSON logs (`--log-format=json`) | Community tooling + grep-ability | `log.js` (new) |
| npm package with `bin` entry (`evernote-to-onenote`) | Standard install path | `package.json` + `bin/cli.js` |
| LICENSE (MIT), CONTRIBUTING.md, CHANGELOG.md, CODE_OF_CONDUCT.md | Professional-feeling repo | root files |
| GitHub Actions CI (lint + test on Node 20/22, Windows/Linux) | Contributor confidence | `.github/workflows/` |
| Issue + PR templates | Lower barrier to contribute | `.github/ISSUE_TEMPLATE/` |
| README rewrite (install / quickstart / FAQ / troubleshooting) | First impression | root |
| Expanded `--help` with examples | Discoverability | `cli.js` (new) |

### 3.2 OUT — explicitly backlog (v1.1+)

| Feature | Why deferred | Revisit trigger |
|---|---|---|
| Incremental / delta sync | Evernote `.enex` export has no delta; would need Evernote API creds | Evernote exposes delta export |
| Two-way sync (OneNote → Evernote) | Evernote is dying / users are migrating OFF it; inverted value | Unlikely; permanent backlog |
| GUI / Electron wrapper | Massive scope, 3-5× repo size, distracts from CLI polish | 1k GitHub stars + demand |
| Web / SaaS offering | OAuth multitenancy + infra costs | Post-v1.0 commercial decision |
| Direct Evernote API ingest (bypass `.enex` export) | Evernote API creds + ToS friction | Unknown |
| Resource deduplication across notes | Uploads same image N times; cosmetic inefficiency | Post-v1.0 perf pass |
| `--rollback` / bulk delete | Graph consumer DELETE is 503-prone; unsafe | Platform fixes DELETE |
| OneNote-side cleanup / merge | Not a migration concern | Never |
| Windows/Mac `pkg` single-binary installers | Nice-to-have; `npm i -g` is acceptable for v1.0 | Post-launch if install friction reported |

### 3.3 Borderline calls (decisions and rationale)

- **Tags as section-group hierarchy** — rejected. Would explode every notebook into N section-groups, confuses OneNote navigation, harder to undo. Hashtag-footer + metadata comment is lossless, reversible, searchable.
- **Electron GUI** — rejected. Triples maintenance burden. Starring-worthy repos can be CLI-only (ripgrep, fzf).
- **`pkg` binaries** — deferred. npm-global install is Node-community-native. Revisit only if non-Node users ask.

---

## 4. Personas + top user journeys (drives acceptance criteria)

**Persona A — the Evernote refugee.** Has 5-15 years of notes, wants them in OneNote, willing to run one command. Cannot tolerate data loss or mystery failures.

*Journey:* `npm i -g evernote-to-onenote` → `--auth` → `--batch ./Evernote-Export/ --dry-run` (reads report) → `--batch ./Evernote-Export/` → grep logs for `[skip]` / `[fail]` → done.

**Persona B — the selective mover.** Only wants work notebooks, only notes from 2022+.

*Journey:* `... --batch ./export --notebooks "Work-*" --since 2022-01-01 --dry-run` → verify → run.

**Persona C — the resumer.** Killed the run overnight, wants to resume this morning.

*Journey:* `... --batch ./export --resume` → existing pages verified via pageId, new pages imported, no duplicates.

**Persona D — the contributor.** Wants to fix a bug for their own import, then open a PR.

*Journey:* clone → `npm test` → green → reads CONTRIBUTING.md → edits → tests + CI pass → PR merged within a week.

---

## 5. Architecture decisions (the load-bearing ones)

### 5.1 Parallel imports × atomic progress.json

**Problem.** v2 `progress.js` does atomic writes via `.tmp + rename`, assuming one writer. Parallel workers violate that.

**Decision.** Single-writer actor pattern. All `markImported` calls enqueue to an in-process `ProgressWriter` queue; the writer coalesces up to `N` pending marks into one write, then `rename`s. Workers never call `saveProgress` directly.

**Contract (new module `src/progress-writer.js`):**

```
new ProgressWriter(progress, filepath, { flushEveryMs = 250, flushEveryN = 10 })
  .mark(filename, key, pageId) → Promise<void>   // resolves when flushed to disk
  .flush() → Promise<void>                        // force immediate flush
  .close() → Promise<void>                        // flush + disallow further writes
```

Guarantee: if `mark(...)` resolves, the mark is durable on disk. If a worker crashes before its `mark` resolves, the page exists in OneNote but is NOT in progress.json → `--resume` + `verifyImport` will detect via title-match and reconcile (§5.5).

### 5.2 Tags + metadata rendering

**Decision.** Two fixed HTML regions per page:

```html
<!-- Header (prepended to body) -->
<div data-e2o-metadata>
  <p><small>
    Evernote GUID: <code>{guid}</code> ·
    Source: <a href="{sourceURL}">{sourceURL}</a> ·
    Author: {author} ·
    Created: {createdISO} ·
    Updated: {updatedISO}
  </small></p>
</div>

<!-- existing note HTML body -->

<!-- Footer (appended to body) -->
<div data-e2o-tags>
  <p><small>Tags: {#tag1 #tag2 #tag3}</small></p>
</div>
```

Rationale:
- Hashtags are searchable in OneNote's own search.
- `data-e2o-metadata` / `data-e2o-tags` attributes let future tooling (or `--rollback`) identify e2o-authored content.
- Fully reversible — a user who doesn't want it can strip on export.
- Zero dependency on Graph's unstable/absent tagging endpoints.

Null-safe: missing author/sourceURL/tags → skip that line, do not render empty `Tags: ` footer.

### 5.3 Rate-limit-aware concurrency

**Decision.** Global token bucket shared across workers.

- Steady-state target: 10 req/s (well under Graph's published soft limits).
- Burst: 20.
- On 429, bucket is paused for `Retry-After` seconds (or exponential backoff if header absent).
- Workers `await bucket.acquire()` before each fetch; no fetch bypasses the bucket.

`--concurrency` sets worker count (default 3). Bucket rate is independent — concurrency higher than bucket allows just queues. Max concurrency is hard-capped at 8.

### 5.4 Conflict detection

**Pre-import lookup.** For each target section, fetch `listPages(sectionId)` once, build `Map<title, pageId>`. For each incoming note:

1. `--force-reimport` → always create new (existing v2 behaviour).
2. Else if existing progress entry + `verifyImport` passes → skip (existing v2).
3. Else if title-match in section → apply `--on-conflict`:
   - `skip` (default, safest) — log and continue.
   - `rename` — append ` (imported YYYY-MM-DD)` and create.
   - `update` — delete existing page then create (uses Graph page PATCH if available, else DELETE+POST; logs a warning on consumer-tier DELETE flakiness).

**Edge case.** Multiple incoming notes with the same title: first claims the title, second gets ` (2)`, etc. Counter resets per section (consistent with `--output-html` behaviour).

### 5.5 Reconciliation on resume

Existing `--resume` only checks progress.json + pageId. With v1.0 parallelism, pages can exist on OneNote without a progress entry (crash window §5.1). Solution: on `--resume`, BEFORE import, if `--reconcile` flag present OR progress.json is missing entries for a file that has been partially imported (heuristic: any section for the file has pages): fetch `listPages` per section and reverse-map by title into progress.json. Cheap (one GET per section) and self-healing.

### 5.6 Selective import filters

Applied AFTER `parseEnexFile` and BEFORE import loop:

- `--notebooks "<glob>"` — matches on the enex filename (sans extension), glob syntax (`*`, `?`).
- `--since <ISO>` / `--until <ISO>` — filters by `note.created`. Notes without `created` pass only if `--include-undated` is set (default: dropped silently, logged at verbose).
- `--tags <csv>` — include if any tag matches (OR semantics). `--exclude-tags <csv>` drops if any tag matches.

Implemented as a pipeline of predicate functions in `filters.js`. Composable; unit-testable in isolation.

### 5.7 Dry-run preview

`--dry-run` emits a single report at end of run:

```
Dry run complete. No data sent to OneNote.

Files processed: 32
Notes parsed: 2073
Notes after filters: 1884
  filtered by --since: 189

Projected OneNote state:
  Notebooks to create: 2
  Notebooks to reuse:  1
  Sections to create:  38
  Pages to create:     1773
  Conflicts detected:  111  (--on-conflict=skip → would skip all 111)
  Total attachment bytes: 284 MiB

Tag distribution (top 10):
  #work     (412 notes)
  #receipt  (301 notes)
  ...

Potential issues:
  - 3 files exceed 100MB (will be skipped)
  - 27 notes have no created-date (routed to 'Imported' section)
```

Implementation: `preview.js` accumulates counters in a side-channel the same code path hits during real import; no duplication.

---

## 6. CLI flag matrix (v1.0 additions over v2)

| Flag | Value | Default | Scope |
|---|---|---|---|
| `--concurrency <N>` | int 1-8 | 3 | batch + single-file |
| `--on-conflict <strategy>` | skip / rename / update | skip | batch + single-file |
| `--notebooks <glob>` | string | `*` | batch |
| `--since <ISO>` | ISO-8601 date | none | batch + single-file |
| `--until <ISO>` | ISO-8601 date | none | batch + single-file |
| `--tags <csv>` | comma list | none | batch + single-file |
| `--exclude-tags <csv>` | comma list | none | batch + single-file |
| `--include-undated` | bool | false | batch + single-file (filters) |
| `--reconcile` | bool | false | `--resume` augment |
| `--log-format <fmt>` | human / json | human | always |
| `--log-level <lvl>` | error / warn / info / debug | info | always |
| `--no-metadata-header` | bool | false | escape hatch if user doesn't want §5.2 header |
| `--no-tag-footer` | bool | false | escape hatch |
| `--version` | bool | — | prints npm version, exits 0 |

All v2 flags (`--auth`, `--dry-run`, `--resume`, `--force-reimport`, `--year-sections`, `--verify`, `--output-html`, `--batch`, `--help`) remain unchanged.

`FLAGS_WITH_VALUES` extended: add `--concurrency`, `--on-conflict`, `--notebooks`, `--since`, `--until`, `--tags`, `--exclude-tags`, `--log-format`, `--log-level`.

---

## 7. File structure changes

### 7.1 New files

```
bin/
  cli.js                         # npm bin entry, #!/usr/bin/env node, delegates to src/cli.js
src/
  cli.js                         # argv parsing + help text (extracted from index.js)
  pool.js                        # bounded-concurrency worker pool + token bucket
  progress-writer.js             # single-writer actor over progress.js
  metadata.js                    # header / footer HTML rendering (§5.2)
  conflict.js                    # title-match lookup + strategy application (§5.4)
  filters.js                     # --notebooks, --since, --until, --tags predicates (§5.6)
  preview.js                     # dry-run report accumulator (§5.7)
  log.js                         # logger (human / JSON modes)
.github/
  workflows/ci.yml               # node 20 + 22, windows + ubuntu, npm test + lint
  ISSUE_TEMPLATE/
    bug_report.md
    feature_request.md
  PULL_REQUEST_TEMPLATE.md
LICENSE                          # MIT, John Moore / contributors
CONTRIBUTING.md                  # dev setup, test layout, PR checklist
CODE_OF_CONDUCT.md               # Contributor Covenant 2.1
CHANGELOG.md                     # Keep-a-Changelog format, starts at 1.0.0
SECURITY.md                      # vulnerability disclosure address
.eslintrc.json                   # eslint:recommended + node-standard
.npmignore                       # ship src/ + bin/ + LICENSE + README + CHANGELOG; exclude tests/ etc.
tests/
  pool.test.js
  progress-writer.test.js
  metadata.test.js
  conflict.test.js
  filters.test.js
  preview.test.js
  log.test.js
  cli.test.js                    # expanded: covers new flags
```

### 7.2 Modified files

- `src/index.js` — thinner; delegates to cli.js for parsing, uses pool/progress-writer instead of sequential loop. Existing behaviours preserved.
- `src/onenote-client.js` — add `deletePage(pageId)` (for `--on-conflict=update`), add `getPage(pageId)` (public method kept for progress-writer reconciliation; present internally today for verifyImport).
- `src/progress.js` — unchanged public API; progress-writer wraps it. Schema v3 = v2 + `onenote_page_title` per entry (enables reconciliation without Graph call).
- `package.json` — add `"bin": { "evernote-to-onenote": "bin/cli.js" }`, `"engines": { "node": ">=20" }`, `"files"`, `"keywords"`, `"repository"`, `"bugs"`, `"homepage"`, `"license": "MIT"`, `"version": "1.0.0-rc.1"`. Add dev deps: `eslint`.
- `README.md` — full rewrite per §8.
- `docs/ARCHITECTURE.md` — amend §2 contracts for new modules; add "v1.0 deltas" section linking to this PRD.

### 7.3 Dependency graph

```
bin/cli.js
  └─ src/cli.js
       └─ src/index.js  (main orchestrator)
            ├─ src/enex-parser.js      (unchanged)
            ├─ src/filters.js          (new)
            ├─ src/preview.js          (new)  [dry-run only]
            ├─ src/auth.js             (unchanged)
            ├─ src/pool.js             (new)
            │    └─ src/onenote-client.js  (slightly extended)
            │         ├─ src/enml-converter.js  (unchanged)
            │         └─ src/metadata.js        (new)
            ├─ src/conflict.js         (new) — uses onenote-client.listPages
            ├─ src/progress-writer.js  (new)
            │    └─ src/progress.js    (schema v3)
            └─ src/log.js              (new) — used by all above
```

No cycles. `log.js` is a leaf (zero deps on project modules).

---

## 8. README structure (v1.0)

Sections in order:

1. Hero — one paragraph + badges (CI, npm, Node).
2. Demo — 60-second terminal gif (`evernote-to-onenote --dry-run ./export`).
3. Install — `npm install -g evernote-to-onenote`.
4. Quickstart — 3 commands: `--auth`, `--dry-run`, real run.
5. Features — bulleted IN-scope list from §3.1.
6. CLI reference — abbreviated table, link to `--help` for full.
7. How it works — 5-sentence summary, link to `docs/ARCHITECTURE.md`.
8. FAQ — 6-10 Q&A drawn from anticipated issues (tags? incremental? GUI? 2-way? rate limits? resume?).
9. Troubleshooting — top 5 failure modes + fixes.
10. Contributing — link to CONTRIBUTING.md.
11. License — MIT link.

---

## 9. Acceptance criteria (per feature)

### Tags + metadata
- [ ] Page header shows GUID, Created, Updated, and — if present — Author, SourceURL.
- [ ] Page footer shows hashtags when `note.tags.length > 0`; absent otherwise.
- [ ] `--no-metadata-header` suppresses header; `--no-tag-footer` suppresses footer.
- [ ] Unicode tags (`#été`, `#日本語`) render unescaped but HTML-safe (`&` / `<` / `>` escaped).
- [ ] Tags with spaces are rendered as `#tag_with_space` (underscore substitution, documented).

### Conflict handling
- [ ] With `--on-conflict=skip`, duplicate titles do not create new pages; logged at `info`.
- [ ] With `--on-conflict=rename`, new page title is `<title> (imported YYYY-MM-DD)`; progress records both the new pageId and a `conflict_of: <originalTitle>`.
- [ ] With `--on-conflict=update`, existing page is deleted then re-created; on consumer-tier DELETE 503, retries up to 3 times then falls back to rename with warning.
- [ ] Within one section, incoming duplicates among the batch get ` (2)`, ` (3)` suffixes deterministically.

### Parallel imports
- [ ] `--concurrency 3` (default) runs 3 workers; verified via `log --log-level=debug` worker IDs.
- [ ] `--concurrency 9` rejected with error "concurrency must be 1-8".
- [ ] Under 429 storm (simulated in test), token bucket pauses all workers; no worker issues request while bucket is paused.
- [ ] No progress.json corruption after 1000-note parallel run (test: SHA of progress.json parses as valid JSON matching schema).

### Progress-writer + reconcile
- [ ] `ProgressWriter.mark(...)` resolves only after disk flush.
- [ ] Killing process mid-flush leaves either previous state or new state intact (no partial file); verified by fuzz test with SIGKILL.
- [ ] `--reconcile` with missing progress entries restores them from Graph listPages within one API call per section.
- [ ] Schema v2 input auto-migrates to v3 preserving all entries.

### Selective import
- [ ] `--since 2022-01-01 --until 2022-12-31` imports exactly the notes whose `created` falls in 2022.
- [ ] `--notebooks "Work-*"` imports only files matching the glob; `--batch` without the flag unchanged.
- [ ] `--tags work,urgent` imports notes tagged `work` OR `urgent`; `--exclude-tags archive` excludes any with that tag (intersected with --tags).
- [ ] `--include-undated` includes notes with missing `created` in `--since`/`--until` mode; default excludes them.

### Dry-run preview
- [ ] Dry-run emits report without any POST/DELETE to Graph (verified by mock); all GETs to Graph are `listPages`/`listSections`/`listNotebooks` only.
- [ ] Counts in the report match actual counts when subsequently re-run without `--dry-run` (within the ±1 tolerance for new conflicts introduced between runs).

### Logging
- [ ] `--log-format=json` emits one JSON object per line; every line parses.
- [ ] `--log-level=error` suppresses `info` and `warn`; `error` always visible.
- [ ] Every API call logged with `{level, ts, category:"api", method, url, status, duration_ms, attempt}` in JSON mode.

### Packaging + repo hygiene
- [ ] `npm install -g .` then `evernote-to-onenote --help` works on Windows + macOS + Linux.
- [ ] `npm publish --dry-run` includes `src/`, `bin/`, `LICENSE`, `README.md`, `CHANGELOG.md`; excludes `tests/`, `docs/`, `all-notes/`, `output/`, `progress.json`, `msal-cache.json`, `test.enex`, `import-log-*.txt`.
- [ ] GitHub Actions CI green on Node 20 and 22, Ubuntu and Windows.
- [ ] `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `SECURITY.md` present at repo root.
- [ ] `README.md` has: hero, install (`npm i -g`), 3-command quickstart, features, CLI reference link, FAQ, troubleshooting, contributing link, license.
- [ ] Three seeded `good-first-issue` tickets open on launch.

### End-to-end
- [ ] 32-file / 2073-note fixture imports to completion on first run, parallelism 3, without a single manual intervention after `--auth`.
- [ ] Same fixture killed at 50% and resumed with `--resume --reconcile` completes with zero duplicate pages on OneNote (verified by `--verify` reconciliation table).
- [ ] A 5000-note stress fixture completes in under 2× the serial-baseline runtime with `--concurrency 3` (expected ≥2.5× speedup).

---

## 10. Rollout

1. Branch `release/1.0.0-rc.1` from `master`.
2. Land changes in order: `log.js` → `progress-writer.js` (+ schema v3) → `pool.js` → `metadata.js` → `conflict.js` → `filters.js` → `preview.js` → `cli.js` extraction → `index.js` rewire → README + repo hygiene.
3. Each module ships behind tests before integration; no "big-bang" merge.
4. Release-candidate: publish `1.0.0-rc.1` to npm as tag `next`; request 3 external testers on GitHub Discussions.
5. Two weeks of RC → cut `1.0.0` with CHANGELOG entry, Git tag, GitHub release, Show HN post (operator-gated per user's "shy" preference — user decides Show HN).

---

## 11. Risks

1. **Parallel-write race on progress.json.** Mitigation: single-writer actor (§5.1) + fuzz test with SIGKILL.
2. **Graph consumer-tier rate limits undocumented.** Mitigation: conservative default (10 req/s, 3 workers), token-bucket visible in debug logs, easy to tune.
3. **`--on-conflict=update` hitting consumer DELETE 503.** Mitigation: 3 retries then rename fallback with warning; documented in FAQ.
4. **Tag encoding collisions** (e.g. `#work` vs `#Work` vs `#work_note`). Mitigation: preserve original case, document that OneNote search is case-insensitive.
5. **Test-suite bit-rot** with many new modules. Mitigation: every new module lands with tests (§7.1 test files listed).
6. **Domain-research output never materialises** (flagged in §0). Mitigation: reconcile before cut-release.

---

## 12. Out-of-scope clarifications (so coders don't accidentally build them)

- No changes to ENML parsing semantics. `enex-parser.js` is untouched.
- No changes to OneNote client retry matrix (§2.2 of v2) — parallel behaviour is additive.
- No new external dependencies except `eslint` (dev-only). Runtime deps unchanged.
- No telemetry, no anonymous analytics, no phone-home.
- No auto-update mechanism; rely on npm.

---

```json
{
  "files": [
    "bin/cli.js",
    "src/cli.js",
    "src/index.js",
    "src/pool.js",
    "src/progress-writer.js",
    "src/progress.js",
    "src/onenote-client.js",
    "src/enml-converter.js",
    "src/enex-parser.js",
    "src/auth.js",
    "src/metadata.js",
    "src/conflict.js",
    "src/filters.js",
    "src/preview.js",
    "src/log.js",
    "tests/pool.test.js",
    "tests/progress-writer.test.js",
    "tests/metadata.test.js",
    "tests/conflict.test.js",
    "tests/filters.test.js",
    "tests/preview.test.js",
    "tests/log.test.js",
    "tests/cli.test.js",
    "package.json",
    "README.md",
    "LICENSE",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "CHANGELOG.md",
    "SECURITY.md",
    ".eslintrc.json",
    ".npmignore",
    ".github/workflows/ci.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/ISSUE_TEMPLATE/bug_report.md",
    ".github/ISSUE_TEMPLATE/feature_request.md",
    "docs/PRD-v1.md",
    "docs/ARCHITECTURE.md"
  ],
  "external_apis": [
    "Microsoft Graph OneNote API v1.0",
    "Microsoft Identity Platform (MSAL device-code + silent)"
  ],
  "auth_method": "MSAL device-code with persistent cache + silent refresh (unchanged from v2)",
  "acceptance_criteria": [
    "npm install -g evernote-to-onenote then evernote-to-onenote --auth works on Win/macOS/Linux",
    "2073-note fixture imports on first run at concurrency 3 with zero manual intervention",
    "Kill + --resume --reconcile produces zero duplicates verified by --verify",
    "Evernote tags land as #hashtag footer; metadata header shows GUID/Created/Updated/Author/SourceURL",
    "--on-conflict=skip is default and never creates duplicates",
    "--on-conflict=rename appends ' (imported YYYY-MM-DD)' suffix",
    "--on-conflict=update falls back to rename on 3-consecutive consumer-tier DELETE 503",
    "--concurrency rejects values outside 1-8",
    "Shared token bucket pauses all workers on 429 with Retry-After",
    "Progress.json schema v2 auto-migrates to v3 preserving entries",
    "--dry-run emits preview without POST/DELETE to Graph, verified by mock",
    "--log-format=json emits one parseable JSON object per line",
    "GitHub Actions CI green on Node 20+22 Ubuntu+Windows",
    "Repo has LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, CHANGELOG, SECURITY at root",
    "npm publish --dry-run includes src/bin/LICENSE/README/CHANGELOG and excludes tests/docs/caches",
    "5000-note stress fixture achieves >=2.5x speedup over serial baseline at concurrency 3"
  ],
  "edge_cases_addressed": [
    "parallel-writer race on progress.json (single-writer actor)",
    "crash between Graph POST and progress.mark (reconcile via listPages)",
    "title collision within same section across incoming batch (deterministic ' (N)' suffix)",
    "title collision with existing OneNote content (--on-conflict strategies)",
    "consumer-tier DELETE 503 during --on-conflict=update (retry + rename fallback)",
    "unicode + special chars in tags (HTML-escape, space->underscore)",
    "notes without created date (dropped unless --include-undated)",
    "glob matching on enex filenames for --notebooks",
    "token-bucket shared across workers honouring Retry-After",
    "dry-run that never mutates remote state (verified by mock)",
    "v2 progress.json loads under v1.0 (auto-migrate to v3)",
    "process kill during progress flush (atomic rename preserves prior state)",
    "100MB ENEX guard preserved from v2 (parser throws, index.js continues)",
    "--verify reconciliation table exits non-zero on mismatch (preserved from v2)"
  ]
}
```
