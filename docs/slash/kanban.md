# `/kanban` — Project kanban boards

`/kanban` manages persisted multi-board kanban state for the active project. Aliases: `/kb`, `/board`.

## Board commands

```text
/kanban
/kanban open
/kanban create <title>
/kanban duplicate <boardId> [title]
/kanban show <boardId>
/kanban delete <boardId>
/kanban rename <boardId> <title>
/kanban snapshot [boardId]
/kanban queue [boardId]
/kanban generate <description>
/kanban export <boardId>
/kanban prune [days] [--all] [--yes]
```

`queue` is an alias for `snapshot`. `prune` clears accumulated run-mirror
boards: it keeps anything touched within `days` (default 7), skips boards with
unfinished work unless `--all` is given, and is a **dry run** until `--yes`
(or `-y`).

The managed `Backlog → Todo → Running → Review → Done` lifecycle has no slash
subcommand — a board is put under it, or released from it, with the `kanban`
tool's `adopt_managed_lifecycle` / `release_managed_lifecycle` actions. Once a
board is managed, `/kanban task move` and `done` route through the lifecycle
guard and report which field a refused transition wants. See
[kanban-architecture.md §17](../kanban-architecture.md#17-managed-lifecycle).

> **TUI note:** the TUI `/kanban add <title>` command accepts `--desc <text>`
> (or `-d`). On a managed board the description is **required** and the card
> is always created in the Backlog column regardless of `--column`; the kanban
> panel advances managed cards with `→` / `t` (which opens a transition
> prompt), since free-form status edits are rejected by the lifecycle guard.

Bare `/kanban` lists boards. `open` (also accepted as `panel` or `tui`) opens the kanban panel when the TUI callback is available; otherwise it reports that the panel is TUI-only.

## Task, column, and graph commands

```text
/kanban task <boardId>
/kanban task add <boardId> <title>
/kanban task ready [boardId]
/kanban task claim [boardId] <agent>
/kanban task release <boardId> <taskId>
/kanban task show|move|done|block|remove ...
/kanban task split|merge|chain|copy|transfer ...
/kanban task priority|assign|dispatch|depend ...
/kanban task metric add|set ...
/kanban task note ...
/kanban task check add ...
/kanban column add <boardId> <title>
/kanban column rm <boardId> <columnId>
/kanban graph export|import|sync ...
/kanban deps <boardId> <taskId>
```

Use `/help kanban` for the complete argument shapes emitted by the registered command. Board and task ids may be abbreviated where the implementation can resolve the prefix unambiguously.

## Code reference

- `packages/cli/src/slash-commands/kanban.ts` — registered command and parsing
- `packages/kanban/` — board persistence and domain operations
- `packages/tui/src/kanban-slash.ts` — TUI-side parsing and the F12 / Ctrl+Y panel
- [kanban-architecture.md](../kanban-architecture.md) — the system behind the command
