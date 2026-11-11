# WrongMail implementation program

Status: proposed standalone project. No WrongMail server, client, adapter, or configuration is implemented by this plan.

Planning date: 2026-11-11. Intended ownership: WrongMail maintainers own the server, client CLI, and wire protocol; WrongStack maintainers own the mailbox-port adapter contract. Individual implementation owners are unassigned.

The plan lives in `docs/plans/wrongmail/` for review beside the existing [mailbox architecture](../../mailbox-architecture.md), [WrongIndex](../wrongindex/README.md), and [WrongMemory](../wrongmemory/README.md). A future implementation can start in a separate `D:\Codebox\PROJECTS\WrongMail` repository. This task creates documentation only; it does not create that project, provision a server, issue credentials, or change any coding tool's configuration.

## 1. Product objective

Create a Rust agent-mail service that any AI coding tool can use to talk to any other AI coding tool working on the same project, whether the agents run on the same machine or on different machines. The operator deploys one server (for example on a private Linux host), configures access with private credentials, and enrolls each coding-tool installation. From then on agents can:

- register a stable agent identity bound to a project and a live session;
- send direct messages, questions, assignments, reviews, results, and broadcasts;
- hold threaded conversations (chat) with other agents, regardless of vendor;
- see who is online and what they are working on;
- check their inbox when a session starts, when a prompt is submitted, when a turn stops, or periodically;
- acknowledge, complete, and record outcomes per agent.

"Any coding tool" is delivered as a layered integration matrix, not a single mechanism:

| Layer | What it gives a tool | Requires from the tool |
|---|---|---|
| MCP (stdio bridge or Streamable HTTP) | Typed mail tools the model can call | MCP client support |
| `wrongmail` CLI | Same operations from any shell | Ability to run a shell command |
| REST/JSON + watch stream | Same operations from any language or script | HTTP client |
| Hooks | Automatic inbox check/injection and status posting at lifecycle points | Tool-specific hook support |
| Skills / rules / AGENTS.md text | Teaches the register → read → reply → ack loop | Instruction file support |

Transport connectivity makes the tools available; it cannot force an agent to look. Periodic "check the inbox" behavior comes from hooks and instructions, and each is tested and disclosed per client.

WrongMail is the network-capable successor surface of the current project mailbox, not a second, parallel mailbox for the same project. When a WrongStack project is linked to a WrongMail server, WrongMail becomes the single source of truth for that project's conversation plane. See [WrongStack integration](client-integration.md#7-wrongstack-integration).

## 2. Read this package in order

| Document | Purpose |
|---|---|
| [Architecture and storage](architecture-and-storage.md) | Process model, crates, deployment modes, tenancy, SQLite layout, writer actors, events, retention |
| [Identity and security](identity-and-security.md) | Principals, enrollment, credentials, project grants, session and agent binding, TLS, limits, audit, prompt-injection fencing |
| [Messaging model and API](messaging-model-and-api.md) | Message types, addressing, threads and channels, receipts, cursors, REST endpoints, watch stream, MCP tool surface, CLI |
| [Client integration](client-integration.md) | Per-tool connection recipes, hook protocol, skills/rules, project linking, offline outbox, WrongStack adapter |
| [Deployment and operations](deployment-and-operations.md) | Linux server install, systemd, reverse proxy, local-only mode, backups, upgrades, monitoring, incident runbook |
| [Delivery backlog](delivery-backlog.md) | Ordered milestones, task IDs, dependencies, and separate-repository kickoff |
| [Validation](validation.md) | Acceptance matrix, security/isolation/fault tests, client smoke matrix, benchmarks, release proof |

## 3. Required scope

