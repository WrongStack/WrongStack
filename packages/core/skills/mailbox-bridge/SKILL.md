---
name: mailbox-bridge
description: |
  Use this skill when external coding agents (Claude Code, Aider, custom
  scripts) need to participate in the project's shared WrongStack mailbox,
  or when a user asks to "expose the mailbox", "let Claude Code read the
  mailbox", "external agent mailbox", "mailbox bridge", or "HTTP mailbox
  bridge". Starts a loopback HTTP façade over the same GlobalMailbox that
  WrongStack-internal agents already share, so any agent with curl or
  fetch can read, send, and acknowledge messages.
version: 1.0.0
---

# Mailbox Bridge — Expose the Shared Mailbox to External Agents

> **Bundled skill.** This file is shipped with `@wrongstack/core` and
> auto-discovered via `bundledSkillsDir`. To pin it to a specific project,
> run `wstack skill install <path-to-this-file>` once — the project-level
> manifest at `~/.wrongstack/projects/<slug>/installed-skills.json` will
> record that override.

## Overview

WrongStack-internal agents (CLI, TUI, WebUI, ACP) already share one
project-level mailbox at `~/.wrongstack/projects/<slug>/_mailbox.jsonl`.
This skill starts a thin loopback HTTP server that wraps that exact same
`GlobalMailbox` so external coding agents — Claude Code, Aider, Continue,
a user's own scripts — can read and send messages on the same channel
without going through the JSONL file or implementing the file-lock
protocol.

```
┌────────────────────────────────────────────────────────────────────┐
│                    WrongStack project dir                          │
│                                                                    │
│   ~/.wrongstack/projects/<slug>/                                  │
│   ├── _mailbox.jsonl            ← shared message store              │
│   ├── _mailbox.registry.json    ← agent heartbeats                  │
│   └── _mailbox.clients.json     ← REPL/TUI/WebUI/external clients   │
│                                                                    │
│              ▲             ▲             ▲             ▲            │
│              │             │             │             │            │
│       ┌──────┴───┐  ┌──────┴───┐  ┌──────┴───┐  ┌──────┴───┐       │
│       │ Leader A │  │ BugHunter│  │ WebUI    │  │ External │        │
│       │ (CLI)    │  │ (CLI)    │  │ (browser)│  │ agent    │        │
│       └──────────┘  └──────────┘  └──────────┘  └─────▲────┘       │
│                                                       │            │
│                                            HTTP POST │ /mailbox/* │
│                                                       │            │
└───────────────────────────────────────────────────────┼────────────┘
                                                        │
                                          ┌─────────────┴───────────┐
                                          │  wstack mailbox serve   │
                                          │  (this skill)           │
                                          │  wraps GlobalMailbox    │
                                          └─────────────────────────┘
```

The bridge does NOT introduce a parallel store. External calls go through
`GlobalMailbox`, so file locking, mtime-bounded reads, agent heartbeats,
read receipts, and HQ telemetry happen exactly as they do for
WrongStack-internal callers. An external agent and a WrongStack-internal
agent posting to the same `agentId` are indistinguishable to the rest of
the system — the WebUI's "online agents" panel will show them side by
side, with `source = 'http'` distinguishing the HTTP path.

## When to use this skill

- The user asks to "let Claude Code send/receive on the mailbox".
- The user wants to run a script (build bot, CI hook, alerting agent)
  alongside WrongStack that should participate in the project's inter-agent
  coordination.
- The user wants to debug or inspect mailbox traffic from another tool
  without granting it access to the JSONL file.

## When NOT to use this skill

