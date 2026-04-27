# Evernote to OneNote

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

A transparent, scriptable, resumable CLI from JMS Dev Lab that migrates your entire Evernote export into Microsoft OneNote in a single command — with receipts. The open-source alternative to Evernote's own migration path: you can see what will happen before it happens, stop and resume at any point, and script around it.

---

## Install

```sh
npm install -g github:mooja77/evernote-to-onenote
```

Requires Node.js 18 or later. No other runtime dependencies.

---

## Quickstart

**Not technical?** Run `evernote-to-onenote --guided` (or just `evernote-to-onenote` with no arguments). The guided mode will walk you through finding your `.enex` files step by step, including instructions for exporting them from Evernote.

**Recommended first-run flow:**

**1. Authenticate with Microsoft (once)**
```sh
evernote-to-onenote --auth
```
Follow the device-code prompt. Your token is cached in `msal-cache.json` and silently refreshed during long imports.

**2. Preview what will be imported (no data sent)**
```sh
evernote-to-onenote --batch ./Evernote-Export --dry-run
```
Prints a projected per-notebook summary and saves it to `dry-run-report.txt` in the current directory. Nothing is written to OneNote — confirmed in the report with "No data was sent to Microsoft."

**3. Run the import**
```sh
evernote-to-onenote --batch ./Evernote-Export
```
Progress is saved after every note. If the run is interrupted, resume with `--resume`.

**4. Verify the import (optional)**
```sh
evernote-to-onenote --verify
```
Reconciles `progress.json` against live OneNote page counts. Exits 0 if all counts match.

---

## Features

- **Resumable.** `progress.json` checkpoints every imported note with a tri-state verify (`exists` / `missing` / `unknown`). `--resume` skips already-imported notes; `--force-reimport` overrides.
- **Parallel imports.** `--concurrency N` (default 3, max 8) runs multiple workers with a shared rate-limit-aware token bucket. ~3× throughput on large exports.
- **Conflict detection.** Four strategies for duplicate page titles: `skip` (default), `rename`, `overwrite`, `ask`.
- **Tags migration.** Evernote tags become searchable `#hashtag` footers in OneNote pages (Graph API has no first-class tag endpoint on consumer tier).
- **Metadata preservation.** Evernote GUID, creation date, update date, author, and source URL are embedded in a structured header on each page — easy to find, easy to strip.
- **Selective import.** Filter by notebook glob (`--notebooks "Work-*"`), date range (`--date-range 2020-01-01..2023-12-31`), or skip specific notebooks.
- **Dry-run preview.** See projected notebook/section/page counts, conflict distribution, and potential issues before a single API call is made.
- **Batch mode.** Point at a directory of `.enex` files and import everything.
- **HTML export.** `--output-html <dir>` converts notes to HTML locally without touching OneNote — useful for auditing or custom pipelines.
- **Section overflow handling.** OneNote sections have an empirical ~200-page limit; the importer automatically creates overflow sections (`<name> (2)`, `<name> (3)`, …).
- **Year-based sections.** `--year-sections` organises each notebook's notes into per-year sections (2018, 2019, …).
- **MSAL device-code auth** with silent token refresh — no manual token copying, no mid-import re-authentication prompts.

---

## CLI Reference

```
Usage:
  evernote-to-onenote --auth                     Authenticate with Microsoft (first-time setup)
  evernote-to-onenote --batch <dir> --dry-run    Preview what will be imported (no data sent)
  evernote-to-onenote --batch <dir>              Run the import
  evernote-to-onenote --verify                   Reconcile progress.json vs OneNote
  evernote-to-onenote                            Guided mode (prompts for folder path)

Options:
  --guided               Enter guided setup — prompts for folder path and confirms before starting.
                         Same as running with no arguments on a terminal. Useful in scripts that
                         need to pipe input but want the friendly guided experience.
  --auth                 Authenticate with Microsoft and cache token, then exit
  --batch <dir>          Import all .enex files from a directory
  --resume               Skip already-imported notes (verified via OneNote API)
  --force-reimport       Re-import even if already recorded in progress.json
  --dry-run              Preview import without calling the OneNote write API
  --report <path>        Save dry-run summary to a file (default: ./dry-run-report.txt).
                         Only active with --dry-run. The report confirms no data was sent.
  --no-report            Do not write a dry-run report file (useful in CI or scripted runs)
  --verify               Print reconciliation table vs OneNote (can be standalone)

  --year-sections            Organise notes into sections by year (e.g. 2018, 2019)
  --output-html <dir>        Export converted HTML to a folder (no API needed)
  --notebooks <pattern>      Comma-separated list or glob pattern to filter notebooks
                             in batch mode. Example: --notebooks "Work-*,Personal"
  --date-range <range>       Only import notes in range, e.g. 2020-01-01..2023-12-31
  --tags-strategy <s>        How to migrate tags:
                               page-metadata (default) — #hashtag footer on each page
                               section-groups          — one section-group per tag
  --on-conflict <mode>       How to handle a page that already exists in OneNote:
                               skip (default) — log and continue
                               rename         — append ' (imported YYYY-MM-DD)'
                               overwrite      — delete then re-create
                               ask            — prompt interactively
  --concurrency <N>          Parallel workers per notebook (default: 3, max: 8)
  --no-preserve-metadata     Omit creation date, author, and source URL from headers

  --help                     Show this help text
  --version                  Print version and exit
```

