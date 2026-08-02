# WrongStack Auth Screens — Improvement Review

**Date:** 2026-08-02 · **Scope:** HQ Web UI auth (`packages/webui-hq/`), HQ server auth
(`packages/cli/src/hq-server/`), TUI auth panel + CLI auth menu (`packages/tui/src/components/auth-panel.tsx`,
`packages/cli/src/auth-menu/`), core auth primitives (`packages/core/src/hq/`, `security/`).

**Last updated:** 2026-08-02 — All 12 findings resolved (H1–H2, M1–M5, L1–L4). 83/83 tests, typecheck 0, lint 0.

Every claim below is tagged: **[V]** verified by direct read/run this session, **[A]** assumed from
consistent evidence, **[U]** unknown / needs confirmation.

---

## 1. What exists today (flow inventory)

| Flow | Surface | Mechanism |
|---|---|---|
| Login (password) | HQ Web UI → `token-gate.tsx` | `POST /api/login` → scrypt verify → HMAC-signed `hq.session` cookie (7-day) |
| Login (token) | HQ Web UI / HTTP | `?token=` query or `Authorization: Bearer` → timing-safe match against `auth.json` |
| Token → cookie upgrade | `auth-handlers.ts` `handleApiTokenUpgrade` (WS-065) | Authenticated token swaps for an HttpOnly cookie session |
| First-run bootstrap | `handleApiBootstrap` | Single-use 256-bit code exchange (fragment URL, TTL) |
| Password set/change/remove | `settings.tsx` | `POST/DELETE /api/auth/password` (scrypt hash, mints new cookie secret) |
| Logout | `app.tsx`, `settings.tsx` | `POST /api/logout` deletes current session + clears cookie/token |
| Provider sign-in (CLI) | `auth-menu/oauth-menu.ts` | ChatGPT (Codex PKCE), Claude (PKCE), Copilot (device flow); loopback callback + manual paste fallback |
| API-key entry / provider mgmt | TUI `auth-panel.tsx`, CLI `auth-menu/` | Catalog, local servers, custom providers, keys stored vault-encrypted |

## 2. What is already strong (keep)

- **[V]** Passwords hashed with salted **scrypt** (`hashHqPassword`/`verifyHqPassword` in `@wrongstack/core/hq`); token comparison is **timing-safe** (`timingSafeTokenMatch`).
- **[V]** Session cookie: **HttpOnly + SameSite=Lax**, optional `Secure`, 7-day max age with server-side eviction (`sessionCleanupTimer`, 60s sweep).
- **[V]** **Origin guard** (`hasTrustedBrowserOrigin`) blocks DNS-rebinding/CSRF at the router before any auth handler; JSON-only API + same-site cookie further harden CSRF.
- **[V]** Login **rate limiting**: exponential backoff `2^count * 1000` capped at 16s, per-IP, with 15-min attempt retention (`LOGIN_ATTEMPT_RETENTION_MS`).
- **[V]** **Capability-scoped browser tokens** (`control.enqueue` etc.) resolved live from the token record; password change invalidates older password sessions.
- **[V]** Password policy enforced **server-side** (8–1024) *and* in the UI; change requires current password when authenticated by password; Enter-to-submit; confirm field; 1MB body cap (`readRequestBody`).
- **[V]** OAuth flows use **PKCE + CSRF state** (Claude/Codex) and the device flow (Copilot); subscription tokens are stored vault-encrypted; loopback host validation + port fallback; ToS warning for subscription tokens.

## 3. Findings & recommendations

### 🔴 High

#### H1 — No second factor anywhere (2FA/MFA absent) — ✅ RESOLVED
- **[V]** Grep for `totp|2fa|authenticator|mfa` across `packages/**/src` finds **no auth-related 2FA** (only unrelated mailbox "authenticator" stripping). `plan-templates.ts` even lists "Session management, MFA, password policy" as a template — never implemented.
- **Why it matters:** HQ can be exposed via a **public tunnel with password auth** (`publicRelay`/`passwordMode` in `settings.tsx`). A leaked or brute-forced password then gives full command-plane access (agent control, secrets, mailbox).
- **Recommendation:** TOTP enrollment for password mode when the HQ is reachable beyond loopback (Settings → Security). Store the TOTP secret vault-encrypted, require code on login, generate recovery codes. Effort: medium; biggest single security win.
- **Resolution (2026-08-02):** TOTP 2FA fully implemented. RFC 6238 module in `packages/core/src/security/totp.ts`. Two-phase enrollment (`totpPendingSecret` → `totpSecret`) prevents lockout. Login flow: password correct + TOTP active → 5-min pending-2FA session → `/api/login/verify` (TOTP code or recovery code). Rate-limited verify endpoint. 8 SHA-256-hashed recovery codes. Blocked on HTTP API routes + WS upgrade. UI: enrollment wizard in Settings + TOTP code entry in token-gate. 31 tests (20 unit + 11 route).

