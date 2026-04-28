# Wizard Mode Spec — EvernoteToOneNote
<!-- issue #9 — first-run experience for non-technical users -->

## Overview

The wizard is the default experience when the tool is run with no arguments on an
interactive terminal. It guides a non-technical user through every prerequisite and
decision before a single note is touched.

Scriptability is fully preserved:
- `--batch <dir>` bypasses the wizard entirely (existing behaviour, unchanged)
- `--no-interactive` explicitly skips the wizard even when running on a TTY
- `--guided` forces wizard mode even when other flags are present
- All existing flags continue to work as documented in `--help`

---

## Invocation conditions

| Command | Behaviour |
|---|---|
| `evernote-to-onenote` (TTY) | Wizard |
| `evernote-to-onenote --guided` | Wizard |
| `evernote-to-onenote --no-interactive` | Prints usage, exits 0 |
| `evernote-to-onenote --batch <dir>` | Direct mode, no wizard |
| `evernote-to-onenote --batch <dir> --dry-run` | Direct dry-run, no wizard |
| Piped / non-TTY | Short usage block, exits 0 (existing) |

---

## Screen flow

```
[STEP 0] Node.js version check (automatic, no prompt)
    │
    ▼
[STEP 1] Welcome banner + prerequisites
    │
    ▼
[STEP 2] Evernote export instructions
    │
    ▼
[STEP 3] ENEX folder selection (path + validation)
    │
    ├─ No .enex files found → re-prompt (max 5 attempts)
    │
    ▼
[STEP 4] Auth check → sign-in or skip to offline mode
    │
    ├─ Already signed in → show "✓ Signed in", continue
    ├─ Not signed in → offer to sign in now
    │   ├─ Y → open browser, wait, confirm, continue
    │   └─ N → offer offline (HTML) mode; if declined, exit
    │
    ▼
[STEP 5] OneDrive preflight (skipped in offline / dry-run mode)
    │
    ├─ Connectivity OK, personal account confirmed → continue
    ├─ Work/school account detected → explain + exit
    └─ Network error → warn, offer offline mode
    │
    ▼
[STEP 6] Dry-run preview
    │
    ├─ Runs dry-run, shows notebook list + note counts
    ├─ Saves dry-run-report.txt
    └─ Asks "Start the real import? [Y/n]"
        ├─ Y → import begins
        └─ N → exit, tells user the command to run later
```

---

## Step 0 — Node.js version check

**Trigger:** Automatic. Runs before any output or prompts.  
**No user prompt required.**

Check `process.versions.node` against the engine requirement (`>=20`).

### Happy path
Version ≥ 20 — continue silently.

