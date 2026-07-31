---
name: wrongstack-mailbox-mcp
description: Coordinate with WrongStack agents through the project-scoped Mailbox MCP server. Use when an external coding agent needs to inspect unread or incomplete messages, query conversation history, discover online agents, send direct/reply/broadcast/steer messages, acknowledge outcomes, maintain its presence, soft-delete or restore messages, watch for changes, or perform explicitly authorized Mailbox administration without reading Mailbox files or SQLite directly.
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

1. Call `mailbox_manage` with `register_self`. Include a stable name and role when known.
2. Call `mailbox_read` with `unread`, then `query`. Prefer `unreadBy` plus `incompleteOnly` when
   looking for actionable work.
3. Use `mailbox_read` with `online_agents` before routing a time-sensitive direct message.
4. Use `mailbox_manage` with `send`. Set an explicit recipient and message type:
   - `ask` for a blocking question;
   - `assign` for delegated work;
   - `steer` for changed direction;
   - `review` for review requests;
   - `result` for a completed outcome;
   - `broadcast` only when every relevant agent should receive it.
5. Set `replyTo` when continuing a thread. Do not create an unrelated message that loses context.
6. Use `ack` or `ack_many` after reading or completing messages. Record a truthful outcome when
   marking work completed.
7. Send `heartbeat_self` during long work and `deregister_self` on a clean shutdown.

Runtime-only `control` messages are deliberately unavailable. Use `steer` for normal external
direction; never bypass the restriction through another channel.

## Observe changes

Call `mailbox_watch` with an optional event type and timeout no greater than 25 seconds. Treat the
result as a wake-up hint. After every event or timeout, reconcile with `mailbox_read`; watch events
contain identifiers and metadata, not the authoritative message snapshot.

## Manage and administer

- `mailbox_read` provides query, unread counts, agent/client discovery, and daemon status.
- `mailbox_manage` provides send, receipt/completion acknowledgement, soft-delete/restore, and
  self-presence. It requires `--writable` or `--admin`.
- `mailbox_admin` provides clear, purge, compaction, and credential issue/verify/revoke/rotate/list
  operations. It requires `--admin`, which implies writable mode.

Before `clear_all`, purge, credential revocation/rotation, or another broad administrative action,
confirm that it is explicitly requested and re-read relevant state. Never use an admin operation to
work around a routing, identity, or authorization error.
