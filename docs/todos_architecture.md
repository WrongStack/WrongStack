# Todos System Architecture

> **Scope:** This document describes the `todos` subsystem in WrongStack — the live task board that the LLM mutates per-turn, its persistence model, integration points across CLI / TUI / WebUI, and the relationship to the higher-level `plan` system.
>
> **Last updated:** 2026-06-06

---

## 1. Overview

The **todos system** is WrongStack's moment-to-moment task tracker. It lives in the mutable conversation state (`Context.todos`) and is surfaced to the model via the `todo` tool, to the user via slash commands (`/todos`), and to frontends via event broadcasts. Its design goals are:

1. **Simplicity** — a small, flat list the model can read and write in a single tool call.
2. **Observability** — every mutation is an event; subscribers (TUI, WebUI, checkpoint writer) react without polling.
3. **Durability** — an atomic on-disk checkpoint rehydrates the board on `wstack resume`.
4. **Single-writer** — only one item may be `in_progress` at a time; the tool enforces this invariant.

The todos system is intentionally **not** a project-management layer. For roadmap-level planning there is a separate `/plan` command backed by `plan-store.ts` (see §6).

---

## 2. Data Model

### 2.1 `TodoItem`

```ts
// packages/core/src/core/context.ts
export interface TodoItem {
  id: string;                          // opaque, caller-generated
  content: string;                     // imperative description ("Build the project")
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;                 // progressive aspect ("Building the project")
}
```

- **`activeForm`** is optional. When present, the TUI and formatter prefer it for `in_progress` rows so the board reads like a live status line.
- **No nesting, no priorities, no deadlines.** Those belong in `/plan` or in the conversation itself.

### 2.2 Invariants

| Invariant | Enforcer | Failure mode |
|-----------|----------|--------------|
| Exactly one `in_progress` item | `todoTool.execute` | Extra `in_progress` items are downgraded to `pending` (first wins) |
| `id` + `content` required | `todoTool.execute` | Items missing either field are silently dropped |
| `status` ∈ enum | JSON Schema | Provider-level validation rejects invalid values before execution |

---

## 3. State Layer (`ConversationState`)

Todos live inside `Context`, but mutations MUST go through `ConversationState` so observers stay in sync.

```
Context (mutable bag)
├── messages: Message[]
├── todos: TodoItem[]          ← raw array, direct mutation bypasses observers
├── readFiles, fileMtimes, meta
│
└── state: ConversationState   ← observable wrapper
    ├── replaceTodos(todos)    → emits `todos_replaced`
    ├── replaceMessages(msgs)  → emits `messages_replaced`
    └── onChange(handler)      → subscribes to the event stream
```

### 3.1 Why `state.replaceTodos()` is mandatory

- **Direct mutations** (`ctx.todos.push(...)`, `ctx.todos.length = 0`) are invisible to the checkpoint writer and TUI auto-echo.
- **Observed mutations** (`ctx.state.replaceTodos([...])`) fire `StateChange` events → subscribers react immediately.

**As of 2026-06-06, ALL mutation paths use `state.replaceTodos()`:**
- `todoTool` → `ctx.state.replaceTodos(items)`
- `/todos add/done/clear/remove` → `ctx.state.replaceTodos(...)`
- WebUI `todos.clear` / `todos.remove` → `context.state.replaceTodos(...)`

### 3.2 StateChange types

```ts
// packages/core/src/core/conversation-state.ts
export type StateChange =
  | { kind: 'message_appended'; message: Message }
  | { kind: 'messages_replaced'; messages: readonly Message[] }
  | { kind: 'todos_replaced'; todos: readonly TodoItem[] }
  | { kind: 'meta_set'; key: string; value: unknown }
  | { kind: 'meta_deleted'; key: string }
  | { kind: 'meta_cleared' };
```

---

## 4. Persistence (`todos-checkpoint.ts`)

### 4.1 File format

```ts
// packages/core/src/storage/todos-checkpoint.ts
export interface TodosCheckpointFile {
  version: 1;
  sessionId: string;
  updatedAt: string;   // ISO-8601
  todos: TodoItem[];
}
```

