# First-Party Browser Automation

WrongStack ships the bundled `@wrongstack/browser-tools` workspace package through the normal builtin `ToolRegistry`. Its Playwright runtime provisions on demand. The tools are
available to CLI, TUI, WebUI, and fleet workers without enabling the Playwright MCP
preset. The optional MCP server remains compatible because it uses `playwright_*`; first-party
tools use `browser_*`.

## Workflow

```text
browser_status
browser_open       -> sessionId
browser_navigate   -> browser_wait -> browser_snapshot
browser_click / browser_type / browser_select / browser_press / browser_hover / browser_drag
browser_screenshot -> PNG artifact
browser_close      -> trace artifact
```

Every session belongs to the creating agent. Fleet workers cannot list or operate another agent's
contexts. The manager lazily starts one Chromium process, creates isolated contexts, and closes the
process when its last context closes. Run disposal and operation cancellation reclaim owned
contexts as safety nets.

## Security

- Browser launch, external navigation, interaction, upload, screenshot persistence, and arbitrary
  page evaluation use the normal permission policy. Evaluation and upload are destructive-risk
  confirmation tools.
- Navigation accepts only absolute HTTP(S) URLs, rejects URL credentials, and blocks private,
  loopback, link-local, reserved, and metadata addresses by default. The same guard runs on browser
  subrequests. Every Chromium connection passes through a loopback guard proxy that resolves once,
  validates every DNS answer, and connects to the selected IP directly to prevent DNS rebinding.
  For trusted local development fixtures, use `/browser allow http://127.0.0.1:4173`.
  An exact comma-separated environment allowlist such as
  `WRONGSTACK_BROWSER_PRIVATE_ORIGINS=http://127.0.0.1:4173` is also supported;
  other ports and origins remain blocked.
  The former broad `WRONGSTACK_BROWSER_ALLOW_PRIVATE=1` switch is no longer consumed by the
  first-party browser tools; replace it with explicit origins.
- Downloads are disabled. Uploads are restricted to existing files inside `projectRoot`.
- For credentials, call `browser_type` with `secretEnv` instead of `text`. The environment variable
  is resolved only during execution, so tool arguments and session audit contain the placeholder
  name rather than its value.
- Accessibility output, console entries, network summaries, and evaluation results are bounded.
  URLs lose credentials, query strings, and fragments before output; common credential forms in
  console text are redacted.

## Evidence

Screenshots and traces receive ULID artifact identifiers and are stored outside the repository:

```text
~/.wrongstack/projects/<project-slug>/browser-artifacts/<session-id>/
```

`browser_screenshot` returns PNG metadata. `browser_close` returns the Playwright trace metadata.
Both are explicitly marked `sensitive` and include an artifact id, MIME type, size, SHA-256,
timestamp, and absolute local path. A mode-`0600` `<artifact-id>.metadata.json` audit sidecar stores
the same non-content metadata and session provenance; screenshot/trace bytes are never copied into
the session log.

## Installation diagnostics

Use `browser_status` from an agent session. From a source checkout or release job, the doctor
command checks the exact bundled Chromium revision without relying on a package-manager shim:

```sh
node scripts/check-browser-runtime.mjs
node scripts/check-browser-runtime.mjs --smoke
```

Missing Chromium is installed automatically on the first `browser_open`.
Use `/browser install` to prepare it immediately, or
`node scripts/check-browser-runtime.mjs --install` for a standalone doctor repair.
Allow a local development origin directly with `/browser allow http://localhost:3000`;
this project setting takes effect immediately, including in existing browser sessions.
Linux CI/base images that also need system libraries can add `--with-deps`. The CI matrix validates
launch and a real page interaction on Ubuntu and Windows; the release job repeats the Linux check.