- The external agent speaks MCP natively — use `wstack mcp serve` instead
  (it exposes WrongStack's tool registry, including the mailbox tool).
- The user wants SMTP/IMAP-style email integration — WrongStack's mailbox
  is internal-only and is not an email server. Reject that direction.
- The user wants the external agent to act on the wider file system or
  other WrongStack tools — the bridge exposes ONLY mailbox operations.

## Setup

Run from any terminal where `wstack` is on PATH and the project is the
working directory:

```
wstack mailbox serve
```

Or, if the user is already in a WrongStack REPL/TUI:

```
/mailbox-serve
```

The server prints its bind URL and writes the bearer token to
`~/.wrongstack/projects/<slug>/.mailbox.token` (mode `0600`). The token
is rotated on every server start, so external agents must read it
freshly each time they connect — never hardcode.

To pass it to the external agent, set two environment variables:

```
WRONGSTACK_MAILBOX_URL=http://127.0.0.1:7788
WRONGSTACK_MAILBOX_TOKEN=$(cat ~/.wrongstack/projects/<slug>/.mailbox.token)
```

### Flags

| Flag | Default | Notes |
|------|---------|-------|
| `--host <ip>` | `127.0.0.1` | Loopback by default. Pass `0.0.0.0` to expose on LAN — NOT recommended without a reverse proxy that re-authenticates and rate-limits. |
| `--port <n>` | OS-assigned (`0`) | The default binds port 0 so the OS picks a free port and the printed URL is always reachable. Pass an explicit number to pin. |
| `--strict-port` | off | With `--port <n>`, fail if the port is in use. Without it, the bridge still works on a different port because it always lets the OS assign when `--port` is omitted. |

## Routes

All routes take JSON bodies on POST (or no body on GET). All requests
require `Authorization: Bearer <token>`. All responses are JSON.

| Method | Path | Wraps |
|--------|------|-------|
| POST | `/mailbox/send` | `GlobalMailbox.send` |
| POST | `/mailbox/query` | `GlobalMailbox.query` |
| POST | `/mailbox/ack` | `GlobalMailbox.ack` |
| POST | `/mailbox/ack-many` | `GlobalMailbox.ackMany` (batch under one lock + rewrite) |
| POST | `/mailbox/unread-count` | `GlobalMailbox.unreadCount` |
| POST | `/mailbox/agents/register` | `GlobalMailbox.registerAgent` (`source = 'http'`) |
| POST | `/mailbox/agents/heartbeat` | `GlobalMailbox.heartbeat` |
| POST | `/mailbox/register-client` | `GlobalMailbox.registerClient` (`source = 'http'`) |
| POST | `/mailbox/heartbeat` | `GlobalMailbox.clientHeartbeat` |
| GET | `/mailbox/agents` | `GlobalMailbox.getAgentStatuses` |
| GET | `/mailbox/agents/online` | `GlobalMailbox.getOnlineAgents` |
| GET | `/healthz` | liveness probe (no auth) |

### Error shape

Every error response follows the WrongStack API convention:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "field \"from\" is required (string)" } }
```

| Code | HTTP | When |
|------|------|------|
| `VALIDATION_ERROR` | 400 | Missing/wrong-type field in request body, body too large, or invalid JSON. |
| `UNAUTHORIZED` | 401 | Missing or wrong bearer token. |
| `NOT_FOUND` | 404 | No route for the request method + URL. |
| `INTERNAL_ERROR` | 500 | `GlobalMailbox` threw (e.g. file-lock contention, disk full). |

### Limits

- Body cap: **256 KB**. The mailbox message format is small; this leaves
  headroom for long bodies and base64 attachments while rejecting
  pathological payloads before they reach `JSON.parse`.
- No rate limiting at the bridge layer — assume the bearer token is the
  only credential and trust the loopback network.

## Pairing with the external-facing skill

This internal skill describes how to run the server. The
`wrongstack-mailbox` skill (also bundled with `@wrongstack/core`) describes
how the external agent uses the routes. When configuring an external agent,
install both:

- In the WrongStack project: `bundledSkillsDir/mailbox-bridge/` (this file)
- In the external agent's project: copy
  `bundledSkillsDir/wrongstack-mailbox/SKILL.md` to the agent's skills
  directory (e.g. `.claude/skills/wrongstack-mailbox/SKILL.md`).
  The repo ships `scripts/install-mailbox-bridge-skills.sh` for this.

## Examples

### Start the bridge from REPL or TTY

```
$ wstack mailbox serve
WrongStack mailbox bridge listening on http://127.0.0.1:34827
Project dir:  ~/.wrongstack/projects/wrongstack-abc1234
Token file:   ~/.wrongstack/projects/wrongstack-abc1234/.mailbox.token (mode 0600)

