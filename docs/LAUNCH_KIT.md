# Launch Kit

Use this copy when announcing the project. Keep the tone useful, not sales-heavy.

## Primary Links

- GitHub: https://github.com/mooja77/evernote-to-onenote
- npm: https://www.npmjs.com/package/evernote-to-onenote
- JMS page: https://jmsdevlab.com/tools/evernote-to-onenote

## Short Description

Free open-source CLI for moving Evernote ENEX exports into Microsoft OneNote. It supports guided setup, dry-run reports, resumable imports, tags, metadata, local HTML export, and post-import verification.

## GitHub Release / Project Post

We released Evernote to OneNote as a free open-source migration tool.

It is designed for cautious migrations: export your Evernote notebooks as `.enex`, run a dry-run preview, inspect the report, then import into Microsoft OneNote when you are ready. Progress is saved after every note, so interrupted runs can continue with `--resume`.

Why we built it:

- Migration tools should be transparent.
- Users should be able to preview before writing anything.
- Interrupted imports should not mean starting again.
- Open-source code is easier to trust with personal note archives.

Install:

```sh
npm install -g evernote-to-onenote
evernote-to-onenote
```

Links:

- GitHub: https://github.com/mooja77/evernote-to-onenote
- npm: https://www.npmjs.com/package/evernote-to-onenote
- Guide: https://jmsdevlab.com/tools/evernote-to-onenote

## LinkedIn / Facebook

We have open-sourced a small goodwill project: Evernote to OneNote.

It is a free migration tool for people moving old Evernote notebooks into Microsoft OneNote. The goal is simple: make the migration less risky for non-technical users.

What it does:

- Reads Evernote `.enex` exports.
- Shows a dry-run report before anything is imported.
- Saves progress after every note.
- Resumes interrupted imports.
- Preserves tags and basic metadata.
- Lets technical users inspect the code before trusting it.

Install:

```sh
npm install -g evernote-to-onenote
evernote-to-onenote
```

GitHub: https://github.com/mooja77/evernote-to-onenote

## dev.to Draft

Title: We open-sourced a safer Evernote to OneNote migration tool

Canonical URL: https://jmsdevlab.com/tools/evernote-to-onenote

Outline:

1. The problem: personal note migrations are stressful because users cannot easily see what will happen.
2. The design rule: preview first, write later.
3. Why ENEX export is safer than connecting to Evernote directly.
4. How the CLI works: parse, convert, authenticate, import, checkpoint.
5. Reliability choices: resume, verify, conflict handling, rate-limit backoff.
6. Privacy model: no telemetry, local progress file, Microsoft device-code auth.
7. Install and contribute links.

## Reddit / Community Short Form

I built a free open-source Evernote ENEX to Microsoft OneNote importer.

It is a CLI, but it has a guided mode for non-technical users. The main safety feature is a dry-run report before anything touches OneNote, plus resume support if an import is interrupted.

GitHub: https://github.com/mooja77/evernote-to-onenote
npm: https://www.npmjs.com/package/evernote-to-onenote

I would appreciate testing with small exported notebooks first. Please do not post private ENEX files publicly if you hit an issue.

## Good First Issues

- Add screenshots to the README.
- Add a terminal GIF generated from the demo script.
- Add a Windows-specific first-run troubleshooting page.
- Add fixture coverage for more attachment types.
- Improve `--verify` output for very large imports.
