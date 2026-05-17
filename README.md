# Evernote to OneNote — Desktop App

A desktop application that migrates an Evernote `.enex` export into a
Microsoft OneNote section. Built for non-technical users: download, install,
sign in, pick your file, click go.

It is an Electron shell around a battle-tested import engine (ENEX parsing,
ENML→HTML conversion, the Microsoft Graph / OneNote calls, and a resumable
progress ledger) — the same engine used by the `evernote-to-onenote` CLI.

## How it works (for the user)

1. **Sign in** with your Microsoft account. The app opens your normal web
   browser to the Microsoft sign-in page; you sign in there as on any
   website, and the app continues automatically.
2. **Choose** your Evernote export — in Evernote, `File → Export Notes` as
   `.enex`.
3. **Pick** the OneNote section to import into.
4. The app imports every note as a page, one at a time. It is **resumable** —
   if it is interrupted, running it again skips notes already imported.

Runtime state (the Microsoft token cache and the resume ledger) is stored
under the OS app-data folder (`%APPDATA%/Evernote to OneNote` on Windows),
never in the install directory.

## Develop

```sh
npm install
npm start          # launches the app via Electron
```

## Build a Windows distributable

```sh
npm run dist       # electron-builder → dist/
```

This produces `dist/win-unpacked/` — the full app folder. To hand it to
someone, zip that folder; they unzip and run `Evernote to OneNote.exe`.

**NSIS installer (`.exe`):** the `nsis` target needs to extract
electron-builder's `winCodeSign` bundle, which contains symbolic links.
On Windows, creating symlinks requires either **Developer Mode** (Settings
→ Privacy & security → For developers → Developer Mode = On) or an
elevated (Administrator) terminal. With one of those enabled, `npm run dist`
also emits `dist/Evernote to OneNote Setup <version>.exe`.

The build is **unsigned** — Windows SmartScreen shows an "unknown publisher"
prompt; choose **More info → Run anyway**. Code-signing (a paid
certificate) is a future step.

## Project layout

```
src/
  main.js           Electron main: window + IPC
  preload.js        the window.api bridge (contextIsolation on)
  import-runner.js  per-note import orchestration (no terminal I/O)
  lib/              the import engine — enex-parser, enml-converter,
                    onenote-client, progress, parallel, auth
  renderer/         the wizard GUI (index.html, app.js, styles.css)
```

## License

MIT.