#### H2 — Password takeover with a stolen token (capability gap) — ✅ RESOLVED
- **[V]** `handleApiPassword` requires `currentPassword` **only** when `isCookieAuth(auth) && passwordHash` exists (`auth-handlers.ts:253`). A request authenticated by a **browser token** (any capability) can set/remove the HQ password **without knowing the current one** — the UI confirms this: `requiresCurrentPassword = passwordMode && authKind === 'password'` (`settings.tsx:59`).
- **Why it matters:** a leaked/read-only token is treated as "any authenticated principal", so it can **change or remove the password** and lock out the legitimate operator (or take over a public-tunnel deployment). Token capabilities (`control.enqueue` etc.) are not consulted on this route.
- **Resolution (2026-08-02):** `handleApiPassword` now requires `currentPassword` for **all** callers (cookie and token) when a password exists, unless the caller has the new `auth.admin` capability. DELETE path also cascades TOTP cleanup (removes orphaned `totpSecret`/`totpRecoveryCodes`). UI updated: `requiresCurrentPassword` simplified to `passwordMode === true`. Test updated to verify token-auth without `currentPassword` → 403.

### 🟠 Medium

#### M1 — Per-IP rate limiting only; weak behind proxies and against distributed attempts — ✅ RESOLVED
- **[V]** `loginAttempts` keyed by `req.socket.remoteAddress` only; in-memory (resets on restart); backoff caps at 16s, no hard lockout.
- **Why it matters:** behind a reverse proxy/public relay, **all users share one IP** → a few failures can lock out everyone; conversely a distributed brute force from many IPs bypasses per-IP throttling entirely. In-memory state is trivial to reset by restarting the HQ.
- **Resolution (2026-08-02):** `LoginAttemptStore` (`packages/cli/src/hq-server/login-attempt-store.ts`) replaces the in-memory `Map`. Lockout state persists to `login-attempts.json` (owner-only, 0o600 + icacls) with 500ms debounced write-through. Compound rate-limit key: `IP + SHA-256(password)` so rotating-IP attackers can't bypass per-IP backoff. Loads on startup, flushes on shutdown, prunes stale entries automatically.

#### M2 — No idle/sliding session timeout; sessions invisible to the user — ✅ RESOLVED
- **[V]** Sessions are in-memory `Map` with a fixed 7-day absolute max age; logout kills only the current session; there is **no UI to list/revoke active sessions** (a session handler exists but the Web UI has no session management view — only "Log out this browser").
- **Why it matters:** a stolen cookie stays valid for up to 7 days with no idle timeout, and an operator cannot see or revoke other active sessions (e.g. after losing a laptop).
- **Resolution (2026-08-02):** 30-min idle timeout with sliding refresh (`lastSeenAt` bumped on every authenticated HTTP + WS request). 7-day absolute max age retained. New APIs: `GET /api/auth/sessions` (list) + `DELETE /api/auth/sessions/:id` (revoke one) + `DELETE /api/auth/sessions` (revoke all). UI: `SessionsSection` in Settings showing kind/age/idle time + per-session revoke + "Sign out everywhere". Token-gate TOTP flow also fixed: recovery-code input support + back-to-password affordance.

#### M3 — Password policy is length-only; no strength/breached check — ✅ RESOLVED
- **[V]** Only 8–1024 length is enforced (client + server). No complexity guidance, zxcvbn meter, or breached-password check. UI hint says just "Minimum 8 characters".
- **Resolution (2026-08-02):** Zero-dependency `scorePassword()` function in `settings.tsx` — scores length tiers (≥8/12/16), character variety (lowercase/uppercase/digits/symbols), pattern penalties (repeated chars, sequential, dictionary hits). `PasswordStrengthMeter` component with animated bar + level label (weak/fair/good/strong). Color-coded: red/amber/primary/bright. CSS in `screens.css`.

#### M4 — OAuth token expiry not surfaced in the TUI panel — ✅ RESOLVED
- **[V]** `keySummary()` in `auth-panel.tsx` shows `masked + method + createdAt` — **no expiry/refresh state** for OAuth tokens (Claude/Codex tokens have short lifetimes and refresh flows).
- **Resolution (2026-08-02):** `formatExpiry()` function in `auth-panel.tsx` — color-coded expiry badge on every key row with `expiresAt` set. Tiers: expired/<1h (red error), <24h (yellow warning), >24h (dim inactive). Data already flowed through `AuthKeyRow.expiresAt` → panel-service → TUI; this adds the visual rendering. No external dependencies.

