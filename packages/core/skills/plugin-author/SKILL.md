---
name: plugin-author
description: |
  Use this skill when creating, reviewing, or refactoring a WrongStack plugin
  in `packages/plugins/`. Covers the Plugin interface, tool registration, config
  schema, the H1 audit pattern (teardown + health), PluginAPI extension for host
  data, and the entry-point registration steps (tsup, package.json, index.ts).
  Triggers: user says "new plugin", "add a plugin", "plugin teardown", "plugin
  health", "register a tool", "PluginAPI extension".
version: 1.0.0
---

# Plugin Author — WrongStack

## Overview

Guides the creation and maintenance of first-party plugins in
`packages/plugins/`. A plugin is a TypeScript module that implements
the `Plugin` interface from `@wrongstack/core`, registering tools,
hooks, slash commands, or pipelines into the agent's runtime.

There are currently **21 official plugins** in the suite:

| Plugin | Tools | Hooks | Stateful |
|--------|-------|-------|----------|
| `auto-doc` | `auto_doc` | — | ✅ teardown+health |
| `git-autocommit` | `git_autocommit` | — | ✅ teardown+health |
| `shell-check` | `shellcheck` | — | ✅ teardown+health |
| `cost-tracker` | `cost_summary`, `cost_reset`, `cost_export` | — | ✅ teardown+health |
| `file-watcher` | `watch_start`, `watch_stop`, `watch_list` | — | ✅ teardown+health |
| `cron` | `cron_schedule`, `cron_list`, `cron_cancel` | — | ✅ teardown+health |
| `template-engine` | `template_expand`, `template_render`, `template_create`, `template_list` | — | ✅ teardown+health |
| `semver-bump` | `semver_bump`, `semver_current`, `semver_changelog` | — | ✅ teardown+health |
| `secret-scanner` | `secret_scanner_status`, `secret_scanner_test` | `PreToolUse` + `PostToolUse` | ✅ teardown+health |
| `todo-tracker` | `todo_tracker_list/add/complete/drop/remove/pull/status` | — | ✅ teardown+health |
| `token-budget` | `token_budget_status` | `Stop` + `PostToolUse` | ✅ teardown+health |
| `lint-gate` | `lint_gate_status` | `PreToolUse` (`write\|edit`) | ✅ teardown+health |
| `branch-guard` | `branch_guard_status` | `PreToolUse` (`bash\|git_autocommit`) | ✅ teardown+health |
| `diff-summary` | `diff_summary_status` | `PostToolUse` (`write\|edit`) | ✅ teardown+health |
| `commit-validator` | `commit_validator_status` | `PreToolUse` (`bash\|git_autocommit`) | ✅ teardown+health |
| `format-on-save` | `format_on_save_status` | `PostToolUse` (`write\|edit`) | ✅ teardown+health |
| `test-runner-gate` | `test_gate_status` | `PostToolUse` (`write\|edit`) | ✅ teardown+health |
| `import-organizer` | `import_organizer_status` | `PostToolUse` (`write\|edit`) | ✅ teardown+health |
| `todo-listener` | `todo_listener_status` | `PostToolUse` (`todo`) | ✅ teardown+health |
| `session-recap` | `session_recap_status` | `Stop` | ✅ teardown+health |
| `spec-linker` | `spec_linker_status` | `PostToolUse` (`write\|edit`) | ✅ teardown+health |

## Rules

1. **Every plugin must implement `teardown()` and `health()`.** Even
   stateless plugins (shell-check, semver-bump) add both — the teardown
   logs a completion line with per-session counters, and `health()`
   reports `ok: true` + counters for `/diag plugins`. This is the **H1
   audit pattern** (see below).
2. **State at module scope, not in the setup() closure.** The Plugin
   interface does not thread state from `setup()` → `teardown()`. If
   teardown needs to clean up a resource (timer, watcher, counter),
   the reference must live at module scope. State in the setup
   closure is unreachable from teardown and **leaks on reload**.
3. **`setup()` is idempotent.** It must zero/clear state before
   re-initializing. Calling `setup()` twice (e.g. across a hot-reload)
   leaves a clean slate, not accumulated state.
4. **`teardown()` never deletes on-disk state.** File-based plugins
   (todo-tracker) leave the file in place — the user may return. Only
   in-memory counters and resource handles (timers, watchers) are
   cleaned up.
