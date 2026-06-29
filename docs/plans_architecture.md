# Plans System Architecture

> **Scope:** This document describes the `plans` subsystem in WrongStack - the strategic, higher-level planning layer that persists across session resumes, its relationship to the tactical `todos` system, and the roadmap for future enhancements.
>
> **Last updated:** 2026-05-20

---

## 1. Overview

The **plans system** is WrongStack's strategic planning layer. Where `todos` capture moment-to-moment tasks that the LLM mutates per-turn, **plans** capture the overall approach - the steps laid out before any work begins. Plans survive session resume by default, so a resumed session can show "you were on step 3 of 5."

Think of it as:
- **Plans** = Roadmap (strategic, user-managed, persistent)
- **Todos** = Sprint board (tactical, LLM-managed, per-turn)

Both can coexist: a user sets up a high-level plan with `/plan`, then the LLM breaks the current plan step into concrete todos.

---

## 2. Data Model

### 2.1 `PlanItem`

```ts
// packages/core/src/storage/plan-store.ts
export interface PlanItem {
  id: string;                          // opaque, auto-generated
  title: string;                       // short description
  details?: string;                    // optional longer-form context
  status: 'open' | 'in_progress' | 'done';
  createdAt: string;                   // ISO-8601
  updatedAt: string;                   // ISO-8601
}
```

### 2.2 `PlanFile`

```ts
export interface PlanFile {
  version: 1;
  sessionId: string;
  title?: string;                      // optional plan title (e.g. "v1.0 Release")
  updatedAt: string;
  items: PlanItem[];
}
```

### 2.3 Invariants

| Invariant | Enforcer | Notes |
|-----------|----------|-------|
| `version === 1` | `loadPlan` | Future migrations bump this |
| `status` in enum | TypeScript + runtime | No invalid statuses persisted |
| `id` uniqueness | `addPlanItem` | IDs are `plan_${timestamp}_${uuid6}` |
| Immutable updates | All mutators return new `PlanFile` | No in-place mutation of loaded plans |

---

## 3. Storage Layer (`plan-store.ts`)

### 3.1 File format

- The `/plan` slash command is registered by `wstack-plan` and stores the
  project-level plan at `~/.wrongstack/projects/<hash>/plan.json`
  (`WstackPaths.projectPlan`).
- The LLM-callable `plan` tool uses `ctx.meta['plan.path']`, which CLI session
  setup seeds as `~/.wrongstack/projects/<hash>/sessions/<date>/sess_<ULID>.plan.json`.
  This keeps tool-driven planning scoped to the active session while the slash
  command remains a project-level board.
- Atomic write via `atomicWrite` with `0o600` permissions
- JSON, human-readable, versioned

### 3.2 Lifecycle

```
Project start
|
+-- path wiring creates `paths.projectPlan`
|
+-- built-in `wstack-plan` plugin registers `/plan`
|   `-- command loads the project plan on demand
|
+-- CLI session setup seeds `ctx.meta['plan.path']`
|   `-- the `plan` tool loads the session plan on demand
|
+-- new path -------> no file yet, empty plan on first access
|
`--> Every mutation (add/start/done/remove/promote/derive/template/clear) -> atomic save
```

### 3.3 Error posture

- **Read failure** (missing / corrupt file) -> returns `null`, treated as "no prior plan"
- **Write failure** -> logged to `console.warn`, does **not** throw

---

## 4. Tool: `plan`

### 4.1 Schema

```ts
// packages/tools/src/plan.ts
interface PlanInput {
  action: 'show' | 'add' | 'start' | 'done' | 'remove' | 'clear';
  title?: string;          // required for add
  details?: string;        // optional for add
  target?: string;         // required for start/done/remove (id | index | substring)
}

