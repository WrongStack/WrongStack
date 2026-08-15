# WrongStack — Threat Model & Security Posture

This document captures the threat model the codebase is hardened against,
which controls live where, and which decisions were made deliberately so
future contributors don't undo them. It is intentionally short on
prescriptions and long on context.

## Reporting a vulnerability

Please email security reports to ersinkoc@gmail.com. Do not file public
GitHub issues for unpatched vulnerabilities.

## Adversary model

The agent reads instructions from three layers, and each layer has a
different trust posture:

| Source                          | Trust  | Why                                                |
|---------------------------------|--------|----------------------------------------------------|
| User typing in the REPL         | high   | Local human operating their own machine.           |
| Local config files / env vars   | high   | User-owned; same trust as the process itself.      |
| LLM-generated tool inputs       | **none** | Treat as adversarial. Prompt injection is real. |
| Web pages fetched by `fetch`    | **none** | Anything reachable over HTTP can carry hostile content. |
| MCP server responses            | low    | Third-party; could be compromised or malicious.    |
| File contents read by tools     | low    | A repo may carry hostile content (`.env`, plants). |

The single most important rule: **anything the LLM emits as a tool input is
adversarial**. A prompt-injection attack can flip an otherwise-honest model
into emitting a dangerous shell command or a metadata-service URL without the
user noticing. The controls below reduce specific attack paths, but approval of
an arbitrary shell-capable action still grants the invoking user's authority;
they are defense in depth, not a sandbox.

## Controls in current source (reviewed 2026-07-13)

### Sandbox boundary on shell-style tools

- **`bash` tool** ([packages/tools/src/bash.ts](packages/tools/src/bash.ts))
  - Runs via the user's shell — gives the model full local execution.
  - **Child env is sanitized** ([packages/tools/src/_env.ts](packages/tools/src/_env.ts)): allowlist (PATH, HOME, LANG, …) plus a secret-name strip
    (TOKEN/SECRET/PASSWORD/AUTH/BEARER/COOKIE/PRIVATE substrings, KEY with
    word boundary). Provider API keys, GitHub PATs, AWS creds never reach
    the child. Override with `WRONGSTACK_BASH_ENV_PASSTHROUGH=1` if you
    explicitly need passthrough.
  - **POSIX process-group kill** on timeout/abort so
    `bash -c "sleep 9999 & disown"` doesn't orphan a grandchild.

- **`exec` tool** ([packages/tools/src/exec.ts](packages/tools/src/exec.ts))
  - Strict allowlist (`node`/`npm`/`pnpm`/`git`/`tsc`/…); no escape hatch.
    The previous `allow_unknown` flag was dropped — for arbitrary commands
    use `bash` (which is more clearly gated).
  - `cwd` parameter validated to resolve inside `ctx.projectRoot`.
  - Same env sanitization as `bash`.

- **`git` tool** ([packages/tools/src/git.ts](packages/tools/src/git.ts))
  - No raw `args` field. Removed because it allowed
    `-c core.sshCommand=…` and `--upload-pack='sh -c …'` RCE.
  - `findGitDir` is bounded by `ctx.projectRoot` so a non-git project
    doesn't walk up into an unrelated parent repo.

- **`patch` tool** ([packages/tools/src/patch.ts](packages/tools/src/patch.ts))
  - Diff `+++` targets pre-validated against `projectRoot` before invoking
    GNU patch. `strip` forced ≥1 (rejects `strip:0` absolute-path escapes).
  - Temp diff file written into a `0700 mkdtemp` private directory rather
    than a predictable timestamp name in the user's tree.
  - `LC_ALL=C` set so applied-count detection (`grep "patching file"`)
    isn't fooled by a localized GNU patch.

- **`replace` tool** ([packages/tools/src/replace.ts](packages/tools/src/replace.ts))
  - Uses `lstat` to detect symlinks and `realpath` to validate the resolved
    target is still inside `projectRoot`. Writes through `realPath`, never
    through the original (which could be a planted symlink).

- **`grep` tool** ([packages/tools/src/grep.ts](packages/tools/src/grep.ts))
  - Native walker skips symbolic links.
  - User-supplied regex compiled through
    [packages/tools/src/_regex.ts](packages/tools/src/_regex.ts) — 512-char
    cap and rejection of obvious super-linear constructs like `(a+)+`.
  - Subject line capped at 64 KB before sync regex eval.
  - `rg` stdout buffer capped at 1 MB.