- One Rust server binary (`wrongmaild`) and one Rust client binary (`wrongmail`) that are statically distributable for Linux, Windows, and macOS.
- Same-machine use (loopback or local socket) and remote use (TLS over the network) through the same protocol and authorization model.
- Stable, machine-independent project identity; local checkouts are linked to a server project, never identified by their local path.
- Server-bound identity chain: principal → project grant → session → agent. No client-supplied string grants access or changes the sender.
- Wire compatibility with the current WrongStack mailbox semantics: message types, address forms, `leaders` audience, per-actor receipts, `replyTo` threading, and explicit `expiresAt`. Default retention is longer than WrongStack's because remote agents check in occasionally (WMB-ADR-014).
- Agent identities that are stable across tool restarts, so replies, receipts, and unread state survive a new session.
- Conversation features for agent-to-agent chat: threads, optional named channels, mentions, and presence.
- MCP tools with the same four tiers as the existing Mailbox MCP (`mailbox_read`, `mailbox_watch`, `mailbox_manage`, `mailbox_admin`).
- CLI and hook helper that work on any tool which can run a command, failing open when the server is unreachable.
- Watch/long-poll that delivers identifiers and cursors; clients re-query for authoritative bodies.
- Per-principal credentials stored only as keyed hashes, with expiry, rotation, and revocation; scoped capabilities; rate and size limits; append-only audit log.
- Every message delivered to a model is fenced as untrusted peer content.
- SQLite storage owned exclusively by the server process; backups, schema migration with rollback, idempotent writes.
- Operator CLI for projects, principals, grants, tokens, retention, diagnostics, and backup.

## 4. Explicit boundaries

- WrongMail is a coordination channel, not a permission system. A message never grants a receiving agent tool permissions, never bypasses the receiving tool's own approval prompts, and never executes anything on the receiving machine.
- No shell execution, file transfer, or remote code execution through the server. Messages may carry structured references (paths, commits, URLs); they do not carry attachments in v1.
- No reading of another tool's private transcript, editor state, or local files. Agents publish what they choose to send.
- Client-specific automatic behaviors (inbox injection, stop-time status) are claimed only for tool versions with a passing smoke test.
- No public open sign-up. Every principal is created or enrolled by an operator.
- No federation between independent WrongMail servers in v1.
- No end-to-end encryption in v1. Transport is TLS; the server operator can read message bodies. This is disclosed, and secret scrubbing on send is mandatory.
- No Postgres, Supabase, Redis, or other external database. Storage is SQLite owned by the server.
- WrongStack runtime `control` messages remain on the local IPC mailbox and never leave the machine.
- A remote/cloud coding agent can participate only if it can reach the server and hold a credential; WrongMail does not tunnel into private networks by itself.

## 5. Completion levels

| Level | Deliverable | Permitted claim |
|---|---|---|
| L0 | Frozen wire contract and fixtures from current WrongStack mailbox | Researched specification; no new service |
| L1 | `wrongmaild` with storage, auth, REST, watch; `wrongmail` CLI | Single-server preview over loopback and TLS |
| L2 | MCP bridge and Streamable HTTP, hook helper, skill, first client presets | Multi-tool preview; per-client claims limited to passing smoke tests |
| L3 | WrongStack adapter, offline outbox, migration import, hardened ops | WrongMail 1.0 for the declared client matrix and deployment modes |
| L4 | Channels UI, web console, additional clients, optional extensions | Individually tested increments |

## 6. Invariants