### Error state: version 18.x or 19.x (warn, continue)
```
⚠  Node.js 18 detected. This tool requires Node.js 20 or later.
   It may work, but is unsupported. Upgrade at: https://nodejs.org
```
Continue to Step 1 (don't exit — experienced users may be intentionally testing).

### Error state: version < 18 (exit 1)
```
✗  Node.js 20 or later is required. You are running Node.js <VERSION>.

   Download the latest version from: https://nodejs.org
   (Choose the "LTS" version — the one labelled "Recommended for most users".)

   After installing, re-run: evernote-to-onenote
```
Exit code 1. No further output.

---

## Step 1 — Welcome banner + prerequisites

```
╔══════════════════════════════════════════════════╗
║         Evernote → OneNote Importer              ║
╚══════════════════════════════════════════════════╝

This tool moves your Evernote notes into Microsoft OneNote.
Nothing is deleted from Evernote — it only creates new pages in OneNote.
Progress is saved after every note. If interrupted, you can safely resume.

Before you start, you will need:

  ✓ Node.js 20 or later        [auto-checked above]
  • A personal Microsoft account (Outlook.com / Hotmail / Live)
    ⚠  Work or school accounts (Microsoft 365 / Entra ID) are NOT supported.
  • Your Evernote notebooks exported as .enex files (instructions below)

─────────────────────────────────────────────────────
```

No prompt — continue to Step 2.

---

## Step 2 — Evernote export instructions

```
Step 1 of 4: Export your notebooks from Evernote
─────────────────────────────────────────────────

  1. Open Evernote on your computer.
  2. Right-click a notebook → "Export Notebook..."
     (or go to File → Export Notes)
  3. Choose "ENEX format (.enex)" and save the file.
  4. Repeat for each notebook you want to import.
  5. Put all the .enex files into one folder.

  See docs/EVERNOTE_EXPORT_GUIDE.md for screenshots.

Press Enter when ready (or Ctrl+C to quit):
```

**Input:** Any key / Enter → advance to Step 3.  
Ctrl+C → exit 0, no state changed.

---

## Step 3 — ENEX folder selection

```
Step 2 of 4: Where are your .enex files?
─────────────────────────────────────────

Enter the path to the folder containing your exported .enex files.

  Example (Windows): C:\Users\You\Documents\Evernote-Export
  Example (Mac/Linux): /Users/you/Documents/Evernote-Export

Folder path:
```

### Validation logic
Re-prompt on any of the following (max 5 attempts, then exit with help hint):

| Condition | Message |
|---|---|
| Empty input | `  No path entered — please type the folder path and press Enter.` |
| Path does not exist | `  Folder not found: <path>` + `  → Double-check the path and try again.` |
| Path is a file, not a directory | `  That looks like a file, not a folder. Please enter the folder containing your .enex files.` |
| Directory exists but no `.enex` files | `  No .enex files found in: <path>` + `  → Each Evernote notebook exports as one .enex file.` + `  → Export from Evernote first, then try again.` |

### Happy path output (after valid folder)
```
Found <N> notebook(s) to import:

  • Work Notes          (Work-Notes.enex)
  • Personal            (Personal.enex)
  • Recipes             (Recipes.enex)

```
Continue to Step 4.

### Max attempts exceeded
```
✗  Too many attempts. Please check your Evernote export and try again.

   For usage instructions, run:
     evernote-to-onenote --help

   For export instructions, see:
     docs/EVERNOTE_EXPORT_GUIDE.md
```
Exit code 1.

---

## Step 4 — Auth check and sign-in

### 4a — Already signed in

Check: `msal-cache.json` exists in the package root.

```
Step 3 of 4: Microsoft sign-in
─────────────────────────────────────────────────

✓ You are already signed in to Microsoft.

```
Skip to Step 5 silently.

### 4b — Not yet signed in

```
Step 3 of 4: Microsoft sign-in
─────────────────────────────────────────────────

You need to sign in to Microsoft so this tool can create pages in OneNote.
A browser window will open. After you approve access, return here.

  ⚠  Personal accounts only (Outlook.com / Hotmail / Live).
     If you have a work or school Microsoft account, it will not work here.

Sign in now? [Y/n]:
```

**Y (or Enter):** Run `runAuthFlow()`. During the flow:
```
Opening browser… if it does not open, visit the URL shown below.
Waiting for you to approve access in the browser.
(Press Ctrl+C to cancel)
```

**Success:**
```
✓ Sign-in complete. Your session is saved — you won't need to sign in again.

```
Continue to Step 5.

**Failure (browser/auth error):**
```
✗ Sign-in failed: <error message>

   Try again by running:
     evernote-to-onenote --auth

   Or import to HTML files instead (no Microsoft account needed):
     evernote-to-onenote --batch <your-folder> --output-html ./output
```
Exit code 1.

**N (user declines sign-in):**
```
OK. No sign-in required for offline HTML export.

   To export your notes as HTML files (no Microsoft account needed):
     evernote-to-onenote --batch <your-folder> --output-html ./output

   To sign in later and import to OneNote:
     evernote-to-onenote --auth

Quit? [Y/n]:
```
Y → exit 0. N → return to Step 4b prompt.

---

## Step 5 — OneDrive preflight

Skipped automatically if:
- `--output-html` flag is present
- `--dry-run` flag is present

Otherwise, make a lightweight authenticated call (`GET /me`) to verify:
1. Network connectivity
2. Token is valid
3. Account is a personal (MSA) account, not Entra ID / AAD

```
Step 4 of 4: Checking OneDrive access
─────────────────────────────────────────────────
```

### Happy path
```
✓ Connected to Microsoft as: <name> (<email>)
✓ OneDrive: personal account confirmed

```
Continue to Step 6.

### Error: work/school account detected (AADSTS in error message)
```
✗ Work or school account detected.

   This tool only works with personal Microsoft accounts
   (Outlook.com / Hotmail / Live).

   Microsoft 365 / Entra ID accounts are not supported by the OneNote
   API used here.

   You can still export your notes as HTML files without a Microsoft account:
     evernote-to-onenote --batch <your-folder> --output-html ./output
```
Exit code 1.

### Error: network failure
```
⚠  Could not reach Microsoft's servers. Check your internet connection.

   Options:
     a) Fix your connection and run again
     b) Export to HTML files (works offline):
          evernote-to-onenote --batch <your-folder> --output-html ./output

Continue anyway? [y/N]:
```
Y → skip OneDrive check, proceed to Step 6. N → exit 0.

### Error: token expired / auth required
```
✗ Your session has expired. Re-run with:
     evernote-to-onenote --auth
```
Exit code 1.

---

## Step 6 — Dry-run preview

```
─────────────────────────────────────────────────────
Safe preview (nothing will be written to OneNote)
─────────────────────────────────────────────────────

Running a preview of your import…

  [████████████████████░░░░] 25/30 notes scanned

DRY RUN complete — nothing was written to OneNote.

What would be imported:

  • Work Notes          123 note(s)
  • Personal             45 note(s)
  • Recipes              12 note(s)

  Total: 180 note(s) across 3 notebook(s)

A full report has been saved to: ./dry-run-report.txt

─────────────────────────────────────────────────────
```

### Happy path prompt
```
Ready to start the real import?

  Your notes will be created in OneNote. Nothing is deleted from Evernote.
  Progress is saved after every note — safe to interrupt and resume.

Start import? [Y/n]:
```

**Y (or Enter):** Begin live import. Print:
```
Starting import…

```
Then hand off to the existing import loop (same output as `--batch` mode).

**N:**
```
No problem. Your notes were not changed.

To run the import later:
  evernote-to-onenote --batch <your-folder>

To review the preview report:
  dry-run-report.txt
```
Exit code 0.

### Partial dry-run failure (some notes failed to parse)
```
⚠  <N> note(s) could not be read:

  • Work Notes / "Untitled" — File may be corrupted (check the .enex in Evernote)
  • Recipes / "Sourdough"  — File permission error (check read access)

The other <M> note(s) are fine and will be imported.

Continue with the import anyway? [Y/n]:
```
Y → proceed (failed notes will be skipped with `✗` during import).  
N → exit 0.

---

## Post-import guidance

After a successful import completes, the wizard prints:
```
─────────────────────────────────────────────────────
All done! <N> note(s) imported to OneNote.

Your notes are in OneNote under the same notebook names as Evernote.
It may take a minute for them to appear in the OneNote app.

To verify everything arrived:
  evernote-to-onenote --verify

If some notes failed, resume from where you left off:
  evernote-to-onenote --batch <your-folder> --resume
─────────────────────────────────────────────────────
```

---

## Resumability within the wizard

If a wizard-triggered import is interrupted (Ctrl+C, network drop, power loss):

- `progress.json` is written after every note (existing behaviour — no change)
- On next run, wizard detects `progress.json` in the current directory and adds a banner:

```
⚠  A previous import was interrupted.
   <M> of <N> notes were saved.

   Options:
     r) Resume from where you left off  (recommended)
     s) Start fresh (re-import everything)
     q) Quit

[r/s/q]:
```

**r:** adds `--resume` to the effective flag set, proceeds from Step 6 (dry-run skipped, import starts directly).  
**s:** adds `--force-reimport`, runs full wizard from Step 3.  
**q:** exit 0.

---

## Data integrity guarantees (surfaced to user)

The wizard communicates three key safety facts at relevant points:

1. **Non-destructive:** "Nothing is deleted from Evernote" — shown in Step 1 banner.
2. **Resumable:** "Progress is saved after every note — safe to interrupt" — shown at Step 6 import start and in post-import guidance.
3. **Idempotent:** `--resume` verifies each previously-imported note still exists in OneNote before skipping — surfaced in the interrupted-import recovery prompt.

---

## Implementation notes (for coder agent)

### Files to modify
- `src/ui.js` — extend `interactiveSetup()` to cover Steps 0–6 above
- `src/index.js` — add `--no-interactive` flag to the arg parser; wire `interactiveFiles` return value to honour the resumed-import path

### New flag
`--no-interactive` — sets `interactiveFiles = false` and skips the wizard, printing:
```
Evernote → OneNote Importer

For usage, run: evernote-to-onenote --help
```
Exit 0. This is the scriptable fallback when no `--batch` is given but the caller explicitly does not want interactive prompts.

### Node version check location
Add before the `main()` body (not inside `interactiveSetup`), so it fires regardless of how the tool is invoked:
```js
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) { /* print error, exit 1 */ }
if (major < 20) { /* print warning, continue */ }
```

### OneDrive preflight call
Use `client.getMe()` (lightweight `GET /me` — needs adding to `OneNoteClient`). On AADSTS error, check for `tenantId` != "9188040d-6c67-4c5b-b112-36a304b66dad"  (MSA home tenant) as the account-type signal.

### Batch size / checkpoint
Existing `saveProgress()` after every note satisfies the checkpoint requirement. The wizard's resume banner reads `progress.json` key counts to show `<M> of <N>`. No new checkpoint schema needed.

### --no-interactive and --batch coexistence
`--batch` takes precedence. If both are present, `--batch` runs normally (no wizard, no `--no-interactive` needed — just documents the expectation).

### Duplicate detection
Already handled by `isImported()` + `verifyImport()` in `progress.js`. The wizard does not need to re-implement this; it surfaces it via the resume prompt copy above.
