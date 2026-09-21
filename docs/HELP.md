# Evernote to OneNote help

Use your browser's page search (`Ctrl+F` or `Cmd+F`) to find an error or keyword. The desktop app also has a searchable **Help** panel.

## Start in five steps

1. Export one Evernote notebook as an `.enex` file.
2. Sign in to the Microsoft account that owns the target OneNote.
3. Choose the `.enex` file and target section.
4. Start the import and keep the app open.
5. Open OneNote and check the imported pages.

Progress is stored after every successful note. If the app, network, or computer stops, choose the same file and section again. Verified pages are skipped.

## Fast path

Experienced users can use the [CLI guide](../packages/cli/README.md):

```powershell
npm install -g evernote-to-onenote
evernote-to-onenote setup
evernote-to-onenote --batch .\Evernote-Export --resume
evernote-to-onenote --verify
```

## Safe practice run

Download [`examples/safe-example.enex`](../examples/safe-example.enex). It contains one synthetic note and no personal information. Import it into a temporary OneNote section, check the result, then delete that section if you no longer need it.

## Troubleshooting

### Sign-in does not finish

Cancel and retry. Use the Microsoft account that owns the target OneNote. The desktop app supports personal and work or school accounts; the CLI currently supports personal accounts only.

### The import stopped

Start again with the same file and section. Desktop imports and CLI `--resume` both use a durable progress ledger and verify recorded pages before skipping them.

### OneDrive says 507 or storage full

Free OneDrive space, then retry. Finished notes remain recorded.

### Notes are missing

Run `evernote-to-onenote --verify` in the CLI, or rerun the same desktop import. A missing recorded page is imported again.

### Evernote v11 local-cache import does not work

Evernote v11 no longer keeps the full note body in its local cache. Export `.enex` files and use `--batch` or the desktop app.

## Privacy and support boundary

The app reads exports locally. A live import sends converted content and attachments only to Microsoft Graph for your OneNote. There is no analytics, hosted processing, account system, or customer-email campaign.

GitHub issues are public. Never attach real exports, note screenshots, private logs, `progress.json`, `msal-cache.json`, `.access-token`, or bearer tokens. Reproduce a problem with the safe example or another synthetic file.

- [Ask for help](https://github.com/mooja77/evernote-to-onenote/issues/new?template=bug_report.md)
- [Request a feature](https://github.com/mooja77/evernote-to-onenote/issues/new?template=feature_request.md)
- [Windows installation troubleshooting](WINDOWS-TROUBLESHOOTING.md)