| ID | Required invariant |
|---|---|
| WMB-INV-01 | Only `wrongmaild` opens WrongMail SQLite files; every client uses the network/IPC protocol. |
| WMB-INV-02 | Every request is authenticated to a principal and authorized against that principal's project grants before any data is read. |
| WMB-INV-03 | `from`, sender session, receipt actor, and deletion attribution are set by the server from the bound session, never from request fields. |
| WMB-INV-04 | Tool name, model name, `origin`, and display labels are attributed metadata, never proof of identity or authority. |
| WMB-INV-05 | Project identity is a server-issued ID; local paths, git remotes, and MCP roots are hints that resolve to it only through an authorized link. |
| WMB-INV-06 | Visibility (address, audience, project, deletion) is enforced before ranking, pagination, counts, or watch events can disclose data. |
| WMB-INV-07 | A message commits, with its event row, before the success reply or any watch notification. |
| WMB-INV-08 | Retrying an admitted send with the same idempotency key returns the original message and creates nothing new. |
| WMB-INV-09 | Receipts are per actor; broadcast and alias messages have no single global completion state. |
| WMB-INV-10 | Message bodies reach a model only inside an unforgeable untrusted-content fence. |
| WMB-INV-11 | `control` cannot be sent by any principal; it is not part of the WrongMail wire profile. |
| WMB-INV-12 | Revoked or expired credentials and sessions receive no further replies, events, or cached data. |
| WMB-INV-13 | Hooks and the CLI fail open: an unreachable server degrades to a short notice, never blocks or breaks the host tool. |
| WMB-INV-14 | Plaintext secrets never appear in the database, logs, audit records, committed config, hook files, or skill files. |
| WMB-INV-15 | A schema version newer than the running binary is rejected without mutation. |
| WMB-INV-16 | A linked WrongStack project has exactly one authoritative conversation store. |

## 7. Baseline and evidence boundary

Inspected WrongStack HEAD: `198aade0b7e6c87909d4e33801d28de74f94c08f`. The checkout contains unrelated dirty work (desktop-v2, agent learning files). Source observations describe these files in the working tree:

- `docs/mailbox-architecture.md` — current ownership, protocol v3 operation list, addressing, receipts, retention, MCP tiers, untrusted-content fence rule.
- `packages/contracts/src/types/mailbox.ts` — `MailboxMessageType` union and `MAILBOX_MESSAGE_TYPES`, `MailboxMessage`, receipt and agent-status shapes.
- `packages/core/skills/wrongstack-mailbox-mcp/SKILL.md` — external-agent coordination loop.
- `packages/telegram/src/security/inbound.ts` — referenced in the mailbox doc as the canonical fence implementation (not re-read for this plan).

No mailbox database was opened or exported. Existing tests are referenced as contract evidence, not as results run for this plan.

## 8. Dependency preflight

No WrongMail manifest exists. WrongStack's mailbox is TypeScript on Bun/Node `DatabaseSync`; none of the crates below are WrongStack dependencies.

Live crates.io snapshot read on 2026-11-11 (`max_stable_version`):

| Candidate | Stable | Published | Decision |
|---|---|---|---|
| `tokio` | 1.54.1 | 2026-10-21 | Async runtime |
| `axum` | 0.8.9 | 2026-04-14 | HTTP router, SSE, extractors |
| `tower-http` | 0.7.1 | 2026-08-31 | Limits, timeouts, tracing, compression; verify axum 0.8.9 compatibility |
| `axum-server` | 0.9.2 | 2026-11-11 | Optional built-in TLS listener. Published on planning day; evaluate before pinning |
| `rustls` | 0.23.46 | 2026-10-14 | TLS; exclude 0.24.0-dev.* |
| `tokio-rustls` | 0.26.6 | 2026-09-28 | TLS stream integration |
| `rusqlite` | 0.42.0 | 2026-11-11 | Bundled SQLite. Published on planning day; compare with 0.41.1 (used by the WrongMemory snapshot) for FTS5/backup/WAL features before pinning |
| `rmcp` | 3.9.0 | 2026-11-05 | Official Rust MCP SDK; WrongMemory planned against 3.8.0. Verify protocol-revision coverage for stdio and Streamable HTTP |
| `reqwest` | 0.13.5 | 2026-09-08 | Client HTTP in `wrongmail` (rustls backend) |
| `serde` | 1.0.229 | 2026-07-18 | DTOs |
| `schemars` | 1.2.3 | 2026-10-12 | JSON Schema export for MCP tool and REST contracts |
| `clap` | 4.6.7 | 2026-09-14 | CLI |
| `ulid` | 3.0.0 | 2026-07-16 | IDs |
| `argon2` | 0.6.0 | 2026-08-27 | Low-entropy secrets only (operator passphrase); see token design |
| `hmac` / `sha2` | 0.13.0 / 0.11.1 | 2026-03 / 2026-10 | Keyed hashes of high-entropy tokens; verify they share one `digest` major |
| `subtle` | 2.6.1 | 2024-06-24 | Constant-time comparison |
| `rand` | 0.10.3 | 2026-09-20 | Token generation (OS RNG) |
| `governor` / `tower_governor` | 0.10.4 / 0.8.0 | 2025-12 / 2025-08 | Rate limiting candidate; `tower_governor` may lag axum/tower-http majors, so verify or implement a thin layer over `governor` |
| `tracing` | 0.1.44 | 2025-12-18 | Structured logs |
| `time` | 0.3.55 | 2026-08-01 | RFC 3339 timestamps |
| `thiserror` / `anyhow` | 2.0.21 / 1.0.104 | 2026-09 / 2026-07 | Errors |
| `directories` | 6.0.0 | 2025-01-12 | Client config/state paths |
| `tokio-tungstenite` | 0.30.0 | 2026-07-11 | Only if WebSocket is added; SSE is the default watch transport |
| `sqlx` | 0.9.0 | 2026-05-21 | Not selected: one SQLite engine (`rusqlite`) on dedicated writer threads avoids two drivers |

