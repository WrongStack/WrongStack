# `wstack mailbox serve` - Mailbox HTTP bridge

Runs a loopback HTTP façade over the project's shared `GlobalMailbox`, so
**external** coding agents (Claude Code, Aider, custom scripts) can read and
send messages on the same channel WrongStack-internal agents use. Every route
is a thin JSON-in/JSON-out wrapper over a `GlobalMailbox` method, so file
locking, mtime-cached reads, heartbeats, and HQ telemetry behave exactly as
they do for internal callers — external agents never get raw file access.

## Usage

| Command | Effect |
|---|---|
| `wstack mailbox` / `wstack mailbox serve` | Bind `127.0.0.1` on an OS-assigned port |
| `wstack mailbox serve --port <n> --strict-port` | Pin the exact port and fail if it cannot be bound |
| `wstack mailbox serve --port 0` | Explicitly request an OS-assigned free port |
| `wstack mailbox serve --host <ip>` | Expose beyond loopback — NOT recommended without a re-authenticating reverse proxy |
| `wstack mailbox help` | Show the process-level usage |

From inside a REPL session, `/mailbox-serve` spawns this subcommand as a
detached child (see `docs/slash/mailbox-serve.md`).

## Authentication

The mailbox bridge supports two authentication modes:

### 1. Legacy bearer token (default)

On first start a 32-byte random bearer token is minted and persisted in the
lock file AND `<projectDir>/.mailbox.token` (mode 0600). Restarts reuse it.
Clients authenticate via `Authorization: Bearer <token>`.

- Single instance per project via `<projectDir>/.mailbox-bridge.lock`
- Default: loopback only (`127.0.0.1`). Non-loopback requires `--host` + explicit override.
- **Deprecated** — will be removed after one stable release with zero observed legacy clients.

### 2. Identity credentials (recommended)

Opaque per-principal credentials issued by the `JsonlCredentialStore`. Each
credential carries a **project-scoped identity**, a **role kind** (agent,
operator, service), a bounded **time-to-live**, and a **capability set**.

**Issuance** (at project root):
```js
const {JsonlCredentialStore} = require('@wrongstack/core/coordination');
const store = new JsonlCredentialStore(projectDir); // ~/.wrongstack/projects/<slug>
await store.load();
const {credential, secret} = await store.issue({
  principalId: 'my-agent',
  kind: 'agent',
  capabilities: ['mail.read.self', 'mail.ack.self'],
  ttlMs: 7 * 86400_000,
});
// credential.credentialId, secret
```

**Usage** — set `Authorization: Credential <id>:<secret>` header on every request.

**Credential lifecycle:**

| Operation | Method | Audit event |
|---|---|---|
| Issue | `store.issue(input)` | `credential.issued` |
| Verify | `store.verify(id, secret)` | — |
| Revoke | `store.revoke(id, reason)` | `credential.revoked` |
| Rotate | issue + revoke old | `credential.rotated_out` |
| Expire | automatic after TTL | `credential.expired` |

Secrets are stored as HMAC-SHA-256 keyed hashes; the raw secret is never
persisted. TTL is bounded by principal kind (agents 7d, operators 24h, services
30d).

### Capability matrix

| Capability | Authorizes |
|---|---|
| `mail.send.informational` | Send note, btw, result, status, broadcast |
| `mail.send.actionable` | Send ask, assign, review (implies informational) |
| `mail.send.directive` | Send steer (implies actionable) |
| `mail.read.self` | Query/check messages visible to this principal |
| `mail.read.all` | Administrative query of all messages |
| `mail.ack.self` | Acknowledge messages for this principal only |
| `mail.events.self` | Subscribe to SSE filtered to this principal's visibility |
| `mail.events.all` | Subscribe to unfiltered SSE (implies `self`) |
| `mail.admin.receipts` | View aggregate receipt state across actors |

Implication: `all` implies `self` within each domain.

## Routes

All routes are authentication-gated:

```
POST /mailbox/send              POST /mailbox/query
POST /mailbox/check             POST /mailbox/ack
POST /mailbox/ack-many          POST /mailbox/unread-count
POST /mailbox/agents/register   POST /mailbox/agents/heartbeat
POST /mailbox/register-client   POST /mailbox/heartbeat
GET  /mailbox/agents
GET  /mailbox/events            SSE event stream
```

Startup prints a `mailbox_serve_started` JSON event with the bind URL, project
dir, and token path — deterministic hook for scripts.

## Actor-scoped responses

When authenticated with an identity credential, responses reflect the caller's
own state:

| Field | What it shows |
|---|---|
| `readByMe` | Has the calling principal read this message? |
| `completedByMe` | Has the calling principal completed it? |
| `actionRequiredForMe` | Does this message need attention from the caller? |
| `readBy` / `completedBy` | Aggregate state (requires `mail.admin.receipts`) |

A broadcast message completed by one leader does **not** disappear from another
leader's actionable flow — each recipient has independent state tracked through
v2 receipt records (GM-P0.4).

## Audience routing

Every send surface accepts the same delivery audience:

- `audience: "all"` (or omitted) — visible to ordinary agents and leaders.
- `audience: "leaders"` — consumed only by leader agents and leader-facing
  terminal/WebUI/HQ views; subagent inbox, polling, and queries exclude it.

Audience is separate from the recipient address. For private operator mail,
use `to: "leader"` together with `audience: "leaders"`.

## Migration from bearer to identity

1. Issue identity credentials for each external agent.
2. Add `Authorization: Credential <id>:<secret>` headers alongside existing
   `Authorization: Bearer <token>` headers. The bridge tries credential first.
3. Verify all clients authenticate and capabilities are enforced.
4. Remove bearer-token authentication from clients.
5. Remove the `.mailbox.token` file manually (the lock file is cleaned on restart).
6. After one stable release with zero legacy-auth requests across all known
   deployments, the bearer compatibility path will be removed.

## Code Reference

- `packages/cli/src/subcommands/handlers/mailbox-serve.ts` — bridge startup
- `packages/core/src/coordination/global-mailbox.ts` — storage + transport
- `packages/core/src/coordination/mailbox-credential-store.ts` — credential lifecycle
- `packages/core/src/coordination/mailbox-http-router.ts` — HTTP route dispatch + auth
- `docs/slash/mailbox-serve.md` — slash command docs
- `docs/slash/mailbox.md` — operator mailbox commands
- `docs/specs/global-mailbox-p0-contract-repairs.md` — full specification (24 acceptance criteria)
