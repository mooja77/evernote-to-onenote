# Two-Minute Demo Script

Purpose: record a short screen demo for the README, GitHub release, JMS website, and social posts.

## Setup Before Recording

- Use a synthetic ENEX export, not personal notes.
- Use a clean terminal with a large font.
- Keep the terminal width wide enough that commands do not wrap.
- If showing Microsoft auth, use a throwaway personal Microsoft account.

## Script

### 0:00 - 0:15: Problem

"This is Evernote to OneNote, a free open-source tool from JMS Dev Lab. It moves exported Evernote notebooks into Microsoft OneNote, with a safe preview before anything is imported."

Show:

```sh
npm install -g evernote-to-onenote
evernote-to-onenote --version
```

### 0:15 - 0:40: Export Folder

"First, export each Evernote notebook as an ENEX file and put those files into one folder."

Show the folder with one or two `.enex` files.

### 0:40 - 1:10: Dry Run

"Before importing, run a dry-run. This reads the export and writes a report, but does not call Microsoft or change OneNote."

Show:

```sh
evernote-to-onenote --batch ./Evernote-Export --dry-run
```

Open `dry-run-report.txt` briefly.

### 1:10 - 1:35: Guided Mode

"If you are not technical, just run the command with no flags. Guided mode explains the steps and asks for your folder path."

Show:

```sh
evernote-to-onenote
```

Do not complete a live import in this segment unless using a test account.

### 1:35 - 1:55: Resume And Verify

"Progress is saved after every note. If the network drops or your laptop sleeps, run with resume. When you are done, verify checks what arrived."

Show:

```sh
evernote-to-onenote --batch ./Evernote-Export --resume
evernote-to-onenote --verify
```

### 1:55 - 2:00: Close

"The project is MIT licensed, public on GitHub, and installable from npm."

Show GitHub repository and npm package page.

## Capture Checklist

- `--version` shows the current release.
- Dry-run output says nothing is written to OneNote.
- No private notes, tokens, or email addresses are visible.
- The README, npm package, and JMS landing page URLs are visible at least once.
