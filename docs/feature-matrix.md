# Plugin Feature Matrix

A bird's-eye view of every first-party plugin in
[`@wrongstack/plugins`](../packages/plugins/README.md). The catalog
below groups plugins by what they do, so you can spot overlaps and
pick the right one for a job without scrolling through 31 entries.

> **Living document** — last updated when the 31st plugin
> (`injection-shield`) was added. When you add a plugin, update this
> file in the same commit so it never drifts from
> `packages/plugins/README.md` and `packages/plugins/src/catalog.ts`.

## At a glance

| # | Plugin | Category | Hooks | Tools |
|---|--------|----------|-------|-------|
| 1  | [`auto-doc`](../packages/plugins/src/auto-doc)         | developer workflow | — | `auto_doc` |
| 2  | [`git-autocommit`](../packages/plugins/src/git-autocommit) | developer workflow | — | `git_autocommit` |
| 3  | [`shell-check`](../packages/plugins/src/shell-check)   | quality | — | `shellcheck` |
| 4  | [`cost-tracker`](../packages/plugins/src/cost-tracker)   | observability | — | `cost_summary`, `cost_reset`, `cost_export` |
| 5  | [`file-watcher`](../packages/plugins/src/file-watcher)   | utilities | — | `watch_start`, `watch_stop`, `watch_list` |
| 6  | [`cron`](../packages/plugins/src/cron)                   | utilities | — | `cron_schedule`, `cron_list`, `cron_cancel` |
| 7  | [`template-engine`](../packages/plugins/src/template-engine) | utilities | — | `template_expand`, `template_render`, `template_create`, `template_list` |
| 8  | [`semver-bump`](../packages/plugins/src/semver-bump)     | developer workflow | — | `semver_bump`, `semver_current`, `semver_changelog` |
| 9  | [`secret-scanner`](../packages/plugins/src/secret-scanner) | safety | `PreToolUse` (`bash\|write\|edit`) + `PostToolUse` (`*`) | `secret_scanner_status`, `secret_scanner_test` |
| 10 | [`todo-tracker`](../packages/plugins/src/todo-tracker)   | utilities | — | `todo_tracker_list/add/complete/drop/remove/pull/status` |
| 11 | [`token-budget`](../packages/plugins/src/token-budget)   | observability | `Stop` + `PostToolUse` (`*`) | `token_budget_status` |
| 12 | [`lint-gate`](../packages/plugins/src/lint-gate)         | quality | `PreToolUse` (`write\|edit`) | `lint_gate_status` |
| 13 | [`branch-guard`](../packages/plugins/src/branch-guard)   | safety | `PreToolUse` (`bash\|git_autocommit`) | `branch_guard_status` |
| 14 | [`diff-summary`](../packages/plugins/src/diff-summary)   | observability | `PostToolUse` (`write\|edit`) | `diff_summary_status` |
| 15 | [`commit-validator`](../packages/plugins/src/commit-validator) | quality | `PreToolUse` (`bash\|git_autocommit`) | `commit_validator_status` |
| 16 | [`format-on-save`](../packages/plugins/src/format-on-save) | quality | `PostToolUse` (`write\|edit`) | `format_on_save_status` |
| 17 | [`test-runner-gate`](../packages/plugins/src/test-runner-gate) | quality | `PostToolUse` (`write\|edit`) | `test_gate_status` |
| 18 | [`import-organizer`](../packages/plugins/src/import-organizer) | quality | `PostToolUse` (`write\|edit`) | `import_organizer_status` |
| 19 | [`todo-listener`](../packages/plugins/src/todo-listener) | cross-agent | `PostToolUse` (`todo`) | `todo_listener_status` |
| 20 | [`session-recap`](../packages/plugins/src/session-recap)   | cross-agent | `Stop` | `session_recap_status` |
| 21 | [`spec-linker`](../packages/plugins/src/spec-linker)     | quality | `PostToolUse` (`write\|edit`) | `spec_linker_status` |
| 22 | [`loop-breaker`](../packages/plugins/src/loop-breaker)   | safety | `PreToolUse` (`*`) | `loop_breaker_status` |
| 23 | [`path-guard`](../packages/plugins/src/path-guard)     | safety | `PreToolUse` (`write\|edit\|bash`) | `path_guard_status` |
| 24 | [`context-pins`](../packages/plugins/src/context-pins)  | utilities | — | `pin_add`, `pin_remove`, `pin_list` |
| 25 | [`checkpoint`](../packages/plugins/src/checkpoint)     | utilities | — | `checkpoint_create`, `checkpoint_restore`, `checkpoint_list` |
| 26 | [`error-lens`](../packages/plugins/src/error-lens)      | observability | `PostToolUse` (`bash\|exec`) | `error_lens_status` |
| 27 | [`dep-guard`](../packages/plugins/src/dep-guard)        | safety | `PreToolUse` (`install`) | `dep_guard_status` |
| 28 | [`config-validator`](../packages/plugins/src/config-validator) | quality | `PostToolUse` (`write\|edit`) | `config_validator_status` |
| 29 | [`notify-hub`](../packages/plugins/src/notify-hub)      | observability | `Stop` + `PostToolUse` (`*`) | `notify_hub_status`, `notify_send` |
| 30 | [`changelog-writer`](../packages/plugins/src/changelog-writer) | developer workflow | — | `changelog_add`, `changelog_preview`, `changelog_write` |
| 31 | [`injection-shield`](../packages/plugins/src/injection-shield) | safety | `PostToolUse` (`*`) | `injection_shield_status` |

