# @wrongstack/kanban-mcp

Expose one WrongStack project's authoritative Kanban service to MCP clients without opening its
SQLite database or legacy files from the MCP process.

```bash
wstack-kanban-mcp --project-root /absolute/project/path
```

The default stdio server exposes `kanban_read` and `kanban_watch`. Add `--writable` for
`kanban_manage`. Use `--destructive` for the complete external management surface, including
create/update/move/assignment/verification plus delete, merge, and transfer; it implies
`--writable`.

```json
{
  "mcpServers": {
    "wrongstack-kanban": {
      "command": "wstack-kanban-mcp",
      "args": ["--project-root", "/absolute/project/path", "--destructive"]
    }
  }
}
```

HTTP is available with `--http --port 8766`. A non-loopback bind is refused unless `--token` is
provided. Use `--actor <stable-agent-id>` so Kanban activity identifies the external caller.

`kanban_watch` is a bounded long poll over the daemon's mutation stream. Events are wake-up hints,
not state snapshots: call `kanban_read` after an event, timeout, or disconnect to reconcile the
authoritative board revision.

The bundled external-agent workflow is
`@wrongstack/core/skills/wrongstack-kanban/SKILL.md`. Copy the complete `wrongstack-kanban` folder
from the installed `@wrongstack/core/skills` directory into the coding tool's project or user skill
directory (for example `.claude/skills/` or `.codex/skills/`).
