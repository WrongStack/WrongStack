# @wrongstack/mailbox-mcp

Expose one WrongStack project's authoritative Mailbox to MCP clients without opening its SQLite
database or legacy files from the MCP process.

For the complete external management surface:

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

The default server exposes `mailbox_read` and `mailbox_watch`. `--writable` adds message sends,
receipts, soft-delete/restore, and self-presence. `--admin` adds destructive maintenance and mailbox
credential administration and implies writable mode. Runtime-only `control` messages are never
exposed; use normal `steer` messages to redirect an agent.

HTTP is available with `--http --port 8767`. A non-loopback bind is refused unless `--token` is
provided. The configured `--actor` is authoritative for sender identity, receipts, deletion actor,
registration, and heartbeats; callers cannot impersonate another actor through tool arguments.

`mailbox_watch` is a bounded long poll over daemon events. Events are wake-up hints, not message
snapshots: reconcile with `mailbox_read` after an event or timeout.

The bundled external-agent workflow is
`@wrongstack/core/skills/wrongstack-mailbox-mcp/SKILL.md`.
