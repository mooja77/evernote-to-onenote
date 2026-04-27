# Open-Source Release Plan

Date: 2026-04-27

## Goal

Ship `evernote-to-onenote` as a public goodwill project that is safe to publish, easy for non-technical users to run, and credible to developers who inspect the source.

## Non-Negotiables

- No private Evernote exports, generated note HTML, logs, progress files, or Microsoft auth cache files in git or npm.
- First public release must default to safety: preview before write, resume after interruption, clear recovery instructions, and no hidden telemetry.
- Microsoft Graph behaviour must be documented from real API constraints, not assumptions.
- GitHub issues must steer users away from posting private notes or tokens.
- JMS website copy must position this as a useful open-source tool, not a sales-heavy funnel.

## Phase 1: Repository Safety

- Track `.gitignore`, `.npmignore`, `SECURITY.md`, `PRIVACY.md`, GitHub templates, tests, docs, and synthetic fixtures.
- Keep `all-notes/`, `output/`, `html-preview/`, `progress.json`, `msal-cache.json`, `.access-token`, root-level `.enex` exports, and logs ignored.
- Run `npm run pack:check` before any GitHub or npm publish.
- Confirm `npm pack --dry-run` includes only `src/`, `README.md`, `LICENSE`, and `package.json`.

## Phase 2: Beginner-Safe Product UX

- Add an explicit guided mode (`--guided` or no-argument TTY mode) that explains each step in plain English.
- Make dry-run the recommended first action and show a readable migration report before live import.
- Add preflight checks for Node version, ENEX folder existence, Microsoft auth state, OneDrive storage guidance, and likely duplicate conflicts.
- Improve progress output for long imports: current file, note counts, skips, failures, elapsed time, and what to do if the window closes.
- Add a post-run report that can be shared safely after redaction.

## Phase 3: Reliability And Data Integrity

- Reconfirm Microsoft Graph OneNote limits and quirks against current docs and live smoke tests.
- Keep resume idempotent: never re-import on unknown verification caused by auth/network/server errors.
- Add a synthetic large-export stress test for progress file integrity.
- Add fixture coverage for large attachments, missing metadata, odd Unicode titles, duplicate titles, and corrupt notes.

## Phase 4: Public Launch Assets

- Create a public GitHub repository under the chosen organisation/account.
- Enable GitHub Actions CI on Windows and Ubuntu for Node 20 and 22.
- Add release notes, screenshots or terminal GIF, issue labels, and a `good first issue` backlog.
- Add a JMS website page and short blog post explaining why the tool exists, who it is for, and its privacy model.
- Decide separately whether to publish to npm. GitHub can go public first; npm should wait until install docs and package dry-run are final.

## Harness Workstream

The command-centre harness has been asked to produce:

- Microsoft Graph / OneNote API research refresh.
- Non-technical product UX plan.
- Beginner-safe flow UX spec.
- Open-source privacy/security audit.

Implementation should consume those outputs before the next major feature wave.