- Stored at `<projectSessions>/<date>/sess_<ULID>.todos.json`
- Written atomically via `atomicWrite` with `0o600` permissions
- Version field makes future migrations trivial

### 4.2 Lifecycle

```
Session start
│
├─ resume path ──► loadTodosCheckpoint(path)
│                  └─► if found, ctx.state.replaceTodos(restored)
│
├─ new path ─────► (empty list, no file yet)
│
└─► attachTodosCheckpoint(state, path, sessionId)
    └─ subscribes to 'todos_replaced' events
        └─ debounced 150ms → atomic write
```

### 4.3 Debouncing & flush-on-detach

The subscriber uses a 150 ms debounce so a burst of edits (e.g. the LLM marking three items done in one tool call) coalesces into a single disk write. The `detach` function flushes any pending write before unsubscribing, preventing data loss at shutdown.

```ts
const detach = attachTodosCheckpoint(state, filePath, sessionId);
// ... later ...
await detach();  // guaranteed flush
```

### 4.4 Error posture

- **Read failure** (missing / corrupt file) → returns `null`, treated as "no prior state"
- **Write failure** → logged to `console.warn`, does **not** throw; a lost checkpoint must not crash the agent run
- **Validation on load**: filters out items with missing/invalid `id`, `content`, `status`, or non-string `activeForm`

---

## 5. Tool: `todo`

### 5.1 Schema

```ts
// packages/tools/src/todo.ts
export const todoTool: Tool<TodoInput, TodoOutput> = {
  name: 'todo',
  category: 'Session',
  description: 'Replace the current todo list with a new set of items.',
  usageHint:
    'BEST PRACTICE for complex tasks:\n' +
    '- At the beginning of a non-trivial task, create a clear todo list.\n' +
    '- Only **one** item should be `in_progress` at any time.\n' +
    '- Update the list frequently as work progresses.\n' +
    '- **Re-order items** to reflect current priorities.\n' +
    'This tool is extremely valuable for maintaining focus.',
  permission: 'auto',
  mutating: false,          // mutates only conversation state, not external state
  timeoutMs: 1_000,
  inputSchema: { /* array of TodoItem objects */ },
};
```

### 5.2 Execution semantics

1. Validate `input.todos` is an array.
2. Filter out items missing `id` or `content`.
3. Enforce single-`in_progress` invariant (first wins, rest → `pending`).
4. Call `ctx.state.replaceTodos(items)` — triggers `todos_replaced` event.
5. Return `{ count, in_progress }`.

### 5.3 Why "replace the full list"