5. **Tool names use `snake_case`.** Plugin-level tools registered via
   `api.tools.register()` must be unique across the suite. The built-in
   tools (`bash`, `write`, `read`, `edit`, `fetch`, `search`, `json`,
   `todo`, `git`, etc.) are always present; don't collide.
6. **`apiVersion` must satisfy `^0.1` (current kernel API = `0.1.10`).**
   Bump only when the PluginAPI surface breaks. Additive changes (new
   optional fields on PluginAPI) do NOT require a bump.
7. **Config goes under `config.extensions['<plugin-name>']`**, not
   `config.plugins`. The loader's `buildPluginOptions` merges both
   surfaces; plugins read from `api.config.extensions`.

## The Plugin interface

```typescript
import type { Plugin } from '@wrongstack/core';

const plugin: Plugin = {
  name: 'my-plugin',
  version: '0.1.0',
  description: 'One-line summary for wstack plugins list',
  apiVersion: '^0.1.10',
  capabilities: { tools: true }, // hints for /diag

  // Optional: JSON Schema for config validation
  defaultConfig: { enabled: true },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true },
    },
  },

  // Called by the host to activate the plugin.
  setup(api) { /* register tools, hooks, events */ },

  // Called by the host during unload. Same api instance as setup.
  teardown(api) { /* clear state, release resources, log */ },

  // Called by /diag plugins. Return ok + message + counters.
  async health() {
    return { ok: true, message: 'healthy', invocationCount: 0 };
  },
};

export default plugin;
```

## H1 audit pattern

After the 2026-06-03 audit found that several plugins leaked resources
on reload (timers, chokidar watchers, in-memory caches unreachable from
teardown), the following lifecycle pattern was formalized. **All 10
plugins follow it.**

### 1. State at module scope

```typescript
// ✅ Module scope — teardown can reach this
const state = {
  invocationCount: 0,
  timers: new Map<string, NodeJS.Timeout>(),
  lastRun: null as null | { when: string; result: string },
};

// ❌ NEVER — setup closure, unreachable from teardown
setup(api) {
  const timers = new Map();  // LEAKS on reload
}
```

### 2. Idempotent setup

```typescript
setup(api) {
  // Clear everything first, then re-init from config.
  state.invocationCount = 0;
  for (const t of state.timers.values()) clearTimeout(t);
  state.timers.clear();
  state.lastRun = null;

  // Now register tools, apply config, subscribe to events.
  api.tools.register({ /* ... */ });
}
```

### 3. Teardown releases resources

```typescript
teardown(api) {
  const count = state.invocationCount;
  state.invocationCount = 0;
  state.lastRun = null;
  // Release every resource that was acquired in setup().
  for (const t of state.timers.values()) clearTimeout(t);
  state.timers.clear();
  api.log.info('my-plugin: teardown complete', { invocations: count });
}
```

### 4. Health reports per-session visibility

```typescript
async health() {
  return {
    ok: true,
    message: state.lastRun === null
      ? 'my-plugin: no calls yet'
      : `my-plugin: last call at ${state.lastRun.when}`,
    invocationCount: state.invocationCount,
    lastRun: state.lastRun,
  };
}
```

## Tool registration

```typescript
api.tools.register({
  name: 'my_tool',
  description: 'What this tool does. Include when to use and what it returns.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
    },
    required: ['path'],
  },
  permission: 'auto',     // 'auto' | 'confirm'
  mutating: false,         // does it change external state?
  category: 'Project',
  async execute(input: Record<string, unknown>) {
    const path = input['path'] as string;
    // ... do the work ...
    return { ok: true, path, result: '...' };
  },
});
```

### Permission levels

| Permission | When |
|------------|------|
| `auto` | Safe operations (read, list, query). No user confirmation. |
| `confirm` | Destructive or side-effecting operations (write, commit, delete). User must approve. |

## Config surface

Two surfaces exist. The loader merges them:

1. **`config.plugins`** — loading control: `[{ name: 'my-plugin', enabled: false }]`
2. **`config.extensions['my-plugin']`** — options: `{ option1: value1 }`

Plugins read from `api.config.extensions`:

```typescript
setup(api) {
  const ext = api.config.extensions?.['my-plugin'] as Record<string, unknown> | undefined;
  const myOption = (ext?.['myOption'] as string) ?? 'default';
}
```

If the plugin declares `configSchema`, the loader validates the
options section before calling `setup` and rejects the plugin with a
clear error on failure.