Routes:
  POST /mailbox/send              send a message
  POST /mailbox/query             query messages
  ...
  GET  /healthz                   health probe (no auth)

Send the bearer token in: Authorization: Bearer <token>
Cat the token from another shell:
  cat ~/.wrongstack/projects/wrongstack-abc1234/.mailbox.token

Press Ctrl+C to stop.
```

### Send a message via curl

```
curl -X POST http://127.0.0.1:34827/mailbox/send \
  -H "Authorization: Bearer $(cat ~/.wrongstack/projects/wrongstack-abc1234/.mailbox.token)" \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "external-scout",
    "to": "*",
    "type": "broadcast",
    "subject": "Hello from outside",
    "body": "External agent has joined the conversation.",
    "priority": "normal"
  }'
```

### Register so the external agent appears in the WebUI

```
curl -X POST http://127.0.0.1:34827/mailbox/agents/register \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "agentId": "claude-code-3941", "sessionId": "external",
        "name": "Claude Code", "role": "external", "pid": 3941 }'
```

The agent now shows up at `GET /mailbox/agents` and in the WebUI's
online-agents panel with `source: 'http'`.

### Heartbeat loop (keep the agent visible as "online")

```
# Every 30 s while alive:
curl -X POST http://127.0.0.1:34827/mailbox/agents/heartbeat \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "agentId": "claude-code-3941", "currentTask": "auditing auth layer" }'
```

Without heartbeats the agent flips to offline after 60 s.

### Query with a poll

```
# Every 5–10 s, only new messages since last poll:
curl -X POST http://127.0.0.1:34827/mailbox/query \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "to": "claude-code-3941", "since": "2026-06-27T08:50:00.000Z", "limit": 50 }'
```

### Acknowledge many in one batch

```
curl -X POST http://127.0.0.1:34827/mailbox/ack-many \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "acks": [
    { "messageId": "msg_aaa", "readerId": "claude-code-3941", "read": true },
    { "messageId": "msg_bbb", "readerId": "claude-code-3941", "read": true, "completed": true, "outcome": "Handled in PR #42" }
  ]}'
```

The batch path takes a single file lock and does one rewrite — preferred
over N sequential `/mailbox/ack` calls.

## How it ends

`Ctrl+C` (SIGINT) or `SIGTERM` triggers a graceful shutdown: stop accepting
new connections, let in-flight requests finish, flush the mailbox cache,
unlink the token file. The `mailbox_serve_started` and
`mailbox_serve_stopping` JSON log lines on stdout are the deterministic
hooks for any log-shipper watching the process.

## Health watchdog

`packages/core/src/coordination/mailbox-health.ts` (bundled with the
bridge) provides a `MailboxHealthWatchdog` that periodically probes
`/healthz` and posts a `mailbox-bridge-down` status event to the project
mailbox if the bridge stops responding. Wire it up once via the
`mailbox:watchdog:start` slash command or by calling
`mailbox-health:start()` from a custom subcommand. Default probe interval
is 15 s.

## Security notes

- The token is the only credential. Anyone who can read
  `~/.wrongstack/projects/<slug>/.mailbox.token` AND reach the bind host
  can act on the project's mailbox. Loopback binding makes "reach"
  require shell access on the host machine.
- Token comparison is `timingSafeEqual` — there's no byte-level
  side-channel.
- The bridge does NOT log message bodies. The structured
  `mailbox_serve_started` event includes the bind URL, port, project dir,
  and token path — never the token itself.
- The HTTP server has no request logging at the access-log level. If
  audit trails of which external agent called which route are needed,
  the agent itself should log them client-side.

## Skills in scope

- `prompt-engineering` — for the external-facing `wrongstack-mailbox`
  skill that pairs with this one.
- `node-modern` — for `AbortSignal.timeout` patterns the external agent
  should use when calling these routes.
- `output-standards` — for the `<next_steps>` shape in the paired
  external skill.
- `security-scanner` — for confirming the bridge's bearer-token handling
  matches project security conventions.