### Examples

```sh
# Import a single notebook
evernote-to-onenote MyNotes.enex

# Batch import with parallel workers
evernote-to-onenote --batch ./exports --concurrency 5

# Only import work notebooks from 2022 onwards
evernote-to-onenote --batch ./exports --notebooks "Work-*" --date-range 2022-01-01..2099-12-31

# Preview conflicts before committing
evernote-to-onenote --batch ./exports --dry-run --on-conflict rename

# Export HTML locally without touching OneNote
evernote-to-onenote --batch ./exports --output-html ./html-preview

# Resume after interruption
evernote-to-onenote --batch ./exports --resume

# Verify what's in OneNote vs progress.json
evernote-to-onenote --verify
```

---

## How It Works

1. **Parse** — each `.enex` file is read with `src/enex-parser.js`, which extracts note metadata, ENML body, and binary resources (images, PDFs, etc.).
2. **Convert** — `src/enml-converter.js` transforms ENML to OneNote-compatible HTML, inlining resource references and applying the metadata header / tag footer.
3. **Authenticate** — `src/auth.js` uses MSAL device-code flow on first run and silently refreshes the token on subsequent runs.
4. **Import** — `src/onenote-client.js` creates notebooks/sections/pages via Microsoft Graph, with exponential backoff, rate-limit respect, and `@odata.nextLink` pagination.
5. **Checkpoint** — `src/progress.js` records every imported note with a stable key (`filename::title::created`). Re-running with `--resume` reads this file and skips verified entries.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for module contracts and the full dependency graph.

---

## FAQ

**Q: Why not use Evernote's official migration tool?**
The official tool is a black box — no preview, no resume, no logs. This CLI shows you exactly what will happen before it does it, saves progress after every note, and lets you script around it.

**Q: Can I migrate just some notebooks?**
Yes. Use `--notebooks "Work-*,Archive"` (comma-separated names or glob patterns). Use `--date-range` to further filter by creation date.

**Q: What happens to my Evernote tags?**
Tags are written as `#hashtag` footers at the bottom of each OneNote page. Microsoft Graph's consumer-tier API has no first-class tag endpoint, but hashtags are fully searchable inside OneNote. Use `--tags-strategy section-groups` if you prefer a separate section per tag instead.

**Q: Will it create duplicates if I run it twice?**
No, as long as you use `--resume`. The importer records a stable key per note and skips any key already verified in OneNote. Use `--on-conflict skip` (the default) if you run without `--resume`.

**Q: Can I do incremental sync (only new notes since last run)?**
Not yet. Evernote's `.enex` export format doesn't support delta exports — it's always a full snapshot. See [`--date-range`](#cli-reference) for a date-based filter. Incremental sync is on the backlog pending Evernote API access.

**Q: Is two-way sync (OneNote → Evernote) supported?**
No, and it's not planned. Most users are migrating away from Evernote. The tool is intentionally one-way.

**Q: What about a GUI or web app?**
Not in v1.0. The CLI is the foundation. A GUI wrapper is on the v1.1+ backlog.

**Q: What Microsoft account types are supported?**
Personal Microsoft accounts (consumer tier). Microsoft 365 / Entra ID (work/school) accounts are not tested and may have different API behaviour.

**Q: Does this upload my notes anywhere except OneNote?**
No. The tool runs locally. Live imports send converted note content to Microsoft Graph so OneNote pages can be created. Dry runs and HTML export mode do not write to OneNote. See [PRIVACY.md](PRIVACY.md).

**Q: Can I post my export or logs in a GitHub issue?**
Do not post real notebooks, `progress.json`, `msal-cache.json`, `.access-token`, or logs with private titles/content. Use a tiny synthetic `.enex` fixture instead.

---

## Troubleshooting

### Auth token expired mid-import
The MSAL silent refresh should handle this automatically. If you see `401 Unauthorized` errors, run `--auth` again to force a fresh token, then re-run with `--resume`.

### `507 Insufficient Storage` or `30102` errors
OneNote sections have an empirical limit of ~200 pages. The importer handles this automatically by creating overflow sections. If you see this error, ensure you are on the latest version.

### Page POST timeout (large attachments)
Large attachments can take up to 30s per page. The importer uses a 120s per-request timeout. If you are consistently hitting timeouts, try splitting the `.enex` into smaller files before importing.

### `429 Too Many Requests`
The rate-limit-aware token bucket backs off automatically. Reduce `--concurrency` if you are consistently seeing 429s (default 3 is conservative; try 1 for very large imports).

### Section DELETE 503 (consumer tier)
If using `--on-conflict overwrite`, the old page DELETE can return 503 on consumer accounts. The importer retries up to 3 times then falls back to `rename` with a warning. This is a known Graph API quirk on the consumer tier.

### Progress file is corrupted / missing entries
Run `--verify` to reconcile `progress.json` against live OneNote state. Then re-run with `--resume` to fill gaps.

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, test instructions, and the PR process.

---

## License

MIT — see [LICENSE](LICENSE).
