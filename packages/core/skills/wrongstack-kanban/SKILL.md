---
name: wrongstack-kanban
description: Monitor and manage a WrongStack project's IPC-backed Kanban through the wrongstack-kanban MCP server. Use when an external coding agent needs to inspect boards or task details, find or claim ready work, update tasks and assignments, follow dependencies, attach notes/checks/evidence, verify completion, recover stale work, or wait for Kanban changes without directly reading Kanban files or SQLite.
---

# WrongStack Kanban

Use the MCP tools as the only state boundary. Never open or edit
`.wrongstack/kanbans/_kanban.sqlite`, board JSON, event JSONL, or HQ sync files directly.

## Connect

Expect a configured MCP server named `wrongstack-kanban`. If it is missing, ask the user to add:

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

This full-management configuration exposes create, update, move, assignment, verification, delete,
merge, and cross-board transfer operations. `--destructive` implies `--writable`. The bare server
default remains read-only, so never try to bypass a narrower configuration through files or SQLite.

## Work with a board

1. Call `kanban_read` with `list_boards`, then `get_board`. Treat returned state and revision as
   authoritative.
2. Before selecting work, inspect `ready_tasks`, `queue_health`, or `snapshot`. Respect dependencies,
   existing assignments, completion gates, and managed lifecycle rules.
3. Before any material mutation, re-read the board. Another human or agent may have changed it.
4. Use `kanban_manage` with `claim_task` before starting unassigned work. Record a stable actor by
   configuring the server with `--actor` when possible.
5. Keep task and assignment state current. Use `heartbeat_assignment` during long work,
   `transition_task` for managed boards, and `release_task` if work cannot proceed.
6. Add truthful notes, checks, links, goal metrics, and verification evidence as they become known.
7. Before completion, re-read the task, run `verify_completion`, and satisfy the board's completion
   gate. Do not mark a task done merely because implementation ended.

On stale-write or policy errors, re-read the board and reassess. Do not retry the same mutation with
cached inputs.

## Observe changes

Call `kanban_watch` with an optional `boardId` and a timeout no greater than 25 seconds. It returns
the next daemon mutation event, timeout, or disconnect.

Treat every watch result as a wake-up hint. After an event, timeout, or disconnect, call
`kanban_read` again to reconcile authoritative state. A watch event is not a complete board snapshot
and events can occur between long-poll calls.

## Choose the permission tier

- Use `kanban_read` for listing, board/task detail, search, ready work, events, queue health,
  snapshots, exports, and chains.
- Use `kanban_manage` for create/update/move, dependencies, assignments, heartbeats, recovery,
  evidence, verification, atomicity assessment, decomposition, and lifecycle transitions.
- Use `kanban_destructive` only when the user explicitly intends to delete state, merge tasks, or
  transfer a task out of its source board. Re-read both source and destination immediately before
  the call.

If a tool is not advertised, report the missing server permission tier. Do not bypass it through
files, SQLite, shell commands, or another API.