The tool is **not** CRUD. The LLM sends the *entire* desired board on every call. This avoids race conditions (the model's view of the board is always the ground truth) and eliminates the need for separate add/remove/done tools.

Item order is significant — the model controls order by the array order it submits. Re-ordering items to reflect current priorities is an explicit best practice in the usage hint.

---

## 6. Slash Command: `/todos`

```
/todos                  → show formatted list
/todos show             → same
/todos clear            → wipe all items
/todos add <text>       → append a pending item
/todos done <id|#>      → mark matched item completed
/todos remove <id|#>    → delete matched item
/todos rm <id|#>        → alias for remove
/todos delete <id|#>    → alias for remove
```

- Implemented in `packages/cli/src/slash-commands/todos.ts`
- Uses `randomUUID()` for IDs when user adds items manually
- Matching priority: 1-based index → exact `id` → case-insensitive substring
- All mutations use `ctx.state.replaceTodos()` — observers (checkpoint writer, TUI) stay in sync

---

## 7. Rendering

### 7.1 Text formatter (`formatTodosList`)

```
Todos (1/3 done):
   1. [ ] Write tests
   2. [~] Building the project      ← activeForm used
   3. [x] Initialize repo
```

- Source: `packages/core/src/utils/todos-format.ts`
- Used by:
  - `/todos` slash command (CLI)
  - TUI auto-echo after `todo` tool execution
  - Any future consumer that needs a plain-text snapshot

### 7.2 TUI integration

**Status bar** (line 3): shows live counts as `todos ⌛N ☐M ✓K`.

**F5 — Autonomy settings editor**: settings for autonomy mode, delay, YOLO, chime, and other preferences.

**F6 — Full-screen overlay** (`TodosMonitor`): bordered panel with two-column layout on wide terminals. F6 or Esc to close.

**Auto-echo**: the `tool.executed` event listener checks `e.name === 'todo'` and, on success, dispatches an `info` entry containing `formatTodosList(agent.ctx.todos)`.

### 7.3 WebUI integration

**`TodosPanel` component** (`packages/webui/src/components/TodosPanel.tsx`): self-contained, subscribes to `todos.updated` WS events. Renders each item with status icon, colored left border, and hover-to-reveal ✕ remove button.

**Server WS messages**:
- `todos.get` — returns current snapshot on demand
- `todos.clear` — wipes the array via `state.replaceTodos([])`
- `todos.remove` — removes a single item by id or 1-based index

All mutations broadcast `todos.updated` with the new snapshot.

---

## 8. Relationship to `/plan`

| Aspect | `/todos` (todos system) | `/plan` (plan system) |
|--------|------------------------|----------------------|
| **Granularity** | Per-turn task board | Strategic roadmap |
| **Mutated by** | LLM via `todo` tool + user via slash | User via slash command |
| **Persistence** | `todos-checkpoint.ts` (auto) | `plan-store.ts` (auto) |
| **Lifespan** | Session-scoped, derived | Session-scoped, canonical |
| **Typical use** | "Build the project → Test → Deploy" | "Refactor auth layer → Add OAuth → Audit" |

Both systems can coexist: a user might set up a high-level plan with `/plan`, then the LLM breaks the current plan step into concrete todos.

---

## 9. Feature Plan

### 9.1 Short-term (next 1–2 releases) — ✅ COMPLETE

| # | Feature | Status | Files touched |
|---|---------|--------|---------------|
| 1 | **Fix `/todos` direct-mutation gap** | ✅ **Done** | `packages/cli/src/slash-commands/todos.ts` |
| 2 | **Todo item ordering** | ✅ **Done** | `packages/tools/src/todo.ts` |
| 3 | **WebUI todo panel** | ✅ **Done** | `packages/webui/src/components/TodosPanel.tsx` |
| 4 | **Todo count in status bar** | ✅ **Done** (was already present) | Status bar line 3 chip |

### 9.2 Medium-term (next 3–6 releases)

| # | Feature | Motivation | Files touched |
|---|---------|------------|---------------|
| 5 | **Todo -> Plan bridge** | Allow promoting a todo item into a plan item (and vice versa). | `packages/cli/src/slash-commands/todos.ts`, `packages/core/src/plugins/plan-plugin.ts` |
| 6 | **Todo history / undo** | Keep a rolling log of todo mutations (last N states) so the user can undo an accidental `clear`. | `packages/core/src/storage/todos-checkpoint.ts`, `packages/core/src/core/conversation-state.ts` |
| 7 | **Per-todo notes / subtasks** | Optional `notes?: string` and `subtasks?: TodoItem[]` fields. | `packages/core/src/core/context.ts`, `packages/core/src/utils/todos-format.ts` |
| 8 | **Todo deadlines / reminders** | Optional `dueAt?: string` with reminder hook. | `packages/core/src/core/context.ts`, `packages/core/src/kernel/events.ts` |

### 9.3 Long-term / exploratory

| # | Feature | Motivation |
|---|---------|------------|
| 9 | **Cross-session todo archive** | Persist completed todos across sessions for project retrospectives and audit trails. |
| 10 | **Todo templates** | Pre-defined todo lists for common workflows ("new feature", "bug fix", "release") that the LLM can instantiate with one tool call. |
| 11 | **Collaborative todos** | Fleet / multi-agent scenarios where subagents report progress on shared todo items via the fleet bus. |

---

## 10. Fix Plan

### 10.1 Known bugs / gaps — ALL FIXED ✅

| ID | Issue | Severity | Status |
|----|-------|----------|--------|
| F-1 | `/todos add/done` mutated `ctx.todos` directly, skipping observers. | **Medium** | ✅ Fixed — all mutations via `state.replaceTodos()` |
| F-2 | `todoTool` declared `mutating: false` but mutates conversation state. | **Low** | ✅ Documented — `mutating` means *external* side effects; conversation state mutation is internal and needs no confirmation. |
| F-3 | `todos-checkpoint.ts` didn't validate `activeForm` on load. | **Low** | ✅ Fixed — validates `typeof t.activeForm === 'string'` |
| F-4 | No test covered the `/todos` slash command. | **Low** | ✅ Fixed — 16 test cases including `remove` path |
| F-5 | WebUI `todos.clear` used direct mutation. | **Medium** | ✅ Fixed — uses `state.replaceTodos([])` |

### 10.2 Refactoring candidates

| ID | Idea | Risk | Reward |
|----|------|------|--------|
| R-1 | **Merge todos and plan stores** | High — different lifecycles, different consumers | Simpler persistence layer, single rehydration path |
| R-2 | **Extract `TodoItem` into its own schema file** | Low | Easier to share with validation libraries (Zod, etc.) |
| R-3 | **Make `Context.todos` private, force `state.todos`** | Medium — breaks legacy tools | Guarantees observer consistency, eliminates F-1 class bugs |
| R-4 | **Add a `TodoRegistry` abstraction** | Medium | Would enable plugins to register custom todo renderers, validators, or hooks |

---

## 11. File Index

| File | Role |
|------|------|
| `packages/core/src/core/context.ts` | `TodoItem` interface, `Context` class (holds raw `todos` array) |
| `packages/core/src/core/conversation-state.ts` | Observable wrapper, `replaceTodos()`, `onChange()` |
| `packages/core/src/storage/todos-checkpoint.ts` | Atomic save/load, `attachTodosCheckpoint()` subscriber, activeForm validation |
| `packages/core/src/utils/todos-format.ts` | `formatTodosList()` text renderer |
| `packages/tools/src/todo.ts` | `todoTool` definition, execution logic, ordering hint |
| `packages/cli/src/slash-commands/todos.ts` | `/todos` slash command — show/add/done/clear/remove |
| `packages/cli/src/wiring/session.ts` | Session setup: restore todos on resume, attach checkpoint |
| `packages/cli/src/slash-commands/clear.ts` | `/clear` wipes todos via `state.replaceTodos([])` |
| `packages/cli/src/slash-commands/context.ts` | `/context` prints todo counts |
| `packages/cli/tests/slash-diag-memory-todos.test.ts` | `/todos` slash command tests (16 cases) |
| `packages/tui/src/app.tsx` | TUI auto-echo, F5 compact panel, F6 monitor overlay |
| `packages/tui/src/app-reducer.ts` | `todosMonitorOpen` + `rightTodosPanelOpen` state |
| `packages/tui/src/components/compact-todos-panel.tsx` | F5 right-side compact panel with overflow indicator |
| `packages/tui/src/components/todos-monitor.tsx` | F6 full-screen monitor overlay |
| `packages/tui/src/components/status-bar.tsx` | Line 3 todos chip + `statusBarTodosSpan()` for mouse |
| `packages/webui/src/components/TodosPanel.tsx` | Live todos panel with remove button |
| `packages/webui/src/server/index.ts` | WS handlers for `todos.get`, `todos.clear`, `todos.remove` |
| `packages/webui/src/lib/ws-client.ts` | `getTodos()`, `clearTodos()`, `removeTodo()` methods |
| `packages/webui/src/types.ts` | WS message types |
| `packages/core/tests/storage/todos-checkpoint.test.ts` | Checkpoint round-trip, debounce, detach-flush tests |
| `packages/tools/tests/todo.test.ts` | Tool execution and single-`in_progress` enforcement tests |
| `packages/core/tests/core/run-env-state.test.ts` | `ConversationState` observer tests (including `replaceTodos`) |

---

## 12. Glossary

| Term | Definition |
|------|------------|
| **Checkpoint** | An atomic on-disk snapshot of `todos` tied to a session ID. |
| **Direct mutation** | Modifying `ctx.todos` or `ctx.messages` without going through `ConversationState`. Fast but invisible to observers. **Eliminated as of 2026-06-06.** |
| **Observed mutation** | A change routed through `ctx.state.replaceTodos()` etc., which fires `StateChange` events. |
| **Plan** | The strategic counterpart to todos; managed by `/plan` and stored separately. |
| **Single-writer invariant** | At most one todo may have `status === 'in_progress'` at any time. |