interface PlanOutput {
  ok: boolean;
  message: string;
  plan: string;            // formatted plan text
  count: number;           // total items
  open: number;            // items not in 'done' status
}
```

### 4.2 Actions

| Action | Required fields | Effect |
|--------|----------------|--------|
| `show` | - | Returns formatted plan, no mutation |
| `add` | `title` | Appends new `open` item, persists |
| `start` | `target` | Sets matched item to `in_progress`, persists |
| `done` | `target` | Sets matched item to `done`, persists |
| `remove` | `target` | Removes matched item, persists |
| `clear` | - | Empties all items, persists |

### 4.3 Target matching

`start`/`done`/`remove` accept three forms of target:
1. **1-based index** - `"3"` matches the 3rd item
2. **Exact ID** - `"plan_123456_abc123"`
3. **Substring fuzzy** - `"auth"` matches first item with "auth" in title

Matching priority: index -> exact ID -> substring.

---

## 5. Slash Command: `/plan`

```
/plan                    -> show formatted plan
/plan show               -> same
/plan add <title>        -> append new item
/plan start <id|#>       -> mark item in_progress
/plan done <id|#>        -> mark item done
/plan remove <id|#>      -> delete item
/plan promote <id|#>     -> convert a plan item into todos
/plan derive <id|#>      -> derive todos from a plan item
/plan template list      -> list built-in plan templates
/plan template use <name> -> append a template's items
/plan clear              -> wipe all items
```

- Implemented by the built-in `wstack-plan` plugin in `packages/core/src/plugins/plan-plugin.ts`
- Reads/writes the same `PlanFile` shape as `planTool`
- `planPath` comes from `WstackPaths.projectPlan`

---

## 6. Rendering

### 6.1 Text formatter (`formatPlan`)

```
# Migration roadmap
1. [ ] Audit database schema
2. [~] Write migration scripts
     idempotent + reversible
3. [x] Set up CI pipeline
```

- Source: `packages/core/src/storage/plan-store.ts`
- `details` field is indented under its parent item

---

## 7. Relationship to `/todos`

| Aspect | `/plan` (plans) | `/todos` (todos) |
|--------|----------------|------------------|
| **Granularity** | Strategic roadmap | Tactical task board |
| **Managed by** | User (slash) + LLM (tool) | LLM (tool) primarily |
| **Persistence** | Per-session JSON file | Per-session JSON checkpoint |
| **Lifespan** | Survives resume | Survives resume |
| **Typical use** | "Refactor auth -> Add OAuth -> Audit" | "Build -> Test -> Deploy" |
| **Mutability** | Add/remove/done via discrete actions | Full replacement per tool call |

### 7.1 Coexistence pattern

```
User: /plan add "Refactor authentication layer"
User: /plan add "Add OAuth2 support"
User: /plan add "Security audit"

LLM: planTool(action: 'start', target: '1')  -> step 1 active
LLM: todoTool(todos: [
  {id: '1', content: 'Extract JWT logic', status: 'in_progress'},
  {id: '2', content: 'Write unit tests', status: 'pending'},
])

... work happens ...

