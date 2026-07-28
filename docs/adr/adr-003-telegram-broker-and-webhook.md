# Architecture Decision Record — 003: Telegram Delivery Architecture

| Field | Value |
|---|---|
| **Date** | 2026-07-28 |
| **Status** | Accepted |
| **Deciders** | WrongStack core team |
| **Supersedes** | — |
| **Superseded by** | — |
| **Related** | `packages/telegram/src/bot.ts`, `packages/telegram/src/poll-lock.ts`, `packages/telegram/src/index.ts`, `packages/telegram/src/inbox-cursor-store.ts`, `packages/telegram/src/offset-store.ts`, `docs/adr/` |

## Context

The Telegram plugin currently uses **local polling**: every wstack instance that activates the plugin calls `getUpdates` against the Telegram Bot API. The P1 phase hardened this architecture with:

- **Cross-process poll lock** (`poll-lock.ts`): a filesystem-based lock ensures only one instance consumes `getUpdates` per bot token, preventing HTTP 409 conflicts.
- **Standby takeover**: instances that fail to acquire the lock wait and periodically retry; when the holder stops or its heartbeat expires, a standby takes over.
- **Atomic offset persistence** (`offset-store.ts`): cursors survive crashes via `writeSync` + `fsync` + atomic rename.
- **Per-chat inbox cursor** (`inbox-cursor-store.ts`): per-chat cursor files keep ack boundaries independent.

However, the current architecture has several structural limitations:

1. **Standby instances cannot receive updates**: a standby instance never polls, so `telegram_read` returns only stale buffered messages and `telegram_approve` cannot receive callback queries. Users must wait for lock takeover, which takes up to 45 seconds (the stale heartbeat window).

2. **No cross-project routing**: all updates go to whichever instance holds the lock. There is no mechanism to route updates to the correct project or session.

3. **No webhook convergence**: Telegram's Bot API supports webhooks (Telegram pushes updates to a public HTTPS endpoint) as an alternative to polling. Webhooks eliminate the polling race altogether but require a publicly reachable HTTPS server with a valid certificate and `secret_token`.

4. **Polling overhead**: every instance polls on a timer even when there are no updates, consuming network and API rate-limit budget.

5. **Approval scope is process-bound**: approval requests are registered in-process. If the polling instance crashes, pending approvals are lost — and if a standby takes over, it has no knowledge of pending approvals from the previous holder.

These limitations motivate evaluating whether a central broker or webhook migration would better serve the multi-instance, multi-surface use case.

## Current architecture (local polling)

```
┌──────────────┐     getUpdates     ┌─────────────────┐
│  Instance A  │ ◄─────poll─────────│  Telegram API   │
│  (lock held) │                    │  api.telegram.  │
│              │                    │  org            │
│  Bot.poll()  │                    └─────────────────┘
│              │
│  onMessage() │─────► buffer ───► telegram_read
│              │─────► callback ──► telegram_approve
└──────────────┘

┌──────────────┐
│  Instance B  │  (standby — no poll, no updates)
│  (lock wait) │   retries every 15s
└──────────────┘
```

## Options considered

### Option A — Stay with local polling (current), refine standby behaviour

**Description:** Keep the current polling architecture. Address standby limitations by:
- Reducing stale heartbeat window (currently 45s) to speed takeover.
- Adding health-check polling every N seconds on standby to detect takeover faster.
- Documenting that standby instances have limited read/approve capability.

**Pros:**
- Already implemented and hardened across P0–P3.
- No network security surface (no inbound HTTPS).
- Zero infrastructure cost — works on any machine, any network.
- Atomic lock and cursor persistence are already proven on Windows and POSIX.
- No migration cost.

**Cons:**
- Standby instances remain second-class: `telegram_read` returns stale data, `telegram_approve` does not work.
- Lock contention grows with the number of instances and projects sharing a token.
- No cross-project/intent routing.
- Approvals are not durable across process crashes.

### Option B — Central broker service

**Description:** A lightweight in-process or sidecar broker that owns all Telegram API interactions for a given token. All wstack instances route their Telegram operations through the broker.

```
┌────────────┐    IPC/WS    ┌────────────────────┐   getUpdates   ┌──────────┐
│ Instance A ├─────────────►│                    │ ◄──────────────│ Telegram │
│            │              │  Telegram Broker   │                │   API    │
│ Instance B ├─────────────►│  (one per token)   │◄───────────────│          │
│            │              │                    │   sendMessage  └──────────┘
│ Instance C ├─────────────►│                    │
└────────────┘              └────────────────────┘
                              │
                              ├── Inbox (shared cursor state)
                              ├── Approval registry (shared across instances)
                              ├── Update router (routes to correct instance)
                              └── Offset persistence
```