### Network egress: `fetch` tool

[packages/tools/src/fetch.ts](packages/tools/src/fetch.ts)

- **HTTPS only by default.** `http://` requires `WRONGSTACK_FETCH_ALLOW_PRIVATE=1`.
- **Private/loopback/multicast/CGNAT/metadata blocking** via numeric
  comparison (not substring regex):
  - IPv4: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16,
    192.0.0/24, 224/4 (multicast), 240/4 (reserved).
  - IPv6: full expansion to 8 groups; blocks ::, ::1, fc00::/7, fe80::/10,
    ff00::/8, and **all IPv4-mapped forms** (including Node's normalized
    `::ffff:7f00:1` form for `::ffff:127.0.0.1`).
- **Redirect target re-validated every hop.** A public host's 302 to AWS
  IMDS will be refused at hop 2.
- **DNS pre-resolution.** Hostnames are resolved via `dns.lookup` and each
  record checked. Known limitation: this is **best-effort against DNS
  rebinding** — Node's `fetch` does its own lookup and could in principle
  see a rebound IP. For a hard guarantee we'd need an undici Agent with a
  pinned `lookup` callback. Acceptable risk today given that the redirect
  re-check catches the trivial bypasses; reconsider if WrongStack is used
  in a hostile multi-tenant context.
- **Body cap 128 KB**, **timeout 20s**, **5 redirect max**.

### Secrets at rest

- **AES-256-GCM vault** ([packages/core/src/security/secret-vault.ts](packages/core/src/security/secret-vault.ts))
  for configuration fields recognized by `isSecretField()` in
  [`config-secrets.ts`](packages/core/src/security/config-secrets.ts). The key
  file is exclusive-created with mode `0o600`; that mode is meaningful on
  POSIX, while Windows access control depends on the directory/filesystem ACL.
- **Per-field decrypt** — one corrupted ciphertext doesn't kill boot;
  affected field is zeroed and logged.
- **Field-name boundary** — recognition is regex-based, but a JSON-key-anchored
  pass now also encrypts a bare `token` field (and other common secret names
  seen at the value boundary), so `hq.token` and similar opaque fields are
  encrypted by this config walker. Treat the configuration file itself as
  sensitive even when recognized fields use `enc:v1:` values.
- **Plaintext migration** on every boot for users coming from earlier
  versions: detects unencrypted secret-bearing keys and rewrites the
  config encrypted.
- **Secret scrubber** ([packages/core/src/security/secret-scrubber.ts](packages/core/src/security/secret-scrubber.ts))
  recognizes known credential shapes (Anthropic / OpenAI / GitHub / GCP /
  Slack / Stripe / AWS / Twilio / JWT / mongo-postgres-mysql-redis URIs /
  Bearer / generic high-entropy `*_KEY=` patterns). UI, HQ, and session paths
  invoke it selectively; it is not an automatic boundary around every write.
  Chunked processing bounds work on large strings.

### Permission policy

[packages/core/src/security/permission-policy.ts](packages/core/src/security/permission-policy.ts)

- Trust rules: per-tool allow/deny glob patterns persisted to
  `~/.wrongstack/trust.json` via atomic write.
- **Glob metacharacters in tool input are escaped** before pattern match
  — a crafted bash command `git **` cannot itself act as a glob.
- **Per-tool `subjectKey`** (e.g. bash → `command`, fetch → `url`)
  declares which input field is the trust subject. Without this the
  policy heuristic could mismatch across tools — an HTTP tool whose
  `path` means request-path would have been checked against filesystem
  trust rules.
- **Capability-based gating** (2026-06-13): tools declare `capabilities`
  (e.g. `['fs.write']`, `['net.outbound']`). The `AutoApprovePermissionPolicy`
  uses these to allowlist by *what a tool can do* rather than by *what it is
  called*. This prevents a renamed tool from bypassing trust rules.

### Provider boundary

- **Tool-call argument validation** ([packages/providers/src/_tool-input.ts](packages/providers/src/_tool-input.ts)):
  every stream parser routes tool args through `parseToolInput` so the
  result is always a `Record<string, unknown>`. Provider responses with
  `args: null`, an array, or invalid JSON are wrapped under `__raw`
  instead of crashing the tool executor.
- **SSE parser** ([packages/providers/src/sse.ts](packages/providers/src/sse.ts))
  caps the pending-line buffer at 256 KB and normalizes CRLF
  incrementally to avoid O(n²) blowup.

