---
name: wrongstack-mailbox-mcp
description: Coordinate with WrongStack agents through the project-scoped Mailbox MCP server. Use when an external coding agent needs to inspect unread or incomplete messages, query conversation history, discover online agents, send direct/reply/broadcast/steer messages, acknowledge outcomes, maintain its presence, soft-delete or restore messages, watch for changes, or perform explicitly authorized Mailbox administration without reading Mailbox files or SQLite directly.
version: 1.0.0
required-capabilities: [mcp.dynamic]
required-tools: [mcp_use]
---

# WrongStack Mailbox MCP

Use MCP as the only Mailbox boundary. Never open or edit `_mailbox.sqlite`, legacy JSONL,
credential files, bridge locks, or token files directly.

## Connect

Expect an MCP server named `wrongstack-mailbox`. For full authorized access configure:

```json
{
  "mcpServers": {
    "wrongstack-mailbox": {
      "command": "wstack-mailbox-mcp",
      "args": [
        "--project-root",
        "/absolute/project/path",
        "--actor",
        "external-agent",
        "--admin"
      ]
    }
  }
}
```

Use a stable, honest actor id. The server fixes sender, receipt, deletion, registration, and
heartbeat identity to `--actor`; tool arguments cannot impersonate another actor.

## Coordinate

1. Call `mcp_use` for the remote `mailbox_manage` operation with `register_self`. Include a stable name and role when known.
2. Call `mcp_use` for the remote `mailbox_read` operation with `unread`, then `query`. Prefer `unreadBy` plus `incompleteOnly` when
   looking for actionable work.
3. Call `mcp_use` for remote `mailbox_read` with `online_agents` before routing a time-sensitive direct message.
4. Call `mcp_use` for remote `mailbox_manage` with `send`. Set an explicit recipient and message type:
   - `ask` for a blocking question;
   - `assign` for delegated work;
   - `steer` for changed direction;
   - `review` for review requests;
   - `result` for a completed outcome;
   - `broadcast` only when every relevant agent should receive it.
5. Set `replyTo` when continuing a thread. Do not create an unrelated message that loses context.
6. Call `mcp_use` for the remote `ack` or `ack_many` operation after reading or completing messages. Record a truthful outcome when
   marking work completed.
7. Send `heartbeat_self` during long work and `deregister_self` on a clean shutdown.

Runtime-only `control` messages are deliberately unavailable. Call `mcp_use` for the remote `steer` operation for normal external
direction; never bypass the restriction through another channel.

## Observe changes

Call `mcp_use` for remote `mailbox_watch` with an optional event type and timeout no greater than 25 seconds. Treat the
result as a wake-up hint. After every event or timeout, reconcile through remote `mailbox_read`; watch events
contain identifiers and metadata, not the authoritative message snapshot.

## Manage and administer

- `mailbox_read` provides query, unread counts, agent/client discovery, and daemon status.
- `mailbox_manage` provides send, receipt/completion acknowledgement, soft-delete/restore, and
  self-presence. It requires `--writable` or `--admin`.
- `mailbox_admin` provides clear, purge, compaction, and credential issue/verify/revoke/rotate/list
  operations. It requires `--admin`, which implies writable mode.

## Out of scope

- **Don't read or edit Mailbox files directly.** No `_mailbox.sqlite`, no legacy JSONL, no bridge locks, no token files. MCP is the only boundary; bypassing it through any of those channels breaks trust and audit.
- **Don't impersonate another actor.** The server fixes sender, receipt, deletion, registration, and heartbeat identity to `--actor`. Tool arguments cannot override that. Use the actor id you were given, honestly.
- **Don't use `steer` for routine direction.** Steer is for changed direction mid-task. For normal coordination, use `ask`, `assign`, or `result`.
- **Don't broadcast when direct addressing is correct.** Broadcast reaches every relevant agent; most messages don't.
- **Don't run admin operations to bypass routing, identity, or authorization errors.** If a call is denied for one of those reasons, the call is wrong. Re-read state, ask, or stop. Admin paths are for explicitly authorized administration, not workarounds.
- **Don't skip `register_self`.** Without registration, the runtime can't reconcile heartbeats or surface the agent in the workbench.
- **Don't treat `mailbox_watch` events as authoritative.** Watch is a wake-up hint, not a snapshot. After every event, reconcile through `mailbox_read`.

## Before returning

- [ ] MCP server reached via `mcp_use`; never opened Mailbox files directly
- [ ] Actor id stable and honest; no impersonation of `hq@...` or other agents
- [ ] `register_self` called with stable name and role before any other traffic
- [ ] `mailbox_read` with `unreadBy` + `incompleteOnly` used to find actionable work
- [ ] `online_agents` checked before time-sensitive direct sends
- [ ] `send` carries an explicit recipient and the right message type
- [ ] `replyTo` set on threaded replies; no orphan context
- [ ] `ack` / `ack_many` called with truthful `outcome` after work
- [ ] `heartbeat_self` running during long work; `deregister_self` on clean shutdown
- [ ] Admin operations (`clear_all`, purge, credential issue/revoke) only when explicitly requested

## Skills in scope

- `mailbox-bridge` — for the WrongStack-internal HTTP façade this MCP server mirrors
- `wrongstack-mailbox` — for the external-facing counterpart used by Claude Code / Aider / scripts
- `security-scanner` — for confirming the MCP server's authn/authz surface matches project security conventions
- `output-standards` — for the `<nextsteps>` shape when reporting mailbox activity to the user