---

## By category

### Developer workflow

Plugins that produce git/PR/commit artifacts from agent activity.

| Plugin | What it does | Mutating? | Output |
|--------|--------------|-----------|--------|
| `auto-doc` | Generates JSDoc/TSDoc from source | yes (when not `dry_run: true`) | Direct file write |
| `git-autocommit` | AI-written conventional commits | yes (creates a real commit) | `git commit` + optional tag |
| `semver-bump` | Conventional-commit → semver bump | yes (when not `dryRun`) | `package.json` + git tag |
| `changelog-writer` | Keep-a-Changelog entries under `[Unreleased]` from session work | yes (on `changelog_write`) | `CHANGELOG.md` mutations |

**Recommended chain** for a release:
`git-autocommit` → `commit-validator` (gate) → `semver-bump` → `branch-guard`
(aborts if on `main`/`master`).

### Quality

Plugins that keep the working tree clean and the code honest. Most
fire on `write|edit` either *before* (block / warn) or *after*
(auto-fix) the file lands.

| Plugin | When it runs | What it does | Modes |
|--------|--------------|--------------|-------|
| `shell-check` | on demand | `shellcheck` over files OR directories | — |
| `lint-gate` | `PreToolUse` `write\|edit` | biome / eslint on would-be content | `block` / `warn` / `fix` |
| `format-on-save` | `PostToolUse` `write\|edit` | `biome format --write` on disk | — |
| `import-organizer` | `PostToolUse` `write\|edit` | `biome check --write --unsafe` (sort, group, remove unused) | — |
| `commit-validator` | `PreToolUse` `bash\|git_autocommit` | conventional-commit format gate | `block` / `warn` |
| `test-runner-gate` | `PostToolUse` `write\|edit` | runs the matching test file | `block` / `injectOnPass` |
| `spec-linker` | `PostToolUse` `write\|edit` + `PreToolUse` `write` (when `autoFix: true`) | surfaces unlinked plugin references in markdown files (read-only by default; opt-in auto-link via PreToolUse) | `enabled` / `fileGlobs` / `maxReferences` / `autoFix` |
| `config-validator` | `PostToolUse` `write\|edit` | validates JSON/JSONC/YAML/TOML files in the same turn; reports syntax problems | `enabled` / `fileGlobs` |

**Stacking** the quality chain on `write|edit`:
`lint-gate` (PreToolUse, block) → `test-runner-gate` (PostToolUse) →
`format-on-save` (PostToolUse) → `import-organizer` (PostToolUse) →
`spec-linker` (PostToolUse, read-only — only injects context).
This pre-validates → runs tests → auto-fixes formatting → re-sorts
imports → nudges doc links, in that order.

### Safety

Plugins that stop destructive operations from happening by accident.

| Plugin | What it blocks | Default policy |
|--------|----------------|-----------------|
| `secret-scanner` | Plaintext credentials in `bash` / `write` / `edit` input, and credentials leaking in tool *output* | `block` (input) / `warn` (output) |
| `branch-guard` | Commits, pushes, and merges on protected branches (default: `main`, `master`) | `block` |
| `path-guard` | Writes/edits/destructive shell on protected paths (lockfiles, `.env`, `.git`, migrations) | `block` |
| `loop-breaker` | Runaway tool-call loops — identical repeats *and* A-B-A-B oscillation; warns then blocks | `warn` → `block` after threshold |
| `dep-guard` | Risky `install` calls: deny list, typosquat lookalike warnings, unpinned version warnings | `warn` |
| `injection-shield` | Prompt-injection patterns in tool *output* (warns the model that content is data, not instructions) | `warn` |

Both are first-line defenses — they should run *before* the agent's
own judgment kicks in. Pair `secret-scanner` with the prompt-level
reminder to never paste real secrets.

### Observability

Plugins that surface session activity to humans or other systems.

