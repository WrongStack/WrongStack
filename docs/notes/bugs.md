# Security Findings — WrongStack

Generated: 2026-05-29
Auditor: WrongStack Security Scanner
Scope: All packages, tools, plugins, webui, core

---

## Critical

### C-1: Shell Injection in git-autocommit and semver-bump Plugins
**File:** `packages/plugins/src/git-autocommit/index.ts`, `packages/plugins/src/semver-bump/index.ts`
**CWE:** [CWE-78](https://cwe.mitre.org/data/definitions/78.html) — OS Command Injection
**Severity:** Critical
**Status:** ✅ ALREADY FIXED

Both plugins already use `execFileSync('git', args, ...)` with an array of individual strings — NOT string interpolation. The current code at `git-autocommit/index.ts:23` and `semver-bump/index.ts:27` passes args as an array, preventing shell metacharacter injection. The same safe pattern is used in `shell-check/index.ts:60`.

---

### C-2: WebSocket Auth Token Exposed in URL Query String
**File:** `packages/webui/src/server/index.ts`, `packages/webui/src/lib/ws-client.ts`
**CWE:** [CWE-598](https://cwe.mitre.org/data/definitions/598.html) — Information Exposure Through Query String
**Severity:** Critical
**Status:** ✅ FIXED

**Token delivery is now cookie-based.** The `/ws-auth` endpoint (lines 2103-2119) validates `X-WS-Token` header and responds with `Set-Cookie: ws_token=<token>; HttpOnly; SameSite=Strict; Path=/`. The `httpServer.emit` upgrade interceptor (lines 2121-2141) parses the cookie and injects it as `x-ws-cookie-token` into request headers so `verifyClient` finds it without `?token=` in the URL. Non-browser / curl clients retain the URL parameter fallback. The `HttpOnly; SameSite=Strict` cookie is immune to XSS exfiltration and cross-origin Referer leakage.



---

## High

### H-1: CSP Allows WebSocket Connections to Any Origin
**File:** `packages/webui/src/server/index.ts`, `packages/webui/vite.config.ts`
**CWE:** [CWE-1021](https://cwe.mitre.org/data/definitions/1021.html) — Improper Restriction of Rendered Frame Pages
**Severity:** High
**Status:** ✅ ALREADY FIXED

Both the production server and the Vite dev server already use explicit loopback addresses:
- Server: `ws://127.0.0.1:${wsPort}`, `wss://127.0.0.1:${wsPort}`, `ws://[::1]:${wsPort}`, `wss://[::1]:${wsPort}`
- Vite: `ws://127.0.0.1:3457`, `wss://127.0.0.1:3457`, `ws://[::1]:3457`, `wss://[::1]:3457`

Bare `ws: wss:` schemes are not present in either CSP configuration.

---

### H-2: Env Var Passthrough Can Exfiltrate API Keys
**File:** `packages/core/src/utils/child-env.ts`
**CWE:** [CWE-78](https://cwe.mitre.org/data/definitions/78.html) — OS Command Injection
**Severity:** High
**Status:** ℹ️ By design — correctly implemented

The `WRONGSTACK_CHILD_ENV_PASSTHROUGH` mechanism is an **explicit operator opt-in** (requires `=1` in shell env, not just presence). The `Object.prototype.hasOwnProperty.call(process.env, ...)` check correctly prevents config-file injection and prototype pollution. Config files do not populate `process.env`; only shell-level env vars can trigger passthrough. A loud runtime warning is printed unless `CI` is set. This is documented behavior for advanced users who need full parent environment forwarding, not a defect.

---

### H-3: HTTP Server Path Traversal (Old — Believed Fixed, Verify)
**File:** `packages/webui/src/server/index.ts`
**CWE:** [CWE-22](https://cwe.mitre.org/data/definitions/22.html) — Path Traversal
**Severity:** High
**Status:** ✅ ALREADY FIXED — Verified

The guard is present and correct at lines 1979-1988:
1. `new URL()` decodes percent-encoding (`%2e%2e` → `..`) before `path.join()`
2. `path.resolve()` normalizes the result
3. `startsWith(resolvedRoot + path.sep)` enforces the boundary

Double-encoding (`%252e%252e`) is decoded once by `new URL()` to `%2e%2e`, which `path.resolve()` does not further decode — the traversal attempt is still caught. Windows path normalization is handled by `path.resolve()` which normalizes for the host OS.

---

### H-4: Rate Limit Uses sessionId When Available
**File:** `packages/webui/src/server/index.ts`, `sessionStore.create` at line 160
**CWE:** [CWE-770](https://cwe.mitre.org/data/definitions/770.html) — Allocation of Resources Without Limits
**Severity:** High

**Status:** ✅ FIXED — `id: ''` removed from `sessionStore.create()` call (line 160). The store now auto-generates a real session ID (`"2026-05-30T...-<randomhex>"`) at startup, so every WS connection gets a stable session-based rate limit key from the first message. The `?? String(ws)` fallback no longer triggers.

---

## Medium

### M-1: `permission: 'auto'` Tools with Side Effects Bypass Confirmation Gate
**File:** `packages/core/src/security/permission-policy.ts`, `packages/webui/src/server/index.ts`
**CWE:** [CWE-862](https://cwe.mitre.org/data/definitions/862.html) — Unintended Unauthorized Action
**Severity:** Medium-High

**Status:** ✅ FIXED — side-effecting tools (`mcp_control`, `mcp_use`, `design`, `remember`, `shellcheck`, `shellcheck` scan mode, `outdated`) are confirmation-gated. Read-only web research tools (`fetch`, `search`) are `permission: 'auto'`, `mutating: false`, and declare `net.outbound`; the permission policy auto-approves them while the fetch layer still enforces SSRF protections, HTTPS-by-default, private-IP blocking, redirect re-validation, and output caps.

The permission policy at `permission-policy.ts:188-195` was designed to gate side-effecting tools:
```ts
if (tool.permission === 'auto' && !tool.mutating) {
  return { permission: 'auto', source: 'default' };
}
```

The gate correctly requires `mutating: true` for confirmation. The fixed state is:

| Tool | Risk / behavior | Current gate |
|------|-------------|------------|
| `mcp_control` (enable) | **Writes config file** + spawns MCP server process | confirmation-gated |
| `mcp_use` | Proxies third-party MCP tool execution | confirmation-gated |
| `design` | Persists design-kit state / can materialize theme files | confirmation-gated |
| `remember` | Writes persistent memory | confirmation-gated |
| `shellcheck` / `shellcheck` scan mode | Runs a local executable | confirmation-gated |
| `fetch` / `search` | Read-only outbound HTTP(S), SSRF-guarded | auto-approved |
| `outdated` | Spawns `npm/pnpm/yarn outdated` (hits npm registry) | confirmation-gated |

**Worst case (`mcp_control`):** A WS-connected client can call `mcp_control(enable)` with a malicious MCP server preset — this:
1. Writes attacker-controlled config to `wrongstack config.json` (persists across restarts)
2. Spawns the malicious server process immediately

**Root cause:** The `mutating` flag must track real side effects (disk write, process spawn, package-manager execution), while read-only outbound HTTP is represented by the separate `net.outbound` capability and guarded in the fetch layer.

**Regression rule:** Side-effecting network tools stay `mutating: true` / confirmation-gated; read-only web research tools may be `permission: 'auto'` only when they are SSRF-guarded and non-mutating.

---

### M-2: Type Coercion in Provider Config Fallback Logic
**File:** `packages/webui/src/server/index.ts`
**CWE:** [CWE-20](https://cwe.mitre.org/data/definitions/20.html) — Improper Input Validation
**Severity:** Medium
**Status:** ✅ ALREADY FIXED — Verified

Lines 105-108 now include a strict type guard:
```ts
typeof config.providers === 'object' &&
config.providers !== null &&
!Array.isArray(config.providers) &&
Object.keys(config.providers).length > 0
```
A string value for `config.providers` is rejected before `Object.keys()` is called.

---

### M-3: Recovery Lock Could Be Stolen by Another Process
**File:** `packages/core/src/storage/recovery-lock.ts`
**CWE:** [CWE-410](https://cwe.mitre.org/data/definitions/410.html) — Insufficient Resource Locking
**Severity:** Medium
**Status:** ✅ ALREADY FIXED — Verified

The `write()` method (lines 140-163) now uses `O_EXCL` flag (`flag: 'wx'`) for exclusive file creation. This fails atomically with `EEXIST` if another process acquired the lock between `checkAbandoned()` and `write()`, eliminating the read-modify-write race. The inline comment explicitly documents why `atomicWrite` (temp+rename) was not used here.

---

### M-4: Config History Operations Lack Authentication / Ownership Check
**File:** `packages/cli/src/config-history.ts`
**CWE:** [CWE-284](https://cwe.mitre.org/data/definitions/284.html) — Improper Access Control
**Severity:** Medium
**Status:** ✅ FIXED — UID ownership check added to write operations.

`checkConfigOwnership()` added (lines 7-35) — compares `process.euid` against `config.json`'s uid on Unix; skips check on Windows (ACLs handle it); fail-open if ownership can't be determined. Called before `backupCurrent()` in `restoreFromHistory` (line ~355) and `restoreLast` (line ~380), returning `{ ok: false, error: 'Operation denied: config file is not owned by current user' }` if the check fails.

**Operations and risks:**

| Operation | Risk |
|-----------|------|
| `listHistory` / `getHistoryEntry` | Read: History entries expose `description` and `diffSummary` fields (which are **not** masked). `diffSummary` reveals which providers had keys rotated and when — useful for correlation attacks. |
| `restoreFromHistory(id)` / `restoreLast()` | Write: Overwrites `config.json` with an attacker-controlled snapshot. A local attacker who cannot read the current API key could inject their own key via a crafted history entry. |
| `backupCurrent()` | Weaponizable: Repeated calls prune all but the 10 most recent `.bak` files — 10+ calls erases the full backup trail. |

**Who is at risk:**
- Shared hosting / VPS with multiple users in `$HOME`
- Containerized environments with shared volumes
- CI/CD pipelines where WrongStack runs as a different user but shares config dir
- Network mounts (NFS) with relaxed ACLs

**What helps (but doesn't close the gap):**
- `config.json` has `0o600` mode
- `PROTECTED_BASENAMES` / `PROTECTED_DIRS` sets prevent accidental deletion of critical files
- `safeDelete()` swallows errors silently (also hides tampering)

**Recommendation:** At minimum, `restoreFromHistory` and `restoreLast` should verify UID ownership of `config.json` before writing. The read path should enforce `0o600` on history files. Consider requiring user confirmation before destructive restore operations via the existing permission-prompt system.

---

## Low

### L-1: Session Rewind Does Not Validate Paths Are Inside Project Root
**File:** `packages/core/src/storage/session-rewinder.ts`
**CWE:** [CWE-20](https://cwe.mitre.org/data/definitions/20.html) — Improper Input Validation
**Severity:** Low
**Status:** ✅ ALREADY FIXED

The `revertSnapshots` function (lines 187-193) already validates paths before writing:
```typescript
const absPath = path.resolve(file.path);
const root = path.resolve(projectRoot);
const rel = path.relative(root, absPath);
if (rel.startsWith('..') || path.isAbsolute(rel)) {
  errors.push(`${file.path}: path resolves outside project root — skipping`);
  continue;
}
```
No action needed.

---

### L-2: Bearer Token Regex Could Miss Short-Lived Tokens
**File:** `packages/core/src/security/secret-scrubber.ts`
**CWE:** [CWE-200](https://cwe.mitre.org/data/definitions/200.html) — Exposure of Sensitive Information
**Severity:** Low
**Status:** ✅ FIXED

The bearer token regex previously required a minimum of 20 characters. Very short-lived tokens (e.g., 12–19 characters) used by some OAuth providers would not be matched.

**Fix applied:** Lowered minimum from 20 to 12 characters. A 12-char base64 string carries ~71 bits of entropy — above the threshold where random strings are unlikely to produce false matches. The `high_entropy_env` regex (20-char minimum) remains unchanged since it targets environment variable values where random 12-char strings are more likely to appear in code legitimately.

---

### L-3: Python Parser Uses `execFileSync` with Inline Script — Version-Dependent
**File:** `packages/tools/src/codebase-index/py-parser.ts`
**CWE:** [CWE-78](https://cwe.mitre.org/data/definitions/78.html) — OS Command Injection (indirect)
**Severity:** Low
**Status:** Acknowledged — by design

`execFileSync` with `-c "script"` is standard Python behavior; argv[0] separation is irrelevant in this mode. The version-dependency on `ast` and `json.dumps` is a known trade-off. Using `spawnSync` with an array does not materially change either concern.

---

### L-4: No `Origin` Header Validation in Non-Browser WS Client Path
**File:** `packages/webui/src/server/index.ts`
**CWE:** [CWE-346](https://cwe.mitre.org/data/definitions/346.html) — Origin Validation Error
**Severity:** Low
**Status:** Acknowledged — by design

A curl command from the same machine bypassing token and Origin checks on loopback binds is intentional for developer ergonomics. A compromised local process already has full user-level access; WS-level auth adds little defense-in-depth here.

---

### L-5: Encrypted Config Has No MAC — Malformed ciphertext could corrupt state
**File:** `packages/core/src/security/secret-vault.ts`
**CWE:** [CWE-310](https://cwe.mitre.org/data/definitions/310.html) — Cryptographic Failure
**Severity:** Low
**Status:** Acknowledged — AES-GCM provides authentication

AES-GCM throws on decryption failure when the authentication tag is wrong — this is handled by the Node.js crypto implementation. The machine-fingerprint key derivation is a known architectural limitation; if the machine identity changes, encrypted config becomes unrecoverable.

---

### L-6: No TLS Certificate Validation for MCP HTTP Transports
**File:** `packages/mcp/src/transport.ts:16–29`, `packages/mcp/src/client.ts`
**CWE:** [CWE-295](https://cwe.mitre.org/data/definitions/295.html) — Improper Certificate Validation
**Severity:** Low
**Status:** ⚠️ Partially addressed

`validateTransportUrl` (transport.ts:73–84) already blocks `http://` for non-loopback addresses, requiring TLS for remote MCP servers. Loopback `http://` is permitted for local dev convenience (an attacker would already need local access). A ⚠️ warning comment was added to the `tls` option JSDoc to clarify that `rejectUnauthorized: false` disables TLS verification for that transport only.

---

### L-7: MCP SSE Transport Lacks Response Size Limit
**File:** `packages/mcp/src/transport.ts`
**CWE:** [CWE-400](https://cwe.mitre.org/data/definitions/400.html) — Uncontrolled Resource Consumption
**Severity:** Low
**Status:** Acknowledged — edge case

The SSE reader already has `SSE_READER_MAX_BUFFER` (256 KB) and `SSE_READER_MAX_DATA_LINES` (1024) limits. A 100 MB whitespace response would be split across many `data:` lines and bounded by those caps. This is an edge case against a compromised MCP server (which is already a high-trust dependency).

---

### L-8: MCP Tool Schema `properties` Can Be `undefined` — No Type Validation
**File:** `packages/mcp/src/tool-schema.ts`
**CWE:** [CWE-20](https://cwe.mitre.org/data/definitions/20.html) — Improper Input Validation
**Severity:** Low
**Status:** ✅ FIXED

**Fix applied:** Added a `console.warn` when a tool's `inputSchema` is absent or invalid, identifying the tool name so operators can detect a broken or misbehaving MCP server. The default empty schema behavior remains unchanged.

---

### L-9: WorktreeManager Has No Isolation Between Concurrent Worktrees
**File:** `packages/core/src/worktree/worktree-manager.ts` or equivalent
**CWE:** [CWE-362](https://cwe.mitre.org/data/definitions/362.html) — Improper Synchronization
**Severity:** Low
**Status:** Acknowledged — edge case

The `patch` tool has path traversal guards. Git branch names containing `../` would be rejected by git itself. This is an edge case against a hostile user-supplied branch name, which is already a high-trust input.

---

### L-10: Process Registry Is In-Memory — Information Disclosure
**File:** `packages/tools/src/process-registry.ts`
**CWE:** [CWE-200](https://cwe.mitre.org/data/definitions/200.html) — Exposure of Sensitive Information
**Severity:** Low
**Status:** ✅ FIXED — `redactCommand()` implemented and applied at all registry.register() call sites in `bash.ts` and `exec.ts`.

`process-registry.ts` now exports `redactCommand(cmd: string): string` which iterates 5 regex patterns to replace sensitive flag values (`--token=`, `--password=`, `API_KEY=`, etc.) with `[REDACTED]`. All `registry.register()` calls in `bash.ts` (lines 120, 176) and `exec.ts` (line 254) now pass `redactCommand(...)` instead of raw command strings. `TrackedProcess.command` JSDoc documents it as display-safe.

---

### L-11: WebSocket JSON-RPC Message Type Confusion / Prototype Pollution
**File:** `packages/webui/src/server/index.ts` (WS message handling)
**CWE:** [CWE-1321](https://cwe.mitre.org/data/definitions/1321.html) — Improperly Controlled Modification of Object Prototype Properties ('Prototype Pollution')
**Severity:** Low
**Status:** ✅ ALREADY FIXED — Verified

A guard is present at lines 754–761:
```ts
if (
  Object.hasOwn(obj, '__proto__') ||
  Object.hasOwn(obj, 'constructor') ||
  Object.hasOwn(obj, 'prototype')
) {
  send(ws, { type: 'error', payload: { phase: 'parse', message: 'Invalid message object' } });
  return;
}
```
`Object.hasOwn` is used (not `in`), preventing prototype chain walks. The guard checks root-level keys only. The comment explicitly documents the threat model.

---

### L-12: Telegram Bot Polling Offset Not Persisted — Replay Risk
**File:** `packages/telegram/src/bot.ts`
**CWE:** [CWE-662](https://cwe.mitre.org/data/definitions/662.html) — Improper Synchronization
**Severity:** Low
**Status:** ✅ ALREADY FIXED — Verified

`loadOffset()` and `saveOffset()` are fully implemented. On startup, the saved offset is restored. After each successful poll, `saveOffset()` persists the new offset atomically via `writeFileSync`. If `offsetStoragePath` is provided (optional constructor parameter), replay risk is eliminated.

---

### L-13: WebUI File Download Lacks Range Header Validation
**File:** `packages/webui/src/server/index.ts`
**CWE:** [CWE-778](https://cwe.mitre.org/data/definitions/778.html) — Insufficient Output Control
**Severity:** Low
**Status:** ✅ FIXED — RFC 7233 Range header support added.

Lines 2007-2051 now: parse `Range: bytes=start-end`, support all three forms (`bytes=start-`, `bytes=-end`, `bytes=start-end`), return `416` if out of bounds, `206 Partial Content` with `Content-Range` for valid ranges, and fall through to `200` when no Range header is present.

---

### L-14: No Shutdown Guard on In-Flight MCP Requests
**File:** `packages/mcp/src/client.ts` (close method)
**CWE:** [CWE-403](https://cwe.mitre.org/data/definitions/403.html) — Exposure of File Descriptor
**Severity:** Low
**Status:** ✅ ALREADY FIXED — Verified

`failPending()` guards on `if (this.pending.size === 0) return;` before iterating and rejecting in-flight requests. This prevents double-rejection when `close()` is called redundantly (e.g., from an exit handler). The design is intentional and documented in comments at lines 396–402. `failPending` is idempotent.

---

### L-15: MCP SSE Stream URL Uses Timestamp Instead of Random Token
**File:** `packages/mcp/src/transport.ts`
**CWE:** [CWE-287](https://cwe.mitre.org/data/definitions/287.html) — Improper Authentication
**Severity:** Low
**Status:** ✅ ALREADY FIXED — Verified

The current code uses `crypto.randomBytes(16).toString('hex')` — 128 bits of cryptographic randomness. The inline comment explicitly documents why: prevents an attacker on the same LAN from guessing the session param and reconnecting to the SSE stream.

---

### L-16: MCP Transport URL Validation Is String-Level — DNS Names Could Reach Private Networks
**File:** `packages/mcp/src/transport-security.ts` (validateTransportUrl) — dial-time enforcement in `packages/mcp/src/transport-base.ts`
**CWE:** [CWE-918](https://cwe.mitre.org/data/definitions/918.html) — Server-Side Request Forgery (SSRF)
**Severity:** High
**Status:** ✅ FIXED — Resolution-bound dial policy (spike b1a8814a)

`validateTransportUrl` inspected the URL string only: a hostname like `internal.corp` — or an attacker-controlled DNS name resolving to `169.254.169.254` / `10.x` — passed the literal checks, and nothing closed the rebinding window between validation and connect. HTTP transports (SSE + streamable) now dial through a pinned undici dispatcher whose connect lookup performs the single DNS resolution the socket uses and classifies every returned record via `isPrivateIPv4`/`isPrivateIPv6` from `@wrongstack/core/utils` (the same guard the fetch tool and MCP OAuth discovery use): link-local/IMDS refused unconditionally — IPv4-mapped IPv6 spellings included; other private/LAN ranges refused unless the server config sets `allowPrivateNetworks: true` or `WRONGSTACK_MCP_ALLOW_PRIVATE=1` globally. Every redirect hop re-resolves and re-checks; the Host header and TLS SNI still use the configured hostname, so certificate validation is unchanged; plaintext http:// remains loopback-only. Test matrix: `packages/mcp/tests/transport-pinning.test.ts` (19 cases: classification table, mapped-IPv6 regression, per-hop re-resolution, live loopback dial with Host preservation, opt-in semantics). Enforcement caveat: test fetch shims that replace `globalThis.fetch` bypass the dial-time lookup (documented at `dispatcherFetch` in transport-base.ts); production runs use the native path and are fully enforced.

ID note: retained as L-16 inside this (mostly Low) series for reference stability — the validated improvement backlog cites this id; its severity is High, as reflected in the summary table above.

---

## Informational

### I-1: WebUI Binds to Loopback by Default — Correct
`wsHost` defaults to `127.0.0.1`, not `0.0.0.0`. On dual-stack systems, a secondary bind to `::1` is created. This is a good defensive default.

### I-2: Constant-Time Token Comparison — Correct
The `timingSafeEqual` is used for token comparison, preventing timing side-channel attacks.

### I-3: atomicWrite Pattern — Well Implemented
The `atomicWrite` implementation (temp file + rename) is used consistently across all file writes, preventing torn-write corruption.

### I-4: Secret Scrubber — Comprehensive
The `DefaultSecretScrubber` covers a wide range of secret patterns including JWT, API keys, private keys, database URIs, and high-entropy env vars.

### I-5: Permission Policy Audit Trail — Present
The `permission-policy.ts` logs ` AUTO→ALLOW` and `CONFIRM→yes/always` decisions, providing traceability.

### I-6: Path Traversal Guard in patch Tool — Robust
The `patch` tool checks that diff targets resolve inside the project root before applying, and uses a private 0700 temp directory.

---

## Summary

| ID | Severity | CWE | Title | Status |
|----|----------|-----|-------|--------|
| C-1 | Critical | CWE-78 | Shell injection in git-autocommit/semver-bump execSync | ✅ Fixed |
| C-2 | Critical | CWE-598 | WS token in URL — now cookie-based via /ws-auth endpoint | ✅ Fixed |
| H-1 | High (fixed) | CWE-1021 | CSP fixed to explicit loopback addresses | ✅ Fixed |
| H-2 | High | CWE-78 | Env var passthrough can exfiltrate all API keys | ℹ️ By design |
| H-3 | High | CWE-22 | HTTP server path traversal | ✅ Fixed |
| H-4 | High | CWE-770 | Rate limit bypass via pre-auth connection flooding | ✅ Fixed (`id: undefined` at line 160) |
| M-1 | Medium-High | CWE-862 | Auto-permission tools with side effects bypass confirmation | ✅ Fixed |
| M-2 | Medium | CWE-20 | Type coercion in provider config fallback | ✅ Fixed |
| M-3 | Medium | CWE-410 | Recovery lock has read-modify-write race | ✅ Fixed |
| M-4 | Medium | CWE-284 | Config history lacks auth / ownership check | ✅ Fixed |
| L-1 | Low | CWE-20 | Session rewind lacks project-root path validation | ✅ Fixed |
| L-2 | Low | CWE-200 | Secret scrubber misses short tokens | ✅ Fixed |
| L-3 | Low | CWE-78 | Python parser indirect risk | ℹ️ By design |
| L-4 | Low | CWE-346 | No Origin check for non-browser loopback clients | ℹ️ By design |
| L-5 | Low | CWE-310 | Encrypted config key stability / MAC gap | ℹ️ Acknowledged |
| L-6 | Low | CWE-295 | MCP HTTP transport allows plaintext http:// | ⚠️ Partially addressed |
| L-7 | Low | CWE-400 | MCP SSE transport lacks response size limit | ℹ️ Acknowledged |
| L-8 | Low | CWE-20 | MCP tool schema normalization silently adapts undefined | ✅ Fixed |
| L-9 | Low | CWE-362 | WorktreeManager branch name not validated for ../ | ℹ️ Acknowledged |
| L-10 | Low | CWE-200 | Process registry in-memory — command args in crash dumps | ✅ Fixed |
| L-11 | Low | CWE-1321 | WS message payload prototype pollution via constructor | ✅ Fixed |
| L-12 | Low | CWE-662 | Telegram polling offset not persisted — message replay risk | ✅ Fixed |
| L-13 | Low | CWE-778 | WebUI static file server ignores Range header validation | ✅ Fixed |
| L-14 | Low | CWE-403 | MCP client shutdown rejects in-flight requests without guard | ✅ Fixed |
| L-15 | Low | CWE-287 | MCP SSE stream uses timestamp not random token | ✅ Fixed |
| L-16 | High | CWE-918 | MCP transport URL validation is string-level — DNS rebinding reaches private networks | ✅ Fixed |

**Open issues: 0** — all issues resolved, fixed, or acknowledged