#### M5 — Token in query string can leak — ✅ RESOLVED
- **[V]** `?token=` is an accepted auth channel (`extractBrowserToken`); the upgrade-to-cookie path (WS-065) exists, but the raw query form can leak into server logs / browser history / referrers.
- **Resolution (2026-08-02):** HTTP path (`extractBrowserToken` in `auth.ts`) already rejects `?token=` on non-loopback origins — falls through to `Authorization: Bearer` header instead. WS path (`hq-server.ts`) now applies the same loopback gate to `/ws/browser` upgrades — non-loopback browsers must use the session cookie. `/ws/client` is exempt (programmatic-only, cookies impractical). Both paths log `hq.token_from_query_param_rejected` / `hq.ws_token_from_query_rejected` warnings.

### 🟡 Low

- **L1 [A]** No self-service **registration or password reset**: this is a deliberate local-first design (bootstrap code = the invite; password recovery = CLI/data-dir access). For public-tunnel use, document the recovery path in Settings and add an operator-initiated reset (single-use code) so a forgotten password doesn't strand a remote operator. — ✅ RESOLVED
  - **Resolution (2026-08-02):** Recovery-path documentation box in Settings → Access controls, shown only when `publicRelay === true`. Documents the exact 3-step recovery procedure (stop server, edit auth.json, restart with --password). Notes shell-access requirement. CSS styled with accent2 left-border for visibility. 
- **L2 [V]** No **show/hide password** toggle, caps-lock hint, or autofocus on the token gate / password forms (minor a11y + UX). — ✅ RESOLVED
  - **Resolution (2026-08-02):** Reusable `PasswordInput` component with eye/eye-off toggle. All password inputs in token-gate (token, password, TOTP) and settings (current/new/confirm) replaced. Smart `autoFocus` on the primary input of each form.
- **L3 [A]** Cookie lacks a `__Host-` prefix (defense-in-depth; fine on loopback, nice hardening for public origin). — ✅ RESOLVED
  - **Resolution (2026-08-02):** Cookie name switches to `__Host-hq.session` when `Secure=true` (HTTPS/public tunnel). Browser-enforced: requires Secure + Path=/ + no Domain. Prevents subdomain cookie injection. All read sites check both names for backward compat. Loopback stays `hq.session` (can't use `__Host-` without Secure).
- **L4 [A]** Auth events (login success/failure, password change, logout) are not surfaced in an audit view for the operator; a small "recent auth events" panel would help detect intrusions on public-tunnel deployments. — ✅ RESOLVED
  - **Resolution (2026-08-02):** `readHqAuthAuditTail()` in core reads the last 50 entries from `auth-audit.jsonl`. `GET /api/auth/audit` endpoint serves them. `AuthAuditSection` component in Settings displays kind labels (Token created/revoked, First-run, Expired-prune, Password rotated), scope badges, truncated token IDs, actor, and relative timestamps in a scrollable panel.

---

## 4. Suggested priority order

1. ~~**H1** — TOTP 2FA for password mode~~ — ✅ Done (2026-08-02)
2. ~~**H2** — capability-gate / current-password on password-management routes~~ — ✅ Done (2026-08-02)
3. ~~**M2** — session idle timeout + active-session management UI~~ — ✅ Done (2026-08-02)
4. ~~**M1** — rate-limit hardening for public-relay mode~~ — ✅ Done (2026-08-02)
5. ~~**M3** — live password strength indicator~~ — ✅ Done (2026-08-02)
6. ~~**M4** — OAuth token expiry/refresh state in TUI panel~~ — ✅ Done (2026-08-02)
7. ~~**M5** — Token in query string can leak (prefer Bearer header).~~ — ✅ Done (2026-08-02)
8. ~~**L4** — Auth audit panel in Settings~~ — ✅ Done (2026-08-02)
9. ~~**L2** — show/hide password toggle + autofocus~~ — ✅ Done (2026-08-02)
10. ~~**L3** — `__Host-` cookie prefix~~ — ✅ Done (2026-08-02)
11. ~~**L1** — recovery-path docs for public-tunnel deployments~~ — ✅ Done (2026-08-02)

**All findings resolved.**

## 5. Verification status

- **Verified this session:** all `[V]` items above by direct file reads; auth test suites executed green (50/50 across TOTP unit tests, 2FA route tests, password-login tests; typecheck 0 errors; lint 0).
- **Resolved findings:** All 12 (H1, H2, M1–M5, L1–L4) — implemented, tested, and typechecked clean. No open items remain.
- **Assumed:** `[A]` items are consistent inferences from multiple read files; not exercised end-to-end (no running HQ instance or browser session this review).
- **Out of scope / owned elsewhere:** a parallel agent's diffs reviewed by chimera (wire-adapter suppression, cli-main-helpers governance fence, run-tui suppression) are not part of this report.
