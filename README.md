# Evernote → OneNote

[![CI](https://github.com/mooja77/evernote-to-onenote/actions/workflows/ci.yml/badge.svg)](https://github.com/mooja77/evernote-to-onenote/actions/workflows/ci.yml)

Migrate Evernote `.enex` exports into Microsoft OneNote. Supports personal Microsoft accounts only.

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

Install globally from npm:

```sh
npm install -g evernote-to-onenote
```

See **[packages/cli/README.md](packages/cli/README.md)** for full usage — flags, auth setup, `--batch`, `--resume`, `--year-sections`, `--output-html`, and more.

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