| Plugin | When | What it surfaces |
|--------|------|------------------|
| `cost-tracker` | on every `provider.response` | Per-model token + USD cost (configurable pricing via `pricingOverrides` or `api.modelsRegistry`) |
| `token-budget` | every tool, plus `Stop` | Per-session token usage; warns at `warnPercent` (default 80%), stops the agent loop at `stopPercent` (default 100%) |
| `diff-summary` | after every `write\|edit` | Compact `git diff` injected into the LLM's context |
| `error-lens` | `PostToolUse` `bash\|exec` | Distills failed command output to error line + project stack frames; flags repeated failures |
| `notify-hub` | `Stop` + `PostToolUse` (`*`) | POSTs session events (stop, tool errors, budget thresholds) and ad-hoc `notify_send` messages to a configurable webhook |

`cost-tracker` and `token-budget` are complementary: the former
tracks *spend* (with pricing), the latter enforces a *budget*
(rate-limited). Running both gives you full cost control.

### Cross-agent

Plugins that publish to the project mailbox
([`GlobalMailbox`](../packages/core/src/coordination/global-mailbox.ts))
so other agents in the same project (terminals, WebUIs, shadow
agents) can see what this one is doing.

| Plugin | When it publishes | What it sends |
|--------|-------------------|----------------|
| `todo-listener` | every `todo` tool call | Compact todo-list snapshot (id, content, status) |
| `session-recap` | on `Stop` | One-page session summary (tokens, tool calls, commits, last activity, transcript tail) |

Both require `api.mailbox` to be populated (added to `PluginAPI`
in commit `31dde5ba`). On minimal hosts without a mailbox, they
log a one-shot warn and silently no-op.

### Utilities

Plugins that don't fit a specific quality / safety / observability
slot — they provide general-purpose tools.

| Plugin | Use case |
|--------|----------|
| `file-watcher` | Watch a path; emit `change/add/delete` events (feeds the `dep-watcher` bridge) |
| `cron` | In-session recurring tasks |
| `template-engine` | Handlebars-style `{{var}}` / `{{#if}}` / `{{#each}}` text expansion |
| `todo-tracker` | Persistent, project-scoped todo backlog (survives across sessions) |
| `context-pins` | Pinned facts that survive compaction and persist across sessions; exposed via `pin_add` / `pin_remove` / `pin_list` |
| `checkpoint` | In-session file snapshots — auto-captures content before `write`/`edit`; `checkpoint_restore` rolls back |

---

## By hook trigger

This is the matrix that matters for performance. Each hook fires on
every matching event; stacking too many on the same matcher creates
noticeable per-tool overhead.

### `PreToolUse` (blocks / rewrites before the tool runs)

| Matcher | Plugin | Behavior |
|---------|--------|----------|
| `bash\|write\|edit` | `secret-scanner` | Blocks or redacts credentials in tool input |
| `write\|edit` | `lint-gate` | Blocks or warns on lint issues; optionally auto-fixes |
| `bash\|git_autocommit` | `branch-guard` | Blocks commits/pushes/merges to protected branches |
| `bash\|git_autocommit` | `commit-validator` | Blocks on invalid conventional-commit format |
| `write\|edit\|bash` | `path-guard` | Blocks touches on protected paths (lockfiles, `.env`, `.git`, migrations) |
| `install` | `dep-guard` | Warns on deny list / typosquat / unpinned install calls |
| `*` | `loop-breaker` | Detects identical-repeat and A-B-A-B oscillation loops; warns then blocks after threshold |
| `todo` | `todo-listener` | (technically PostToolUse; tracks todo changes) |

### `PostToolUse` (auto-fix / inject context after the tool runs)

| Matcher | Plugin | Behavior |
|---------|--------|----------|
| `bash\|write\|edit` | `secret-scanner` | Warns if tool output contains credentials |
| `*` | `token-budget` | One-shot LLM context injection when budget thresholds are crossed |
| `*` | `injection-shield` | Warns the model when tool output contains prompt-injection patterns (content is data, not instructions) |
| `*` | `notify-hub` | Optional webhook forward on tool errors / budget thresholds |
| `write\|edit` | `diff-summary` | Injects compact git diff into context |
| `write\|edit` | `format-on-save` | `biome format --write` on the file |
| `write\|edit` | `import-organizer` | `biome check --write --unsafe` (sort, group, remove unused) |
| `write\|edit` | `test-runner-gate` | Runs the relevant test file |
| `write\|edit` | `spec-linker` | Surfaces unlinked plugin references in markdown files |
| `write\|edit` | `config-validator` | Validates JSON/JSONC/YAML/TOML files in the same turn |
| `bash\|exec` | `error-lens` | Distills failed command output to error line + project stack frames |
| `todo` | `todo-listener` | Broadcasts the new list to the mailbox |

### `Stop` (fires when the agent loop ends)

| Plugin | Behavior |
|--------|----------|
| `token-budget` | Final budget check; blocks if already over |
| `session-recap` | Posts the one-page session summary to the mailbox |
| `notify-hub` | POSTs `stop` (and `tool.error` / budget) events to the configured webhook |