## Hook registration (PreToolUse, PostToolUse, etc.)

```typescript
// secret-scanner pattern: block tools whose args contain secrets
api.registerHook('PreToolUse', 'bash|write|edit', (input) => {
  const text = JSON.stringify(input.toolInput ?? {});
  if (detectSecret(text)) {
    return {
      decision: 'block',
      reason: 'Plaintext credential detected in tool arguments',
    };
  }
  // Omitted decision = allow (no-op)
});
```

Available events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`,
`SessionStart`, `Stop`.

`HookOutcome` fields:
- `decision: 'block' | 'allow'` — block stops the action
- `reason: string` — surfaced to the model when blocking
- `modifiedInput: Record<string, unknown>` — PreToolUse replacement args
- `additionalContext: string` — extra context folded back to the model

## PluginAPI extension (cross-package host data)

When a plugin needs host data not yet on `PluginAPI` (e.g.
`modelsRegistry`, `projectDir`), extend the surface in three steps:

1. **`packages/core/src/types/plugin.ts`** — add the optional field to `PluginAPI`
2. **`packages/core/src/plugin/api.ts`** — add to `PluginAPIInit` + `DefaultPluginAPI`
3. **`packages/cli/src/wiring/plugins.ts`** — destructure + forward in `setupPlugins`

Precedent: commit `9bed619f` added `modelsRegistry?: ModelsRegistry` for
cost-tracker's pricing hydration.

## Entry-point registration (3 files)

After writing `src/<name>/index.ts`, wire it into three files:

### 1. `src/index.ts` — named re-export

```typescript
export { default as myPluginPlugin } from './my-plugin/index.js';
```

### 2. `tsup.config.ts` — build entry

```typescript
entry: {
  // ...
  'my-plugin': 'src/my-plugin/index.ts',
},
```

### 3. `package.json` — subpath export

```json
"./my-plugin": {
  "types": "./dist/my-plugin.d.ts",
  "import": "./dist/my-plugin.js"
}
```

### 4. `packages/cli/src/wiring/plugins.ts` — built-in factory

```typescript
async () => (await import('@wrongstack/plugins/my-plugin')).default,
```

## Tests

Every plugin gets two test files:

- **`tests/<name>.test.ts`** — unit tests (mock API, tool registration,
  config validation, teardown log line, health() shape)
- **`tests/<name>-exec.test.ts`** — integration tests (real filesystem,
  real CLI tools if applicable)

For the H1 pattern, extend `tests/plugin-teardown.test.ts` with a
`describe('<name>')` block covering:
- `teardown` logs a completion line and does not throw
- `health()` reports ok + non-empty message
- `teardown` zeros counters

## Anti-patterns

- **State in setup closure** — leaks on reload. Always module scope.
- **Missing teardown** — `/diag plugins` shows a gap; reload leaks.
- **Missing health()** — operator can't confirm the plugin is alive.
- **Tool name collision** — `read`, `write`, `bash`, etc. are built-in.
- **Deleting on-disk state in teardown** — the user may return.
- **Blocking setup with async hydration** — use `void (async () => { ... })()`
  for fire-and-forget; let the first call fall through to fallback if
  the async hasn't completed yet.
- **Not lowercasing model/config keys** — case-insensitive lookup is
  the convention; `model.toLowerCase()` everywhere.

## Workflow

1. **Create the plugin directory**: `src/<name>/index.ts`
2. **Write the Plugin object**: name, version, apiVersion, setup, teardown, health
3. **Register tools/hooks** in `setup()`
4. **Add state + teardown + health** following the H1 pattern
5. **Wire into 3 files**: `index.ts`, `tsup.config.ts`, `package.json`
6. **Add to `BUILTIN_PLUGIN_FACTORIES`** in CLI wiring
7. **Write tests**: `<name>.test.ts` (unit) + extend `plugin-teardown.test.ts`
8. **Run verification**: `npx vitest run packages/plugins` + `npx tsc --noEmit` + `npx tsup`
9. **Update `src/index.ts` doc comment** — bump the plugin count

## Skills in scope

- `skill-creator` — for the SKILL.md format and frontmatter rules
- `prompt-engineering` — for crafting tool descriptions and usageHint
- `typescript-strict` — for strict TypeScript patterns in plugin code
- `node-modern` — for ESM imports, AbortSignal, and async patterns
- `testing` — for vitest patterns and mock API construction
- `output-standards` — for standardized `<nextsteps>` formatting
