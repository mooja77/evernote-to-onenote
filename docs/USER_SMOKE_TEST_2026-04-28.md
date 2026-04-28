# User Smoke Test - 2026-04-28

This smoke test verifies the public npm package from a clean temporary install, not the local repository checkout.

## Environment

- OS: Windows
- Node.js: 22.x local runtime
- Package: `evernote-to-onenote@1.1.1`
- Install method: `npm install -g evernote-to-onenote@1.1.1 --prefix <temp>`
- Test data: synthetic one-note ENEX file created in a temp directory

## Result

Pass.

## Commands Tested

```sh
evernote-to-onenote --version
evernote-to-onenote --help
evernote-to-onenote --batch <temp-export-folder> --dry-run --report <temp-report>
evernote-to-onenote --output-html <temp-html-folder> <temp-export-folder>/Sample.enex --quiet
```

## Observed Behaviour

- `--version` printed `1.1.1`.
- `--help` included guided mode, dry-run, and version instructions.
- Dry-run parsed one notebook and one note without calling Microsoft APIs.
- Dry-run wrote `dry-run-report.txt`.
- HTML export completed from the synthetic ENEX file.

## Not Covered

Live Microsoft OneNote import was not executed in this automated smoke because it requires a personal Microsoft account and creates real OneNote pages. Manual live-import testing should use a dedicated throwaway Microsoft account and a one-note synthetic ENEX file.

## Manual Live Import Checklist

1. Create or use a personal Microsoft account, not a work or school account.
2. Install the latest package:

```sh
npm install -g evernote-to-onenote
```

3. Confirm the installed version:

```sh
evernote-to-onenote --version
```

4. Authenticate:

```sh
evernote-to-onenote --auth
```

5. Run dry-run on a one-note synthetic ENEX folder:

```sh
evernote-to-onenote --batch ./Evernote-Export --dry-run
```

6. Import the same tiny export:

```sh
evernote-to-onenote --batch ./Evernote-Export
```

7. Open OneNote and confirm the notebook, section, page title, page body, tags, and metadata look correct.

8. Re-run with resume and confirm no duplicate page is created:

```sh
evernote-to-onenote --batch ./Evernote-Export --resume
```