### No hook (tool-only)

| Plugin |
|--------|
| `auto-doc`, `git-autocommit`, `shell-check`, `cost-tracker`, `file-watcher`, `cron`, `template-engine`, `semver-bump`, `todo-tracker`, `context-pins`, `checkpoint`, `changelog-writer` |

---

## Statefulness — the H1 audit pattern

Following the [H1 audit pattern](../packages/plugins/README.md#h1-audit-pattern)
formalized in 2026-06-03, every plugin with module-scope state
exposes `teardown()` to release resources and `health()` to surface
state. Stateless plugins still ship these as no-ops for API
consistency.

| Plugin | Stateful? | Counter surface |
|--------|-----------|-----------------|
| `cron` | yes | scheduled jobs, active timers |
| `file-watcher` | yes | active watches, last event timestamp |
| `template-engine` | yes | saved-template store |
| `git-autocommit` | yes | commit count, last commit hash/timestamp |
| `cost-tracker` | yes | per-model token totals, last cost |
| `secret-scanner` | yes | block/redact/allow counters, last detection |
| `todo-tracker` | yes | persistent disk-backed backlog |
| `auto-doc` | yes (counts only) | invocation count, last invocation |
| `shell-check` | yes (counts only) | invocation count, issues, last run |
| `semver-bump` | yes (counts only) | per-tool invocations, last bump |
| `token-budget` | yes | invocation count, last warning/stop state |
| `lint-gate` | yes | invocation count, fixes, blocks |
| `branch-guard` | yes | block count, last block |
| `diff-summary` | yes | invocations, last diff size |
| `commit-validator` | yes | invocations, blocks, last reason |
| `format-on-save` | yes | invocations, fixes |
| `test-runner-gate` | yes | invocations, runs, failures, last test |
| `import-organizer` | yes | invocations, organized/clean/error counts |
| `todo-listener` | yes | invocations, sent/skipped/errors |
| `session-recap` | yes | stop invocations, recaps published/errored |
| `spec-linker` | yes | invocations, unlinked, clean, skipped (non-md) |
| `loop-breaker` | yes | repeat streak, oscillation, last warning/block |
| `path-guard` | yes | block count, last block path/reason |
| `context-pins` | yes | pin count, last pin id/timestamp |
| `checkpoint` | yes | snapshot count, last restore id |
| `error-lens` | yes | invocations, digests produced, repeated-failure flags |
| `dep-guard` | yes | block/warn counts, last reason |
| `config-validator` | yes | invocations, error counts, last file |
| `notify-hub` | yes | delivered/failed/dropped counts, last delivery |
| `changelog-writer` | yes | entries added, last write id |
| `injection-shield` | yes | scan count, hits, last detection |

**All 31 plugins follow the H1 pattern** — every `setup()` re-zeros
state, every `teardown()` releases it, and every `health()` reports
it. `/diag plugins` therefore gives a uniform view.

---

## Removed plugins (use built-in tools instead)

| Removed | Replacement | Why |
|---------|-------------|-----|
| `web-search` (removed in `e03e39d1`) | Built-in `search` + `fetch` tools in `@wrongstack/tools` | The built-in tools have native caching, dedup, ranking, DNS-pinned SSRF protection, TurndownService markdown, binary-content rejection, and structured errors. |
| `json-path` (removed in `e03e39d1`) | Built-in `json` tool in `@wrongstack/tools` (action: `query` \| `validate` \| `transform` \| `merge`) | The built-in `json` tool already supports JMESPath queries, schema validation, transforms, and deep-merge via a single `action` parameter. |

If a user lists either name in `config.plugins`, the loader emits
a one-shot `log.warn` and skips loading. See
[`DEPRECATED_PLUGIN_NAMES`](../packages/cli/src/wiring/plugins.ts)
in `packages/cli/src/wiring/plugins.ts` for the canonical list and
migration hints.

---

## Cross-references

- [`packages/plugins/README.md`](../packages/plugins/README.md) — per-plugin quick reference with full config examples
- [`docs/plugin-author-guide.md`](plugin-author-guide.md) — how to write a plugin (the `Plugin` interface, the entry-point registration dance, the H1 pattern)
- [`packages/core/skills/plugin-author/SKILL.md`](../packages/core/skills/plugin-author/SKILL.md) — bundled skill that walks through adding a new plugin
- [`docs/hooks.md`](hooks.md) — how the hook runner works; what `PreToolUse` / `PostToolUse` / `Stop` mean in the core event bus
- [`docs/configuration.md`](configuration.md) — `config.extensions[<name>]` per-plugin config surface
- [`packages/core/src/coordination/global-mailbox.ts`](../packages/core/src/coordination/global-mailbox.ts) — what `api.mailbox` actually is, and how mailbox subscribers read it