### MCP boundary

- **Pending RPC drain** on child exit / `close()` so callers don't hang
  on a dead transport.
- **SIGTERM → SIGKILL escalation** on stuck children.
- **Slot-scoped disconnect listeners** — fixes a Set-keyed-by-arrow-fn
  bug that accumulated listeners across reconnect cycles.
- **HTTP error bodies capped** at 1 KB in error messages.

### Plugin tool mutation boundary

[packages/core/src/plugin/api.ts](packages/core/src/plugin/api.ts)

- **Capability-based mutation authorization** (2026-06-13): plugins can only
  wrap or unregister tools they don't own if they declare matching capabilities
  in `toolMutateCapabilities`.
- **Official plugins bypass** — first-party plugins bundled with WrongStack are
  trusted and can mutate any tool.
- **Tool owners bypass** — a plugin can always mutate its own registered tools.
- **External plugins are restricted** — if a tool declares `capabilities:
  ['fs.write']`, an external plugin must list `'fs.write'` in its
  `toolMutateCapabilities` to wrap or unregister it. No overlap = mutation
  denied with a clear error message.
- **No-capability tools are immutable** — tools without a `capabilities`
  array cannot be mutated by external plugins at all. This is a safe default:
  legacy tools are protected until explicitly tagged.

### HQ command center

`wstack --hq` starts a project-independent HTTP/WebSocket command center on
port `3499` by default. CLI entry points bind `0.0.0.0`; the embeddable server
default and `--tunnel` origin bind `127.0.0.1`, unless `--host` changes the bind,
accepts telemetry, persists event/snapshot/time-series data, and exposes a
control plane. Treat the entire HQ data directory and endpoint as sensitive.
Implementation: [`packages/cli/src/hq-server.ts`](packages/cli/src/hq-server.ts),
[`packages/cli/src/hq-server/auth.ts`](packages/cli/src/hq-server/auth.ts), and
[`packages/core/src/hq/`](packages/core/src/hq/).

Current controls include separate browser/client token lists, scoped token
capabilities, optional scrypt-backed browser password login, signed HttpOnly
`SameSite=Lax` session cookies, protocol-version checks, a 1 MiB WebSocket
payload cap, live `auth.json` reload, response security headers, publisher and
server redaction, and persistent event/snapshot/time-series stores. First run
creates least-privilege browser (`control.enqueue`) and client
(`telemetry.publish`) tokens.

Authenticated operators can manage the browser password in HQ under
**System → Security**. Password-session changes require the current password;
browser-token sessions provide the recovery/reset path. Local loopback open
mode may bootstrap its first password, while a public relay refuses removal or
reload of the last browser authentication method.

These controls have important boundaries:

- A missing `auth.json` bootstraps least-privilege browser and client tokens.
  An existing file with empty token arrays and no password is explicit
  **OPEN MODE**. Corrupt, unreadable, or unsupported-version files
  fail closed during startup; live-reload failures preserve the last-known-good
  auth state. Treat auth-load failures as operator-visible security faults and
  repair the file rather than replacing it with an empty document.
- Origin validation accepts non-browser clients without `Origin`, exact
  same-host HTTP(S) browser traffic (including trusted TLS tunnels), matching
  loopback origins on the bound port, and `file:`. Other origins, including
  `Origin: null`, are rejected.
- Password login uses per-client exponential backoff, and signed sessions are
  swept after the same seven-day lifetime advertised by the HttpOnly cookie.
- HQ itself speaks plain HTTP/WS. `--tunnel` can manage a temporary
  TryCloudflare HTTPS URL for development; use a durable trusted reverse proxy
  with stronger authentication and rate limiting for production exposure.
- Tokens are stored in plaintext inside `auth.json` (atomic write, `0o600` on
  POSIX). Browser and client lists prevent cross-channel replay, but a stolen
  token grants its declared capabilities.
- Redaction is pattern-based, not a proof that arbitrary secret values cannot
  persist. Explicit HQ URLs default `rawContent` to true unless configuration
  disables it; review the operator policy before connecting a remote HQ.