LLM: planTool(action: 'done', target: '1')   -> step 1 complete
LLM: planTool(action: 'start', target: '2')  -> step 2 active
```

---

## 8. Feature Plan

### 8.1 Short-term (next 1-2 releases)

| # | Feature | Motivation | Files touched |
|---|---------|------------|---------------|
| 1 | **Plan title editing** | `/plan title <text>` to set the plan title. Currently `PlanFile.title` exists in schema but has no CLI surface. | `packages/core/src/plugins/plan-plugin.ts` |
| 2 | **Plan item reordering** | `/plan move <from> <to>` to reorder items. Currently items are append-only. | `packages/core/src/storage/plan-store.ts`, `packages/core/src/plugins/plan-plugin.ts` |
| 3 | **Tool support for templates and derivation** | The slash command supports `promote`, `derive`, and `template`; the `planTool` action schema is still limited to show/add/start/done/remove/clear. | `packages/tools/src/plan.ts`, `packages/core/src/storage/plan-store.ts` |
| 4 | **Best-match fuzzy targeting** | Improve substring matching so `"auth"` prefers exact or prefix matches over the first arbitrary substring. | `packages/core/src/storage/plan-store.ts` |

### 8.2 Medium-term (next 3-6 releases)

| # | Feature | Motivation | Files touched |
|---|---------|------------|---------------|
| 5 | **Hierarchical plans (sub-items)** | Plan items with nested children. Enables complex roadmaps without flattening. | `packages/core/src/storage/plan-store.ts`, future plan formatting helper |
| 6 | **Priority and tags** | `priority: 'low'|'medium'|'high'|'critical'` and `tags: string[]` on `PlanItem`. Enables filtering and sorting. | `packages/core/src/storage/plan-store.ts`, `packages/core/src/plugins/plan-plugin.ts` |
| 7 | **Plan history / undo** | Rolling log of plan mutations. `/plan undo` reverts last change. | `packages/core/src/storage/plan-store.ts` |
| 8 | **Cross-session named plans** | `/plan save <name>` and `/plan load <name>` to persist plans beyond a single session. Storage: `.wrongstack/plans/<name>.json`. | `packages/core/src/storage/plan-store.ts`, `packages/core/src/plugins/plan-plugin.ts` |
| 9 | **WebUI plan panel** | Sidebar panel showing live plan, editable via drag-drop, with progress bar. | `packages/webui/src/components/` |

### 8.3 Long-term / exploratory

| # | Feature | Motivation |
|---|---------|------------|
| 10 | **Milestone and timeline** | Add `dueAt` to plan items, milestone grouping, and overdue warnings. |
| 11 | **LLM-aware auto-progression** | Inject the active plan into the system prompt. When the LLM finishes a step, automatically mark the next one as `in_progress`. |
| 12 | **Fleet plan delegation** | Let the Director agent split a plan across subagents. Each subagent sees its own plan slice. `/plan delegate <id> to <agent>`. |
| 13 | **Plan dependency graph** | Use `blockedBy: string[]` to model dependencies between plan items. Include critical-path analysis. |

---

## 9. Fix Plan

### 9.1 Known bugs / gaps

| ID | Issue | Severity | Fix | ETA |
|----|-------|----------|-----|-----|
| F-1 | `planTool` declares `mutating: false` but it writes to disk. Same metadata issue as `todoTool`. | **Low** | Change to `mutating: true` or document the no-external-side-effects rationale. | Short-term |
| F-2 | `attachPlanCheckpoint` is a stub - plans don't subscribe to `ConversationState` changes. If a plan path is stored in `ctx.meta`, mutations don't auto-persist (though direct tool/slash calls do save). | **Low** | Either implement the checkpoint listener or remove the stub and document the direct-save pattern. | Short-term |
| F-3 | No fuzzy search ranking in `matchIndex`. `"auth"` matches first item containing "auth", not the best match. | **Low** | Add simple scoring (exact > prefix > substring) or expose multiple matches to user. | Short-term |
| F-4 | `PlanFile.title` exists in schema but has no CLI or tool surface. | **Low** | Add `/plan title <text>` and `planTool(action: 'title')`. | Short-term |

### 9.2 Refactoring candidates

| ID | Idea | Risk | Reward |
|----|------|------|--------|
| R-1 | **Merge plan and todo stores** | High - different lifecycles, different consumers | Simpler persistence layer, single rehydration path |
| R-2 | **Extract `PlanItem` schema validation** | Low | Enable Zod/jsonschema validation for plan items |
| R-3 | **Plan as Context state** | Medium | Plans would get `ConversationState` observability (events, checkpointing) for free |
| R-4 | **Plan registry / plugin hooks** | Medium | Plugins could register plan formatters, validators, template providers |

---

## 10. File Index

| File | Role |
|------|------|
| `packages/core/src/storage/plan-store.ts` | Core data model, CRUD operations, save/load, formatting |
| `packages/tools/src/plan.ts` | `planTool` - LLM-callable plan management |
| `packages/core/src/plugins/plan-plugin.ts` | Built-in `/plan` slash command implementation |
| `packages/core/src/storage/plan-templates.ts` | Built-in template catalog for `/plan template` |
| `packages/core/src/utils/wstack-paths.ts` | Path setup: provides `projectPlan` |
| `packages/core/tests/storage/plan-store.test.ts` | Plan store round-trip, CRUD, formatting tests |
| `packages/tools/tests/plan.test.ts` | Plan tool execution, persistence, error paths |
| `packages/core/tests/plugins/plan-plugin.test.ts` | `/plan` plugin command behavior |
| `packages/core/src/defaults/index.ts` | Re-exports plan-store API for consumers |
| `packages/core/src/storage/index.ts` | Barrel export for plan-store |

---

## 11. Glossary

| Term | Definition |
|------|------------|
| **Plan** | A session-scoped strategic roadmap consisting of ordered `PlanItem`s. |
| **PlanItem** | A single step in a plan with title, optional details, and status. |
| **Target matching** | The index/ID/substring resolution used by `start`/`done`/`remove` operations. |
| **Todo** | The tactical, per-turn task board managed by the LLM via `todoTool`. |
| **Template** | A pre-defined plan skeleton that can be instantiated with one command. |
