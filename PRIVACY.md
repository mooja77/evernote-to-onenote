# Privacy

`evernote-to-onenote` is designed to run locally. Your Evernote exports are read from disk and sent only to Microsoft OneNote through Microsoft Graph when you run a live import.

## What Leaves Your Machine

- Live imports send converted note content and attachments to Microsoft Graph so OneNote pages can be created.
- `--dry-run` does not write to OneNote.
- `--output-html <dir>` converts notes locally and does not call Microsoft Graph.

## What Stays Local

- Evernote `.enex` files.
- `progress.json`, which records import progress.
- `msal-cache.json`, which stores Microsoft auth cache data.
- `.access-token`, if you choose to use the legacy token fallback.
- Import logs and generated HTML previews.

## Open-Source Bug Reports

Do not attach real notebooks, private logs, `progress.json`, `msal-cache.json`, or `.access-token` to public issues. If a bug needs sample data, create a tiny synthetic `.enex` file that reproduces the problem without personal content.

## Maintainer Position

This project should not add analytics, telemetry, crash reporting, or hosted processing without an explicit opt-in design and a clear privacy review.