**Sub-options:**

- **B1 — Embedded broker (recommended for near-term):** The broker runs inside the first instance that starts the plugin (the lock holder). Other instances communicate via the inter-agent mailbox or a dedicated IPC channel.

- **B2 — Standalone broker process:** A separate `wstack telegram-broker` subprocess or sidecar. Requires process lifecycle management, health checks, and restart logic.

- **B3 — Persistent broker (recommended for long-term):** The broker persists its state to a shared database/JSONL. Survives process restarts and machine reboots. Enables durable approval registry and cross-session routing.

**Pros:**
- Standby instances get live updates via the broker (no more stale reads).
- Approval registry becomes cross-instance: pending approvals survive a crash.
- Single point for rate limiting, deduplication, and cursor management.
- Can route updates to the correct project or session based on metadata.
- Decouples polling from the consumer — bot token never leaves the broker.

**Cons:**
- Significant new infrastructure: IPC protocol, routing table, state persistence.
- Broker becomes a single point of failure if not replicated.
- Coordination complexity: how does a new instance find the broker?
- File-lock takeover logic must be replaced or augmented with broker election.
- Approval callback routing requires the broker to know which instance originated each request.

### Option C — Webhook mode

**Description:** Replace polling with Telegram's [webhook mechanism](https://core.telegram.org/bots/api#setwebhook). Telegram pushes updates to a public HTTPS endpoint as JSON POST requests.

```
┌──────────┐   POST /webhook   ┌──────────────┐
│ Telegram │ ────────────────► │  Public       │
│   API    │                   │  HTTPS Server │
│          │                   │  (e.g. Caddy, │
│          │                   │   nginx)      │
└──────────┘                   └──────┬───────┘
                                      │ reverse proxy
                                      ▼
                              ┌──────────────┐
                              │  wstack       │
                              │  webhook      │
                              │  handler      │
                              └──────────────┘
```

