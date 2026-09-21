# Two-minute-safe migration walkthrough

Watch the [captioned short walkthrough](assets/evernote-onenote-walkthrough.mp4) or follow the same steps below.

1. Install the CLI and run `evernote-to-onenote setup` for the guided path.
2. Export one Evernote notebook to `.enex`; use the [safe example](../examples/safe-example.enex) for a practice run.
3. Preview first. A dry run writes a local report and sends nothing to Microsoft.
4. Run the import only after checking the preview.
5. If interrupted, rerun with `--resume`; then use `--verify` to check the recorded OneNote pages.

Desktop users follow the same result-focused path in five visible screens: sign in, choose file, choose section, import, and check the result.

The first useful outcome is at least one successfully created OneNote page recorded in the durable progress ledger. Opening the app or viewing a screen does not count.
