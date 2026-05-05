# Evernote to OneNote

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/mooja77/evernote-to-onenote/actions/workflows/ci.yml/badge.svg)](https://github.com/mooja77/evernote-to-onenote/actions/workflows/ci.yml)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

Move your Evernote notebooks into Microsoft OneNote — safely, one step at a time. Preview before you import. Resume if anything interrupts. Nothing in Evernote is changed or deleted.

---

## What you will need

Before you start, make sure you have:

- **Node.js 20 or later** — [download from nodejs.org](https://nodejs.org)
- **A personal Microsoft account** — Outlook.com, Hotmail, or Live.
  > ⚠️ **Work and school accounts are not supported.** Microsoft 365 / Entra ID / corporate accounts will not work. You need a personal Microsoft account.
- **Your Evernote notebooks exported as `.enex` files** — see step 1 below.

---

## Install

```sh
npm install -g evernote-to-onenote
```

---

## Easiest start

If you are not technical, run the setup helper. It checks the basics, asks for your Evernote export folder, and starts with a safe preview only:

```sh
evernote-to-onenote setup
```

Nothing is written to OneNote during the setup preview. When the report looks right, the tool prints the exact import command to run next.

If you want to check your computer before starting, run:

```sh
evernote-to-onenote doctor
```

It reports your Node.js version, Microsoft sign-in state, current command folder, and any existing `progress.json`.

---

## First-time setup: 3 steps

### Step 1 — Export your notebooks from Evernote

In Evernote on your computer:

1. Right-click a notebook in the left panel.
2. Click **Export Notebook…** (or go to **File → Export Notes**).
3. Choose **ENEX format (.enex)** and save the file.
4. Repeat for each notebook you want to move.
5. Put all the `.enex` files in one folder (e.g. `.\Evernote-Export` on Windows or `./Evernote-Export` on Mac/Linux).

### Step 2 — Sign in to Microsoft (once)

```sh
evernote-to-onenote --auth
```

You will see a short URL and a code. Visit the URL, enter the code, and sign in with your **personal** Microsoft account. Your session is saved — you will not need to do this again.

### Step 3 — Preview, then import

**First, run a dry-run preview.** Nothing will be written to OneNote:

```sh
evernote-to-onenote --batch .\Evernote-Export --dry-run
```

You will see a list of notebooks and note counts. A report is saved to `dry-run-report.txt`. Check it looks right.

**Then run the actual import:**

```sh
evernote-to-onenote --batch .\Evernote-Export
```

Progress is saved after every note. If anything interrupts it (power cut, network drop), run with `--resume` to pick up where it left off:

```sh
evernote-to-onenote --batch .\Evernote-Export --resume
```

### Optional — verify the import completed

```sh
evernote-to-onenote --verify
```

Compares the number of notes imported against the number of pages in OneNote. Exits with a tick if everything matches.

---

## Which mode should I use?

There are two ways to read your notes — pick whichever applies:

| Mode | When to use it | Command |
|---|---|---|
| **`--batch`** *(recommended)* | You can export `.enex` files from Evernote (File → Export → ENEX). Highest fidelity — includes images, attachments, and full formatting. | `evernote-to-onenote --batch ./Evernote-Export` |
| **`--from-local`** | The Evernote API has been suspended on your account, you can't export `.enex`, and Evernote v10/v11 is installed on this computer. **Text-only:** images and attachments are not migrated. | `evernote-to-onenote --from-local` |

**Decision tree:**

1. Can you click **File → Export Notes → ENEX format** in Evernote and get a `.enex` file? **Yes →** use `--batch`.
2. Otherwise, is **Evernote v10 or v11** installed on this computer, and has it opened at least once while signed in? **Yes →** use `--from-local`.
3. Otherwise — install Evernote v10/v11, sign in once, and let it sync. Then re-run with `--from-local`.

`--from-local` reads Evernote's local cache file in **read-only** mode — your Evernote data is not changed. Close Evernote completely before running it, or you may see a "database locked" error.

If you started with `--from-local` but later get your `.enex` export working, just run `--batch` — the importer will skip notes already imported (`progress.json` tracks both modes).

---

## Not technical? Use guided mode

Run with no arguments for a step-by-step experience that asks for your folder path, shows you what it found, and starts with a safe preview:

```sh
evernote-to-onenote
```

Need more help before you start? See:

- [How to export Evernote notebooks](docs/EVERNOTE_EXPORT_GUIDE.md)
- [Clean-install smoke test notes](docs/USER_SMOKE_TEST_2026-04-28.md)
- [Demo script](docs/DEMO_SCRIPT.md)

---

## Features

- **Safe preview.** `--dry-run` shows exactly what would be imported. Nothing is written to OneNote until you remove the flag.
- **Resumable.** Every note is checkpointed. `--resume` skips notes already verified in OneNote.
- **Parallel imports.** `--concurrency N` (default 3) runs multiple workers. ~3× faster on large exports.
- **Conflict detection.** Four strategies for duplicate page titles: `skip` (default), `rename`, `overwrite`, `ask`.
- **Tags.** Evernote tags become searchable `#hashtag` footers in OneNote pages.
- **Metadata preservation.** Creation date, author, and source URL are embedded in a header on each page.
- **Selective import.** Filter by notebook name (`--notebooks "Work-*"`) or date range (`--date-range 2020-01-01..2023-12-31`).
- **HTML export.** `--output-html <dir>` converts notes to HTML files locally — no Microsoft account needed.
- **Section overflow.** OneNote sections have an ~200-page limit; the importer creates overflow sections automatically (`<name> (2)`, `<name> (3)`, …).

---

## All options

```
Usage:
  evernote-to-onenote --auth                     Sign in to Microsoft (once)
  evernote-to-onenote --batch <dir> --dry-run    Preview (nothing written to OneNote)
  evernote-to-onenote --batch <dir>              Run the import
  evernote-to-onenote --verify                   Check import completed correctly
  evernote-to-onenote doctor                     Check local setup and next steps
  evernote-to-onenote                            Guided step-by-step mode
  evernote-to-onenote setup                      Beginner setup helper

Options:
  --guided               Step-by-step prompts; starts with a safe preview
  --no-interactive       Never open prompts; print next-step usage instead
  --auth                 Sign in to Microsoft and save session, then exit
  --batch <dir>          Import all .enex files in a folder
  --dry-run              Preview — nothing is written to OneNote
  --report <path>        Save the dry-run summary to a file (default: ./dry-run-report.txt)
  --no-report            Skip the dry-run report file
  --resume               Skip notes already imported (checks OneNote to confirm)
  --force-reimport       Re-import all notes even if already in progress.json
  --verify               Compare progress.json against live OneNote page counts
  --doctor               Check local setup and next steps, then exit
  --year-sections        Organise notes by year (sections: 2018, 2019, …)
  --output-html <dir>    Save notes as HTML files locally (no account needed)
  --tags-strategy <s>    Tags as: page-metadata (default) or section-groups
  --on-conflict <mode>   Duplicate titles: skip (default), rename, overwrite, ask
  --concurrency <N>      Notes to import in parallel (default: 3, max: 10)
  --notebooks <pattern>  Only import notebooks matching a pattern: "Work-*,Personal"
  --date-range <range>   Only import notes in a date range: 2020-01-01..2023-12-31
  --no-preserve-metadata Omit creation date, author, source URL from headers
  --quiet                Suppress per-note output (for scripts)
  --version              Print version
  --help                 Show help
```

---

## What it looks like

![Evernote to OneNote help screenshot](https://raw.githubusercontent.com/mooja77/evernote-to-onenote/master/docs/assets/help-terminal.svg)

Running `--help`:

```
$ evernote-to-onenote --help

Evernote → OneNote Importer

Moves your Evernote notebooks (.enex files) into Microsoft OneNote.
Nothing is deleted from Evernote. Progress is saved after every note.

Requirements:
  • Node.js 20 or later
  • A personal Microsoft account (Outlook.com / Hotmail / Live)
    ⚠  Work/school accounts (Microsoft 365 / Entra ID) are NOT supported.
  • Evernote notebooks exported as .enex files
    (Evernote → right-click notebook → Export Notebook → ENEX format)

First-time setup (3 steps):
  Step 1 — Sign in to Microsoft:
    evernote-to-onenote --auth
  Step 2 — Preview what will be imported (nothing is written to OneNote):
    evernote-to-onenote --batch ./Evernote-Export --dry-run
  Step 3 — Run the import:
    evernote-to-onenote --batch ./Evernote-Export
```

Running a dry-run preview on a folder of `.enex` files (output from `node src/index.js --batch tests/fixtures --dry-run`):

![Evernote to OneNote dry-run screenshot](https://raw.githubusercontent.com/mooja77/evernote-to-onenote/master/docs/assets/dry-run-terminal.svg)

```
$ evernote-to-onenote --batch ./Evernote-Export --dry-run

Evernote → OneNote Importer

  ╔══════════════════════════════════════════════╗
  ║  DRY RUN — nothing will be written to OneNote  ║
  ╚══════════════════════════════════════════════╝
  This is a safe preview. No Microsoft API calls will be made.
  Remove --dry-run when you are ready to import for real.

  Files:    15 notebook(s)
  Mode:     DRY RUN (no API calls)
  Tags:     page-metadata


Importing file 1/15: minimal-note.enex → notebook "minimal-note"
  1 note(s) found
  [dry-run] Would create notebook: "minimal-note"
  → [file 1/15: minimal-note.enex] [note 1/1] "Minimal"
  [dry-run] Would create section: "Imported" in notebook dry-run-notebook-id
  [dry-run] Would create page: "Minimal" in section dry-run-section-id
  [████████████████████] 1/1 | 00:00 elapsed

Importing file 2/15: mixed-notes.enex → notebook "mixed-notes"
  3 note(s) found
  [dry-run] Would create notebook: "mixed-notes"
  → [file 2/15: mixed-notes.enex] [note 1/3] "Project Ideas"
  → [file 2/15: mixed-notes.enex] [note 2/3] "Meeting Notes — 2026-01-15"
  → [file 2/15: mixed-notes.enex] [note 3/3] "Recipe: Chocolate Cake"
  [dry-run] Would create page: "Project Ideas" in section dry-run-section-id
    Tags: ideas, work
  [███████░░░░░░░░░░░░░] 1/3 | 00:00 elapsed | ~00:00 remaining
    Tags: meetings
  [█████████████░░░░░░░] 2/3 | 00:00 elapsed | ~00:00 remaining
    Tags: personal, recipes
  [████████████████████] 3/3 | 00:00 elapsed

Importing file 3/15: unicode-titles.enex → notebook "unicode-titles"
  4 note(s) found
  [dry-run] Would create notebook: "unicode-titles"
  → [file 3/15: unicode-titles.enex] [note 1/4] "日本語のノート"
  → [file 3/15: unicode-titles.enex] [note 2/4] "📝 Meeting Notes 🚀"
  → [file 3/15: unicode-titles.enex] [note 3/4] "ملاحظات اجتماع المشروع"
  → [file 3/15: unicode-titles.enex] [note 4/4] "Ünïcödé Spécïàl Chàrś & Möre"
  [████████████████████] 4/4 | 00:00 elapsed

  ... (12 more notebooks processed) ...

─────────────────────────────────────────────
DRY RUN complete — nothing was written to OneNote.

What would be imported:
  • minimal-note                           1 note(s)
  • mixed-notes                            3 note(s)
  • multi-note                             3 note(s)
  • multi-tag                              3 note(s)
  • unicode-titles                         4 note(s)
  • with-metadata                          2 note(s)
  • with-resources                         1 note(s)
  • (8 more notebooks, including 1 empty)

  Total: 24 note(s) across 15 notebook(s)

When you are ready to import for real, remove --dry-run:
  evernote-to-onenote --batch <dir>

Dry-run report saved to: ./dry-run-report.txt
```

---

## Examples

```sh
# Import a single notebook file
evernote-to-onenote MyNotes.enex

# Batch import with 5 parallel workers
evernote-to-onenote --batch ./exports --concurrency 5

# Only import work notebooks from 2022 onwards
evernote-to-onenote --batch ./exports --notebooks "Work-*" --date-range 2022-01-01..2099-12-31

# Preview conflicts before importing
evernote-to-onenote --batch ./exports --dry-run --on-conflict rename

# Export to HTML locally (no Microsoft account required)
evernote-to-onenote --batch ./exports --output-html ./html-preview

# Resume after an interruption
evernote-to-onenote --batch ./exports --resume

# Verify what arrived in OneNote
evernote-to-onenote --verify
```

---

## How it works

1. **Parse** — each `.enex` file is read by `src/enex-parser.js`, which extracts note text, metadata, and attachments (images, PDFs, etc.).
2. **Convert** — `src/enml-converter.js` transforms Evernote's ENML format into OneNote-compatible HTML.
3. **Authenticate** — `src/auth.js` uses Microsoft's device-code flow on first run and silently refreshes the token on subsequent runs.
4. **Import** — `src/onenote-client.js` creates notebooks, sections, and pages via Microsoft Graph, with rate-limit backoff and pagination.
5. **Checkpoint** — `src/progress.js` records every imported note. Re-running with `--resume` reads this file and skips verified entries.

---

## Common questions

**Will this delete anything from Evernote?**
No. The tool only reads your `.enex` export files. Evernote is not connected to and nothing is changed there.

**Will it create duplicates if I run it twice?**
No, as long as you use `--resume`. The importer records a stable key per note and skips anything already verified in OneNote.

**What happens to my Evernote tags?**
Tags are written as `#hashtag` footers at the bottom of each OneNote page — fully searchable inside OneNote. Use `--tags-strategy section-groups` if you prefer a separate section per tag.

**Can I migrate just some notebooks?**
Yes. Use `--notebooks "Work-*,Archive"` (comma-separated names or glob patterns), or `--date-range` to filter by creation date.

**Can I stop and continue later?**
Yes. Progress is saved after every note. Run again with `--resume` to continue from where it left off.

**What Microsoft account do I need?**
A **personal** Microsoft account: Outlook.com, Hotmail.com, or Live.com. Work accounts (Microsoft 365, company email, university email) are **not** supported — this is a Microsoft API restriction on the consumer tier.

**Why not use Evernote's official migration tool?**
The official tool is a black box — no preview, no resume, no logs. This CLI shows you exactly what will happen before it does it, saves progress after every note, and lets you verify the result.

**Can I do incremental sync (only new notes since last run)?**
Not yet — Evernote's `.enex` export is always a full snapshot. Use `--date-range` for a date-based filter in the meantime.

---

## Troubleshooting

**On Windows?** See the dedicated [Windows troubleshooting guide](docs/WINDOWS-TROUBLESHOOTING.md) — it covers Node.js installation, PowerShell execution policy, PATH issues, and common `npm install` errors.

**"Work or school accounts are not supported"**
You must use a **personal** Microsoft account (Outlook.com / Hotmail / Live). Sign out of your work account in your browser and sign in with a personal account when prompted by `--auth`.

**Auth token expired mid-import**
Run `--auth` again to refresh your session, then continue with `--resume`.

**`507 Insufficient Storage` error**
Your OneDrive is full. Free up space at onedrive.live.com, then continue with `--resume`.

**`429 Too Many Requests`**
Microsoft is rate-limiting your requests. The importer backs off automatically. If it keeps happening, try `--concurrency 1` to slow down the import.

**Large attachment timeouts**
Notes with large attachments (images, PDFs) can take longer. The importer uses a 120-second timeout per note. If you are consistently hitting timeouts, try splitting the `.enex` file into smaller exports before importing.

**Progress file is missing or corrupted**
Run `--verify` to compare what is in OneNote against what was recorded. Then re-run with `--resume` to fill any gaps.

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, test instructions, and the PR process.

---

## License

MIT — see [LICENSE](LICENSE).