**Key requirements:**
- Public HTTPS endpoint with a valid TLS certificate (Let's Encrypt, Cloudflare, etc.).
- `secret_token` for authenticity verification (Telegram sends `X-Telegram-Bot-Api-Secret-Token` header).
- One webhook per bot token (calling `setWebhook` replaces any previous webhook AND disables `getUpdates`).
- Webhook server must respond with 200 OK quickly; Telegram retries with backoff on non-200.

**Pros:**
- No polling race: Telegram delivers exactly one copy of each update to the webhook URL.
- Lower latency: updates arrive immediately instead of waiting for the next poll interval.
- No `getUpdates` offset management for the basic delivery path.
- No HTTP 409 conflicts (only one consumer can exist).
- Scales to zero when idle (no polling traffic).

**Cons:**
- **REQUIRES a public HTTPS endpoint with a valid certificate.** This is the hard blocker for local/desktop users without a public IP or reverse proxy.
- One webhook per token: if multiple instances need updates, they must all share the same webhook receiver or implement an internal fan-out — which is the broker problem (Option B) again.
- Webhook replaces polling: switching to webhook removes the `getUpdates` fallback unless we implement a hybrid mode.
- `secret_token` management: the token must be configured at webhook registration and verified on every incoming request.
- TLS termination adds operational complexity.
- Telegram imposes a 1-second timeout for the webhook response; long-poll equivalents are not possible.
- Webhook delivery is at-most-once — if the server is down during delivery, the update is lost (Telegram does not queue indefinitely).
- Callback query answers (`answerCallbackQuery`) must still be sent via the API — webhook only handles inbound updates.
- Migration from polling to webhook and back requires `deleteWebhook`/`setWebhook` calls and careful cursor handoff.

## Decision

### Near-term (now — 3 months): **Option A+ — Enhanced local polling with reduced takeover**

Adopt Option A with targeted improvements:

1. **Reduce standby stale window** from 45s to **30s**, and heartbeat interval from 15s to **10s**. This cuts maximum takeover time from 45s to 30s.

2. **Add standby health light-poll**: a standby instance performs a lightweight `getMe` call every 30s to verify the API is reachable while waiting for the lock. This ensures that when takeover happens, the instance is ready.

3. **Document standby limitations clearly** in `/telegram-health` (already done in P3.2) and in plugin README.

**Rationale:** Polling is already hardened and proven. The remaining P3 work (broker/webhook) is a large architectural investment that should not delay the P3 Release Gate. Reducing the stale window from 45s to 30s is a simple constant change that addresses the most common complaint about standby.

### Medium-term (3–6 months): **Option B1 — Embedded broker**

Once the P3 Release is shipped, implement an **embedded Telegram broker**:

- The lock-holding instance (the current poller) also runs a lightweight **BrokerHub** that exposes a simple in-process or WS-based API.
- Other instances discover the broker via the lock file (which already carries the holder's identity). The lock file payload is extended with a `brokerPort` field.
- The broker forwards incoming updates to all connected consumers via the mailbox or a dedicated event bus channel.
- The broker holds the shared approval registry and cursor state.

**Rationale:** An embedded broker avoids the infrastructure cost of a sidecar while solving the standby-read/approve problem. It leverages the existing poll-lock for discovery and election. The broker dies with the holding instance — that's acceptable because the new lock holder starts its own broker.

### Long-term (6+ months): **Option B3 — Persistent broker with optional webhook for server deployments**

If the embedded broker proves valuable, evolve it into a persistent broker that:

- Stores state in a shared JSONL file or SQLite database.
- Supports both polling (default) and webhook input (optional for server deployments with public HTTPS).
- Provides a WS API for all wstack instances to subscribe to updates.
- Enables cross-session update routing and durable approval registry.

**Webhook remains an optional input path, not a replacement for polling.** For users with public HTTPS infrastructure, the broker can accept webhook deliveries and fan them out to local consumers — combining the reliability of webhooks with the zero-infrastructure convenience of polling.

## Consequences

### Positive

1. **Near-term** — Zero-change for most users: the lock takeover improvement is a constant change. P3 Release Gate is not blocked.
2. **Medium-term** — Standby instances gain live update access. Approval registry becomes resilient to individual instance restarts.
3. **Long-term** — Cross-instance update routing enables project/session-aware delivery. Webhook support becomes an additive capability for server deployments, not a mandatory migration.

### Negative

1. **Near-term** — Standby limitations continue to exist for the next 3+ months. Users who regularly switch between TUI and WebUI on different machines will experience stale reads on the non-polling instance.
2. **Medium-term** — Embedded broker adds code complexity to the Telegram plugin. The broker lifecycle (start/stop/elect) must be carefully implemented to match the polling loop's proven reliability.
3. **Long-term** — Persistent state introduces data migration concerns if the state format evolves.

### Risks

| Risk | Mitigation |
|---|---|
| Embedded broker becomes as complex as a standalone process | Set a hard scope limit: broker = update fan-out + approval registry only. No persistence, no routing, no webhook. If the scope grows, pivot to B2. |
| Webhook adoption pressure from users who want "zero latency" | Document the trade-off clearly: webhook requires public HTTPS. The broker abstracts the input source, so webhook becomes pluggable without disrupting polling users. |
| Lock file format extension breaks backwards compatibility | Use forward-compatible JSON: new fields (`brokerPort`) are optional, old lock consumers ignore them. Bump a version field if breaking changes are needed. |

## API and security boundaries

| Boundary | Rule |
|---|---|
| **Bot token** | Never appears outside the broker/bot. `safeBaseUrl` already redacts it. Embedded broker passes operations by reference, not by token value. |
| **Webhook secret_token** | Stored in config alongside `botToken`. Never logged, never returned in health output (P3.2 compliance). |
| **Approval registry** | Session-scoped — an instance can only see or settle its own approvals. The broker validates ownership before forwarding callback queries. |
| **Update routing** | The broker delivers updates to all connected consumers. Per-project filtering is a future capability that requires session metadata in the update path. |

## Rollback strategy

| Phase | Rollback |
|---|---|
| **Standby window change** (30s/10s) | Revert constants to 45s/15s. No data migration. |
| **Embedded broker** | Shut down the broker, fall back to direct polling (current behaviour). Consumers that lose the broker connection poll directly. The lock file's `brokerPort` field is optional — old/new instances coexist safely. |
| **Persistent broker** | Preserve the current polling path as a cold-path fallback. The persistent broker writes to an append-only JSONL; rollback replays from the last known good cursor. |

## Related work

- P1.9 (atomic poll-lock): provides the foundation for broker election via lock files.
- P1.6 / P1.7 (cursor semantics): atomic offset and inbox cursors provide the persistence primitives the broker will use.
- P1.10 (safe standby behaviour): defines the current standby contract that the broker will supersede.
- P3.2 (expanded health): health output already exposes lock owner identity, which the broker will extend with broker availability.
