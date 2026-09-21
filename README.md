# Evernote → OneNote

[![CI](https://github.com/mooja77/evernote-to-onenote/actions/workflows/ci.yml/badge.svg)](https://github.com/mooja77/evernote-to-onenote/actions/workflows/ci.yml)

Migrate Evernote `.enex` exports into Microsoft OneNote. The desktop app supports
personal and work/school Microsoft accounts; the CLI currently supports personal
accounts only.

## Start here

For most Windows users, download the latest **Evernote to OneNote Setup** file from
[Releases](https://github.com/mooja77/evernote-to-onenote/releases/latest), install it,
then follow the five screens:

1. Sign in to the Microsoft account that owns the target OneNote.
2. Choose one Evernote `.enex` export.
3. Choose the OneNote section.
4. Start the import.
5. Open OneNote and check the result.

Progress is saved after every successful note. If the import is interrupted, choose
the same file and section again; verified pages are skipped. Practice first with the
[synthetic safe example](examples/safe-example.enex).

- [Searchable help and recovery guide](docs/HELP.md)
- [Captioned short walkthrough with matching written steps](docs/WALKTHROUGH.md)
- [Windows troubleshooting](docs/WINDOWS-TROUBLESHOOTING.md)

The first useful outcome is a OneNote page that was successfully created and recorded
in the durable progress ledger. Merely opening the app does not count.

---

## Monorepo Layout

```
evernote-to-onenote/
├── packages/
│   ├── engine/    evernote-onenote-engine  — shared import core (ENEX parsing, Graph client, progress ledger, event loop)
│   └── cli/       evernote-to-onenote      — npm CLI with terminal UI, device-code auth, and --output-html
└── apps/
    └── desktop/   evernote-to-onenote-desktop  — Electron desktop app with browser-PKCE auth
```

---

## CLI Users

Experienced-user fast path:

```sh
npm install -g evernote-to-onenote
evernote-to-onenote setup
```

See **[packages/cli/README.md](packages/cli/README.md)** for full usage — flags, auth setup, `--batch`, `--resume`, `--year-sections`, `--output-html`, and more.

## Privacy and support

Exports are read locally. A live import sends converted note content and attachments
only to Microsoft Graph for your OneNote. There is no hosted processing, analytics,
account system, lifecycle email, or customer outreach.

GitHub issues are public. Never attach real exports, notes, private logs, auth caches,
or tokens. Use the safe example or another synthetic reproduction.

- [Ask for help](https://github.com/mooja77/evernote-to-onenote/issues/new?template=bug_report.md)
- [Request a feature](https://github.com/mooja77/evernote-to-onenote/issues/new?template=feature_request.md)

---

## Desktop App

`apps/desktop` is an Electron application for users who prefer a GUI over the command line. It uses browser-based PKCE auth rather than device-code and imports into a fixed OneNote section.

Build a distributable:

```sh
npm run dist -w evernote-to-onenote-desktop
```

---

## Develop

Install all workspace dependencies from the repo root:

```sh
npm install
```

Run all tests:

```sh
npm test
```

Run tests for a single package:

```sh
npm test -w evernote-onenote-engine   # engine only
npm test -w evernote-to-onenote       # CLI only
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the monorepo architecture, import-core event contract, and auth boundary documentation.
