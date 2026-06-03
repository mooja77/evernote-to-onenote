# Security Policy

## Supported Versions

Security fixes target the latest released version of `evernote-to-onenote`.

## Reporting A Vulnerability

Do not open a public GitHub issue for vulnerabilities involving tokens, Microsoft account access, private note content, or dependency compromise.

Email the maintainer privately first. Include:

- The affected version or commit.
- Exact reproduction steps.
- Whether private Evernote data, Microsoft tokens, or OneNote content could be exposed.
- A minimal synthetic `.enex` fixture if one is needed to reproduce the issue.

Do not send real exported notebooks, `msal-cache.json`, `.access-token`, `progress.json`, or logs containing personal note titles unless explicitly requested through a private channel.

## Token And Data Handling

The tool stores Microsoft auth state locally in `msal-cache.json` and optional fallback tokens in `.access-token`. These files are ignored by git and excluded from npm packaging.

User exports and generated migration output are private by default. The repository guardrails intentionally exclude:

- `all-notes/`
- `output/`
- `html-preview/`
- `progress.json`
- `msal-cache.json`
- `.access-token`
- `import-log*.txt`
- root-level `*.enex` exports

Test fixtures under `tests/fixtures/` must be synthetic and safe to publish.