See [HQ remote/relay deployment](docs/subcommands/hq.md#remote--relay-deployment)
for operational guidance.

## Known limitations / deliberate non-goals

- **Multi-tenant hostile environments are not the target.** The agent
  runs with the invoking user's privileges and has full filesystem and
  network access. The threat model is "untrusted LLM output", not
  "untrusted operator".
- **No syscall sandboxing.** A sufficiently determined model+user
  combination can still run anything — we only raise the bar against
  prompt injection.
- **DNS rebinding** is best-effort, not airtight (see fetch notes above).
- **`re2` not pinned in.** User regexes go through a heuristic ReDoS
  filter and length cap, not a fully safe regex engine. A determined
  attacker can probably craft a pattern that slips through both checks;
  catastrophic backtracking still hangs only one worker, not the whole
  process.
- **Session soft-deny state is in-memory only.** The permission policy
  tracks per-session soft-denies (`sessionDenied` / `sessionAllowed` maps)
  to let a user approve or deny once and have that decision apply for the
  retry loop within the same session. This state is intentionally not
  persisted — it is discarded on clean exit and on process crash. If the
  agent restarts mid-session (crash, `wrongstack restart`, leader
  election), the user may be re-prompted for decisions they already made.
  This is a deliberate UX trade-off to avoid polluting the persisted
  trust file with transient session decisions.
- **Tool output is trusted on the way back.** A malicious file in the
  repo, or a tampered MCP response, can carry prompt-injection content
  that the next LLM turn might act on. The user is the last line of
  defense via the `confirm` permission prompt.
- **HQ supports explicit open mode.** See [HQ command center](#hq-command-center).
  A missing auth file or empty token lists enable OPEN MODE; malformed,
  unreadable, and unsupported-version files fail closed. Password login is
  shipped but not throttled. Do not expose HQ directly to an untrusted network.
- **Configured hooks are privileged operator code.** Shell-hook validation
  checks the first command token, then executes the full string with
  `shell: true`; shell operators or arguments can therefore perform actions
  beyond the allowlisted token. HTTP hooks accept any HTTPS URL (plus loopback
  HTTP), do not apply the built-in `fetch` tool's private-address/DNS checks,
  and may send hook payloads to private or public destinations. Project config
  strips hooks, but user-installed hook configuration must be treated as code.
- **Mailbox bridge tokens are bearer capabilities, not agent identities.** One
  bridge token authorizes every route; authenticated callers choose `from`,
  `readerId`, registration ids, and message type. The server reserves the
  sender id `hq` (only HQ itself may use it) and validates `readerId`/`agentId`
  shapes, but it does not bind the token to a sender identity or separate
  authorization for control mails. Bind loopback unless a trusted proxy adds
  identity-aware policy.
- **Mailbox persistence is coordination state, not an integrity log.** The
  shared JSONL/registry files use normal filesystem creation permissions and
  have no record signature/hash chain. File locks reduce overlapping writes;
  they do not authenticate writers or make records tamper-evident.
- **Some local logs intentionally retain tool data.** Standard/full session
  audit events and the hash-chained tool audit sidecar can include raw tool
  input, output, and side-effect input. `DefaultSecretScrubber` recognizes
  known credential shapes inside string values but does not redact an arbitrary
  opaque value merely because its JSON key is named `token` or `secret`.
  Protect `~/.wrongstack/projects/` as sensitive data and configure retention
  accordingly.
- **Concurrency is not an isolation boundary.** `Agent.run()` now rejects a
  second concurrent call on the same instance, because one mutable `Context`
  is not a shareable concurrency boundary. Mailbox registry/cache coordination
  and TUI project switching still have known cross-process/lifecycle race
  windows; do not use local presence records as authoritative authentication
  or locking.

### Accepted risks & deliberate trade-offs (from 2026 security audits)

The following items were reviewed during the May and June 2026 `security-check`
audits and explicitly accepted as non-blocking:

- **Postinstall git-hooks setup** (`"postinstall": "git config core.hooksPath .githooks"` in root package.json):
  - This only affects developers who clone the repo. It is not a runtime security boundary.
  - Listed as "maintainer call / won't fix" in both audits. Changing it would harm contributor experience with no meaningful security gain for end users.

- **Some remaining name-string + denylist authorization checks** (e.g. `AutoApprovePermissionPolicy.DENY` and parts of plugin tool mutation rules):
  - These were pragmatic and effective, but have now been superseded by explicit capability allowlists (see **Capability-based gating** above and `docs/plans/security-hardening-2026-06.md` P1).
  - The old denylist checks remain as defense-in-depth but are no longer the primary control.

- **Install-script allowlist maintenance**:
  - `pnpm-workspace.yaml` currently allows lifecycle builds for `@biomejs/biome`, `electron`, `esbuild`, `node-pty`, and `sharp`. Any addition requires security review; the native/runtime download rationale is documented beside each entry. `sharp` is an optional dependency of `@huggingface/transformers` (pulled in by `@wrongstack/vector-memory`); its postinstall fetches prebuilt libvips binaries from sharp's own `@img/*` subpackages on the public npm registry (no third-party hosts).
  - Removal matters as much as addition. `better-sqlite3` was listed here and in both `pnpm-workspace.yaml` blocks while being absent from the lockfile entirely (the codebase uses `node:sqlite`), so its install scripts were pre-authorised to run the moment it reappeared through any transitive path — spending the review gate in advance. `packages/core/tests/architecture/build-allowlist-freshness.test.ts` now fails when any allowlist entry names a package that is not in the lockfile, and when this list drifts from `onlyBuiltDependencies`.

Added by the **August 2026** `security-check` audit:

- **`release.yml` builds in the job that holds `id-token: write`** (M13):
  - The `publish` job runs `pnpm install --frozen-lockfile` and `pnpm build` in the same job that
    mints the npm OIDC token, so a compromised build-time dependency could in principle publish
    backdoored versions of all 29 packages *with valid provenance*. `pages.yml` rejects this exact
    pattern (WS-014) and splits build from deploy; `release.yml` does not.
  - **Accepted** because the compensating controls are strong and specific: the `npm-publish`
    environment requires reviewer approval, the checkout is pinned to the SHA `verify` validated
    (WS-089), `persist-credentials: false`, all actions are SHA-pinned, and only four packages may
    run install lifecycle scripts.
  - The split is viable when someone wants it: `pnpm pack` resolves `workspace:*` to concrete
    versions (verified 2026-08-04), so a `build` job can emit tarballs for a minimal `publish` job
    that never runs third-party code. Deferred rather than done because a release pipeline cannot be
    dry-run, and a mistake here breaks shipping rather than security.

- **Loopback is authenticated, not trusted — but the token is readable by same-user processes** (H3):
  - The WebUI/SimpleUI HTTP API now requires a token on every bind (previously loopback required
    none). The token lives in `~/.wrongstack/webui-instances.json` (`0o600`) so the one legitimate
    non-browser caller, `FleetNotifier`'s `POST /api/fleet/ping`, can authenticate.
  - This raises the bar against a differently-scoped or sandboxed local process. It does **not**
    defend against a process running as the same user: that process can read the token file, and
    could read `~/.wrongstack/projects/*` — the transcripts the API exposes — without the API at
    all. Same reasoning as HQ's `auth.json`. Do not treat channel auth as isolation from the user's
    own account.

Future scans should treat the above as **known and accepted** rather than new findings.

## When in doubt

The two rules that keep things safe:

1. **Adversarial in, friendly out.** Validate every value that originated
   from the LLM, the network, or a third-party MCP server. Friendly
   internal callers don't need validation.

2. **Match the scope of authorization to the scope of action.** A `trust`
   entry for `bash:git status` should not auto-allow `bash:rm -rf /`. The
   policy escapes glob metacharacters and uses `subjectKey` to enforce
   this; new tools should declare `subjectKey` rather than rely on the
   policy's fallback heuristic.

## HQ implementation status

The earlier phased HQ plan is retained in
[`docs/plans/hq-command-center-2026-06.md`](docs/plans/hq-command-center-2026-06.md)
as design history. Current source has browser/client tokens, password set/rotation
via `wstack --hq --password <value>`, live auth reload, capability scopes, and
persistent event/snapshot/time-series storage. Token lifecycle commands are:

```bash
wstack hq token create [label]
wstack hq token create --client [label]
wstack hq token list [--client]
wstack hq token revoke [--client] <id-prefix>
```

There is no separate `wstack hq auth set-password` or `auth reset` subcommand.
Starting HQ with `--password <value>` adds or rotates the stored scrypt hash;
rotation also invalidates existing password sessions. The security limitations
and supported deployment posture are described
in [HQ command center](#hq-command-center), above.

## See also

- [CHANGELOG.md](CHANGELOG.md) — security-relevant changes by version
- [README.md](README.md) — usage and configuration
- [docs/plans/hq-command-center-2026-06.md](docs/plans/hq-command-center-2026-06.md) — HQ command center architecture and phased plan (Access Control section)
- [docs/subcommands/hq.md](docs/subcommands/hq.md) — `wstack --hq` user command reference (flags, routes, env vars, deployment)