Sources: `https://crates.io/api/v1/crates/<name>` for each row. Rust toolchain/MSRV, exact feature flags, and transitive native dependencies are selected in the M1 preflight spike, not guessed here. Commit `Cargo.lock` and `rust-toolchain.toml`. Re-run this check before the first pin; two releases above were published on the planning day.

## 9. Principal design decisions

| ADR | Proposed decision |
|---|---|
| WMB-ADR-001 | Separate repository; independently versioned server, client, wire protocol, and storage schema |
| WMB-ADR-002 | One server process per deployment; per-project SQLite files with one writer actor each, plus a registry database |
| WMB-ADR-003 | HTTPS + JSON REST is the canonical protocol; MCP, CLI, and hooks are projections of the same service methods |
| WMB-ADR-004 | Server-issued project IDs with authorized link rules (git remote patterns, explicit link) |
| WMB-ADR-005 | Principal-per-installation credentials; short-lived session tokens bound to one project and one agent |
| WMB-ADR-006 | Keep WrongStack message types, address forms, audience, receipts, and `expiresAt` semantics as wire profile `wm1` |
| WMB-ADR-007 | Add threads and named channels as `wm1` extensions that WrongStack's adapter can ignore safely |
| WMB-ADR-008 | SSE watch stream and long-poll fallback carry IDs and cursors only |
| WMB-ADR-009 | Keep the four existing MCP tier tool names so the current skill and agents transfer |
| WMB-ADR-010 | All model-facing delivery is fenced untrusted content; trust labels inform, never authorize |
| WMB-ADR-011 | Linked WrongStack projects move their conversation plane to WrongMail; `control` stays on local IPC |
| WMB-ADR-012 | Client-side durable outbox for offline sends; no local shadow inbox treated as truth |
| WMB-ADR-013 | Built-in TLS optional; reverse-proxy TLS termination is the default production recipe |
| WMB-ADR-014 | Default `network` retention profile keeps unread addressed mail, incomplete asks/assignments/reviews, and whole threads; WrongStack's short defaults remain available as `wrongstack-local` |
| WMB-ADR-015 | Agent ID is stable per (project, principal, name); sessions carry token lifetime, presence, and attribution only |

## 10. Program completion

The program is complete when two or more different coding tools, on at least two machines, hold a threaded conversation through one deployed server with correct identity attribution, isolation, receipts, and fencing; a linked WrongStack project uses WrongMail as its single conversation store; and installed artifacts pass the security, isolation, fault, and client smoke matrix in [Validation](validation.md). A working `send` and `inbox` alone is insufficient.

All commands, endpoints, numbers, and targets in this package are planned. Runtime tests, client smoke tests, benchmarks, and deployment proofs are NOT RUN.
