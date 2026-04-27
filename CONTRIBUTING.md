# Contributing to evernote-to-onenote

Thank you for your interest in contributing. This guide covers everything you need to get from clone to a merged PR.

---

## Dev Setup

**Prerequisites:** Node.js 18 or later, npm 8 or later.

```sh
git clone https://github.com/jmsdevlab/evernote-to-onenote.git
cd evernote-to-onenote
npm install
```

There are no build steps — it's plain CommonJS Node.js. You can run the CLI directly:

```sh
node src/index.js --help
```

---

## Running Tests

```sh
npm test
```

The test suite uses Node's built-in `node:test` runner (no extra framework). Tests live in `tests/` alongside their fixture data in `tests/fixtures/`.

To run a single test file:

```sh
node --test tests/enex-parser.test.js
```

All tests must pass before opening a PR. The CI matrix runs Node 18, 20, and 22 on Ubuntu and Windows.

---

## Code Style

There is no linter configured yet. Follow these conventions:

- **CommonJS only** (`require` / `module.exports`). No ESM (`import`/`export`).
- **`'use strict'`** at the top of every file.
- **2-space indentation.**
- **Single quotes** for strings (except when the string contains a single quote).
- **No semicolons omitted** — always terminate statements.
- **Function names** in camelCase; exported constructor names in PascalCase.
- **No `console.log` in library code.** Use the existing progress/logging patterns in `src/index.js`.
- **No new runtime dependencies** without prior discussion in an issue. The current dependency count (4 packages) is intentional.

---

## Project Structure

```
src/
  index.js          — CLI entry point and main import orchestrator
  auth.js           — MSAL device-code auth + silent token refresh
  enex-parser.js    — ENEX XML → structured note objects
  enml-converter.js — ENML → OneNote-compatible HTML
  onenote-client.js — Microsoft Graph API client (notebooks/sections/pages)
  progress.js       — progress.json read/write with atomic flush
  parallel.js       — bounded concurrency + rate-limit token bucket
  tags.js           — Evernote tag → OneNote page footer rendering
tests/
  *.test.js         — one file per src module
  fixtures/         — sample .enex files and expected outputs
docs/
  ARCHITECTURE.md   — module contracts and design decisions
  PRD-v1.md         — v1.0 product requirements and acceptance criteria
```

---

## PR Process

1. **Open an issue first** for anything non-trivial (bug fix, new feature, refactor). This avoids duplicate work and lets us discuss design before you write code.

2. **Fork and branch** from `master`. Use a descriptive branch name: `fix/parallel-progress-race`, `feat/log-format-json`.

3. **Write tests.** Every new module needs tests. Every bug fix should add a regression test that fails before the fix and passes after.

4. **Run the full suite** (`npm test`) before pushing.

5. **Open a pull request** against `master`. Fill in the PR template. Link to the issue you're resolving.

6. **One reviewer approval** is required to merge. Maintainers aim to respond within 48 hours.

---

## Good First Issues

Look for issues labelled [`good-first-issue`](https://github.com/jmsdevlab/evernote-to-onenote/issues?q=label%3Agood-first-issue). These are scoped, well-defined, and don't require deep knowledge of the whole codebase.

---

## Reporting Bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). Include:

- Node.js version (`node --version`)
- OS and version
- The command you ran
- The full error output or unexpected behaviour
- A minimal `.enex` file that reproduces the issue (if possible)

**Do not include your `msal-cache.json` or any access tokens in bug reports.**

---

## Security

If you discover a security vulnerability, please report it privately. See [SECURITY.md](SECURITY.md).
