# Lifecycle Hooks

Hooks let third-party code (plugins, skills, operator-authored scripts) **observe
and steer** the agent at well-defined lifecycle points — block a tool call,
rewrite its arguments, inject context, or run side effects.

Unlike the `EventBus` (which is observe-only and cannot change what happens),
hooks are **interceptors**: a hook can short-circuit an action, mutate its
inputs, or append context that the model sees. This is the system that lets an
operator say "if X happens, you step in" — without recompiling the host.

## Three execution models

| Model | Who registers | Transport | Use case |
|---|---|---|---|
| **Command hooks** | Operator, via `config.hooks` | Subprocess: `HookInput` JSON → stdin, outcome JSON → stdout | Glue scripts, lint/format/notify pipelines |
| **HTTP hooks** | Operator, via `config.hooks` | JSON HTTP POST/response | Local or remote policy services; HTTPS required except loopback |
| **In-process hooks** | Plugins, via `api.registerHook` | Awaited function call | Type-safe, low-latency, receives deadline + `AbortSignal` |

All models share the **same** payload (`HookInput`) and outcome
contract (`HookOutcome`), and all are driven by a single `HookRunner` per
session. The runner reads from one shared `HookRegistry`, so a tool call can be
shaped by a mix of shell and in-process hooks in the same turn.

Disable ordinary hook automation for a session with `--no-hooks`. Trusted
configured hooks marked `policy: true` remain active; this prevents a session
flag from removing a security boundary. Command/HTTP hooks are independently
gated by the runner's `allowNonPolicy` flag, except policy
hooks.

---

## Events

These are the lifecycle points a hook can attach to:

| Event | When it fires | Can block? | Can mutate / inject |
|---|---|---|---|
| `PreToolUse` | Before a tool runs, **before** the permission check | ✅ (tool never runs) | rewrite input via `action: "mutate"` |
| `PostToolUse` | After a tool returns | — | append `additionalContext` to the result |
| `UserPromptSubmit` | Before a user turn is processed | ✅ (turn ends, no model call) | append `additionalContext` to the user message |
| `SessionStart` | Once, on the first turn of the session | — | append `additionalContext` to the system prompt (persists for the session) |
| `Stop` | At the end of every turn | — | side effects only |
| `Notification` | The run is waiting on the user: a permission prompt or a structured question | — | side effects only |
| `SubagentStart` | A delegated subagent starts | — | side effects only |
| `SubagentStop` | A delegated subagent settles (success, timeout, error, …) | — | side effects only |
| `PreCompact` | Before every compaction pass (awaited) | — | side effects only |
| `PostCompact` | After every compaction pass (awaited) | — | side effects only |
| `SessionEnd` | The session closes; the close waits for the hook to finish | — | side effects only |

The last six are **observational**: they fire with a typed payload, but their
outcome is ignored — they cannot block, rewrite, or add context, and a failing
hook is logged and skipped whatever its `failurePolicy`. `PreCompact` and
`PostCompact` run around *every* compaction path (automatic, `/compact`, a UI
button, context-overflow recovery, the `context_manager` tool), so they delay a
pass by at most their deadline. The bus-driven ones (`Notification`,
`Subagent*`) run detached and never slow the run down. The names follow the
Claude Code hook vocabulary. A `config.hooks` key that is not one of these
events is dropped at config load with a warning naming it.

### Trigger ordering within an event

All hooks for a given event fire in **registration order**. There are three
distinct fire patterns, one per category of outcome:

1. **PreToolUse two-stage chain** — hooks registered with `stage: "mutate"`
   run sequentially first and compose argument changes. Hooks registered with
   `stage: "validate"` then inspect the same final argument object. Validators
   cannot mutate. Any explicit deny short-circuits execution.

2. **Mutation chain** (`PreToolUse` only, `action: "mutate"`) — within the
   sequential chain, each hook sees the **output of the previous hook** as its
   `toolInput`. Mutations compose left-to-right. The final composed input is
   re-validated against the tool's JSON Schema before the tool runs.

3. **Fan-out collection** (`PostToolUse`, `SessionStart`, `Stop`) — hooks run
   in **parallel** (`Promise.allSettled`) because none mutate state or block.
   Each hook independently returns `additionalContext`; the runner joins all
   returned contexts with `\n` and passes the concatenation back to the caller.
   Order in the joined string is **not** guaranteed (parallel resolution).

Registration order for **in-process** hooks is the order `api.registerHook` was
called during `setup()`. Registration order for **shell** hooks is the order
they appear in the per-event array under `config.hooks`. When both exist for an
event, in-process and shell entries interleave by insertion time — the loader
walks the shared `entries` array in array order.

### PreToolUse runs before the permission policy

This is deliberate: a hook can veto a tool that the trust file would otherwise
auto-allow, and a hook can rewrite arguments so a borderline call lands safely
inside what the trust file already permits. The permission policy runs **only**
on the post-hook (possibly rewritten) input.

---

## Registration

### Configured command/HTTP hooks (operator, via config)

Declared under `config.hooks`, a `Partial<Record<HookEvent, ConfiguredHook[]>>`.
Loaded once at boot by `HookRegistry.loadShellHooks(config.hooks)`.

```jsonc
// config.json
{
  "hooks": {
    "PreToolUse": [
      {
        "name": "bash-safety",
        "matcher": "bash",
        "stage": "validate",
        "command": "bash ./scripts/guard-bash.sh",
        "timeoutMs": 3000,
        "failurePolicy": "closed",
        "policy": true
      },
      { "matcher": "edit|write", "command": "bash ./scripts/audit-edit.sh" }
    ],
    "SessionStart": [
      { "command": "bash ./scripts/on-start.sh" }
    ],
    "Stop": [
      { "command": "bash ./scripts/on-stop.sh" }
    ]
  }
}
```

HTTP hooks use the same controls plus `"type": "http"`, `"url"`, and
optional `"headers"`. Non-loopback cleartext HTTP is rejected. `policy: true`
marks trusted enforcement that remains active under `--no-hooks`.

Configured command/HTTP hooks are owned by the **runtime** (no plugin name), so
they survive plugin install/uninstall cycles. Config changes atomically replace
the configured transport entries while leaving plugin-owned hooks intact.

### In-process hooks (plugins)

Registered through `PluginAPI.registerHook`. Returns an unsubscribe function;
the host also records the registration under the plugin's name so it can be
bulk-removed on teardown.

```ts
import type { PluginAPI } from '@wrongstack/core/plugin';

export default {
  name: 'lint-after-edit',
  capabilities: { hooks: true },          // declare intent (see Capability gating)
  setup(api: PluginAPI) {
    const off = api.registerHook('PostToolUse', 'edit|write', async (input, runtime) => {
      runtime.signal.throwIfAborted();
      const lint = await runLint(input.toolInput);
      return lint ? { additionalContext: `Lint:\n${lint}` } : {};
    }, { name: 'lint-after-edit', timeoutMs: 5000, failurePolicy: 'open' });
    // `off` is called automatically when the plugin is uninstalled.
    // You usually don't need to call it yourself.
  },
};
```

A plugin may register **multiple** hooks against the same or different events;
each call returns its own unsubscribe function. All of them are removed together
when the plugin's API is drained (see [Plugin / skill loading &
unloading](#plugin--skill-loading--unloading)).

---

## Payload (`HookInput`)

Identical for both transports. Flat and JSON-serializable so shell and in-process
hooks see the same shape.

```jsonc
{
  "event": "PreToolUse",
  "toolName": "bash",                                   // PreToolUse / PostToolUse
  "toolInput": { "command": "ls" },                     // PreToolUse / PostToolUse
  "toolResult": {                                       // PostToolUse only
    "content": "...", "isError": false,
    "modifiedPaths": ["/abs/project/src/file.ts"],       // optional bulk-write scope
    "modifiedPathsOmitted": 2                            // optional omitted entry count
  },
  "prompt": "user text",                                // UserPromptSubmit only
  "compaction": {                                       // PreCompact / PostCompact
    "trigger": "auto",                                  // auto | manual | overflow | tool
    "aggressive": false,
    "tokensBefore": 182000, "tokensAfter": 41000        // PostCompact only
  },
  "subagent": {                                         // SubagentStart / SubagentStop
    "target": "reviewer", "task": "review the diff",
    "subagentId": "reviewer@1", "delegationId": "d-1", "mode": "background",
    "ok": true, "status": "success", "summary": "...", "durationMs": 5400  // SubagentStop only
  },
  "notification": {                                     // Notification
    "kind": "permission",                               // permission | input
    "message": "Permission needed to run bash",
    "toolName": "bash"                                  // permission only
  },
  "cwd": "/abs/project",
  "workingDir": "/abs/project/apps/api",                // when it differs from cwd (set_working_dir)
  "sessionId": "01J..."                                 // when known
}
```

For completed `patch` and `replace` calls, `modifiedPaths` carries the tool's
reported file scope before text rendering, truncation or spooling. Paths are
absolute and deduplicated from at most 64 entries; invalid paths and paths
changed by secret scrubbing are omitted. `modifiedPathsOmitted` counts omitted
entries, including any beyond that bound. An empty list represents a known
empty scope (including a dry run); an absent list is unknown. The field does
not certify file contents or test success. It is not populated for failed calls.

The types intentionally avoid referencing the live `Context` (which lives in a
higher layer) so `types/config.ts` can import them without a layering cycle. The
runtime pieces (`HookRegistry`, `HookRunner`, `runShellHook`) translate live run
state into this serializable shape at each phase.

---

## Outcome (`HookOutcome`)

A command hook may **print** a JSON object to stdout; an HTTP hook returns one
in its response body; an in-process hook may
**return** one. Every field is optional — an empty object, `undefined`, or a
command hook that prints nothing all mean "allow, no side effect".

```jsonc
{ "action": "allow" }
{ "action": "deny", "reason": "blocked: rm -rf" }
{ "action": "mutate", "input": { "command": "ls -la", "timeout_ms": 30000 } }
```

These outcomes are mutually exclusive. `allow` means this hook has no
objection; it never bypasses WrongStack's permission policy. YOLO work
therefore continues silently unless an explicit deny rule blocks it.
Legacy `decision: "block"|"allow"` and `modifiedInput` outputs remain
accepted and are normalized at the transport boundary.

**Command shortcut:** exit code `2` forces `action: "deny"` (with stderr, or
failing that stdout, truncated to 2 000 chars as the reason), matching Claude's
convention. Other non-zero exits are hook failures and follow `failurePolicy`.

Mutation is **only honored for mutator-stage `PreToolUse` hooks**. The executor swaps it in
and **re-validates** it against the tool's `inputSchema` before running — a hook
cannot bypass the schema. A re-validation failure is fed back to the model as
an error so it can self-correct.

---

## Filters / preconditions (matchers)

`PreToolUse` and `PostToolUse` entries take a `matcher` on the tool name. A few
observational events match on something else: `SubagentStart`/`SubagentStop` on
the subagent target (roster role or name), `Notification` on the kind
(`permission` | `input`), and `PreCompact`/`PostCompact` on the trigger (`auto` |
`manual` | `overflow` | `tool`). The remaining events ignore it (every registered
hook for that event runs).

A matcher is one of:

- `"*"` (or empty/omitted) — matches every tool
- A **pipe-delimited, case-insensitive** list of exact tool names, e.g. `"bash"`,
  `"edit|write"`, `"bash|edit|write"`

Matching is by **exact tool name**, not substring or regex. `"edit"` matches the
tool named `edit`; it does **not** match `editFile`. The comparison is
case-insensitive on both sides, so `"Bash"` matches a tool registered as `bash`.

For `UserPromptSubmit`, `SessionStart`, `Stop` and `SessionEnd` the matcher is
treated as `*` and every registered hook runs. There is no content-based filter
on `prompt` or `additionalContext` — if you need one, write it inside your hook.

---

## Async behavior, deadlines, and failure policy

- Every invocation is awaited behind a per-hook deadline (`timeoutMs`, default
  5 000 ms). In-process hooks receive `{ signal, deadlineAt }` and must use
  asynchronous I/O. Blocking APIs such as `execSync` defeat cancellation and
  must not be used in hook bodies.
- Command hooks are killed as a process tree on timeout or abort. HTTP hooks
  pass the same cancellation signal to `fetch`.
- `failurePolicy: "open"` (default) logs timeout/crash/malformed output and
  continues. `failurePolicy: "closed"` turns the failure into a model-visible
  denial; it does not open an approval dialog.
- The runner uses `Promise.allSettled` for fan-out events so a single slow hook
  does not block its siblings — but the caller still awaits every hook before
  continuing, so the slowest hook in a fan-out sets the floor for that phase.
- Hooks share the agent's event loop. Ctrl-C and hook deadlines propagate via
  `AbortSignal`. An in-process hook that ignores the signal may keep doing work
  after the runner stops awaiting it, so hooks must be cancellation-cooperative.

---

## Error isolation

**A hook can never crash the agent.** Every invocation is isolated, then its
failure is interpreted using the hook's explicit failure policy:

| Failure mode | Resolution | Surfaced as |
|---|---|---|
| In-process hook throws/times out | Signal fired; open = skip, closed = deny | warning + policy result |
| In-process hook returns a non-object | `invalid_output`; open = skip, closed = deny | warning + policy result |
| Command hook fails or times out | Process tree killed; open = skip, closed = deny | warning + policy result |
| HTTP connection/non-2xx/timeout | Request aborted; open = skip, closed = deny | warning + policy result |
| Configured hook emits invalid JSON | `invalid_output`; open = skip, closed = deny | warning + policy result |
| Shell hook emits valid JSON missing fields | Missing fields dropped, partial outcome used | nothing |

The isolation guarantee is **per-hook**: one hook failing does not prevent
other hooks in the same chain/fan-out from running, and does not abort the
tool call, user turn, or session.

The only exception is an **explicit `decision: "block"`**, which is the hook
doing its job, not a failure. A block propagates normally (tool not run / turn
ended) and the `reason` is shown to the model.

### Output caps

- Command-hook stdout and HTTP-hook responses are capped at **64 KiB**. Beyond that the buffer is
  truncated and the hook's outcome (if any) is parsed from the truncated
  prefix.
- Command-hook stderr is capped at 64 KiB for the deny-reason fallback.
- Block reasons are truncated to **2 000 chars** before being shown to the
  model.

---

## Security model

- Command hooks run arbitrary commands **you** put in your own config — they are
  not model-controlled and cannot be installed by a prompt. Still: keep hook
  scripts in version control and review them like any other automation.
- `runShellHook` splits the command into argv — quote-aware (`"a b"` and
  `'a b'` are one argument; inside double quotes only `\"` and `\\` are
  escapes, so Windows paths keep their backslashes; an unterminated quote
  rejects the hook) — and checks the executable against a command allowlist
  (shells, interpreters, common utilities, git). It then spawns it **without a
  shell**: `&&`, `|`, `>`, `$(...)` reach the program as literal arguments.
  For pipes or redirects, say so explicitly with `sh -c "..."` (or
  `pwsh -Command "..."`). The allowlist is a convenience filter, **not a
  security boundary** — `sh`, `node` and friends are on it — so treat the
  complete command string as trusted operator code. The two documented escape
  hatches for operator-authored executables are:
  1. Reference a script by **absolute path** (POSIX `/...` or Windows
     `C:\...`/`C:/...`).
  2. Drop a wrapper under `.wrongstack/hooks/` and reference it by absolute
     path.
- `--no-hooks` disables ordinary automation across every transport. Hooks
  explicitly marked `policy: true` remain active.
- Command hooks inherit a sanitized child environment via `buildChildEnv()`.
- HTTP hooks accept loopback `http://` URLs and **any syntactically valid
  `https://` URL**; they do not block private, link-local, metadata, or other
  sensitive HTTPS destinations. Configure only operator-trusted endpoints.
- Hook payloads include tool inputs/results and can therefore contain sensitive
  data. Treat command scripts and HTTP endpoints as trusted policy components;
  prefer loopback or HTTPS and never log raw payloads indiscriminately.

---

## Plugin / skill loading & unloading

### Loading

1. **Boot phase.** `HookRegistry.loadShellHooks(config.hooks)` registers every
   configured command/HTTP hook. These are owned by the runtime.
2. **Plugin setup phase.** The plugin loader topologically sorts plugins by
   `dependsOn`/`optionalDeps`, then calls each plugin's `setup(api)`. Inside
   `setup`, a plugin calls `api.registerHook(...)`. Each call:
   - Adds an `inprocess` entry to the shared `HookRegistry`, tagged with the
     plugin's name as `owner`.
   - Pushes the returned unsubscribe function onto the plugin's private
     `pluginCleanupFns` stack.
3. **Capability gate.** If a plugin declares `capabilities` and includes
   `hooks: false`, the loader wraps its API so `registerHook` emits a warning
   (default) or throws (when `enforceCapabilities: true`). A plugin that
   declares `hooks: true` (or declares no capabilities at all) is not gated.
   See [Capability gating](#capability-gating-for-hooks) below.

### Unloading

Plugin teardown happens in **reverse registration order** (mirroring stack-style
resource ownership when plugin B depends on plugin A):

1. The loader calls `plugin.teardown(api, { signal })` with a per-plugin timeout
   (default 10 000 ms).
2. `DefaultPluginAPI.drainCleanup()` runs every function on `pluginCleanupFns`
   — including each hook's unsubscribe — best-effort (errors swallowed).
3. **Belt-and-braces backstop:** `drainCleanup()` then calls
   `HookRegistry.drainByOwner(pluginName)`, which removes any in-process hook
   still tagged with that plugin's name. This catches the edge case where
   `setup()` threw **partway through** after registering some hooks — the
   per-call unsubscribes for the not-yet-pushed hooks would otherwise never
   fire, leaving dangling closures in the registry.
4. Configured hooks (runtime-owned) are **never** removed by `drainByOwner`. They
   persist for the session and are cleared by `HookRegistry.clear()` only at
   full session teardown.

The result: **no plugin-owned hook can outlive its plugin.** Even a plugin that
crashes during setup leaves a clean registry.

### Hot reload (configured hooks)

Configured hooks **are** hot-reloaded. The CLI subscribes to `ConfigStore.watch`
at boot (`packages/cli/src/cli-main.ts`); whenever `config.hooks` changes,
the watcher calls `HookRegistry.replaceShellHooks(next.hooks)` which:

1. Builds the replacement before changing live state, then drops every old
   configured entry (in-process entries are untouched).
2. Installs the new command/HTTP set from the updated config map.
3. Logs `"Hooks reloaded (N configured entries across K events)"` at `info`
   level so operators can confirm the reload.

The watcher uses a structural per-entry equality predicate
(`shellHooksEqual(a, b)`) so unrelated config changes — model, log level,
provider, etc. — do **not** trigger a redundant reload. The reload only
fires when the configured hook set actually changed (transport target,
matcher, timeout/failure/stage/policy controls, headers, or the event list).

A failed reload never crashes the watcher — it's caught at warn level and
the previous hook set stays in place.

In-process hooks follow plugin lifecycle as before: installing a plugin via
the plugin manager runs its `setup` (registering its hooks); uninstalling
runs its `teardown` (draining them).

---

## Capability gating for hooks

`PluginCapabilities` includes an optional `hooks` flag, mirroring the existing
gates for `tools`, `providers`, `slashCommands`, and `mcp`:

```ts
export interface PluginCapabilities {
  tools?: boolean;
  providers?: boolean;
  pipelines?: string[];
  slashCommands?: boolean;
  mcp?: boolean;
  toolMutateCapabilities?: string[];
  hooks?: boolean;   // ← will the plugin call api.registerHook()?
}
```

The loader applies the gate **only when `capabilities` is non-null** (this
matches the existing tools/providers behavior — capability gating is opt-in).
Inside the gate:

| Declaration | Behavior on `registerHook` |
|---|---|
| `hooks: true` | Pass-through, no warning |
| `hooks: false` | Warning logged (default) **or** `PluginError` thrown (`enforceCapabilities: true`); call still forwarded |
| `capabilities` omitted entirely | No wrap applied — pass-through (consistent with tools/providers) |

Use `enforceCapabilities: true` in CI / strict deployments to force plugins to
declare every subsystem they touch.

---

## DI & internals

- **Types:** `packages/contracts/src/types/hooks.ts` — `HookEvent`, `HookInput`,
  `HookOutcome`, `InProcessHook`, `ShellHook`, `HookEntry`.
- **Registry:** `packages/core/src/hooks/registry.ts` — `HookRegistry` with
  `registerInProcess`, `registerShell`, `loadShellHooks`, `replaceShellHooks`,
  `list`, `has`, `all`, `drainByOwner`, `countByOwner`, `clear`; plus the
  exported `hookMatcherMatches(matcher, toolName)` predicate.
- **Shell-hook equality:** `packages/core/src/hooks/shell-hooks-equal.ts` —
  `shellHooksEqual(a, b)` and `countShellHooks(hooks)` helpers used by the
  hot-reload path to decide whether `config.hooks` actually changed before
  re-running `replaceShellHooks`.
- **Runner:** `packages/core/src/hooks/runner.ts` — `HookRunner` with
  `preToolUse`, `postToolUse`, `userPromptSubmit`, `sessionStart`, `stop`, and
  the cheap `has(event)` guard.
- **Shell executor:** `packages/core/src/hooks/shell-executor.ts` —
  `runShellHook(spec, input, logger?)` with allowlist, timeout, and output cap.
- **DI token:** `TOKENS.HookRegistry` (`packages/contracts/src/kernel/tokens.ts`).
  Resolve it from the container to get the session's shared registry.
- **Plugin API surface:** `PluginAPI.registerHook` (`plugin/api.ts`) and the
  `hookRegistry` field on `PluginAPIInit`.
- **Consumer wiring:**
  - `PreToolUse` / `PostToolUse` are called from `ToolExecutor.executeBatch`
    (`execution/tool-executor.ts`), gated behind `hookRunner.has(event)` so the
    payload is only built when something listens.
  - `UserPromptSubmit` is a `userInput` pipeline middleware
    (`packages/cli/src/hooks-wiring.ts` → `createUserPromptSubmitMiddleware`).
    A `block` outcome throws `HookBlockedError`, which the pipeline's error
    boundary rethrows so `Agent.run` ends the turn without a model call.
  - `SessionStart` and `Stop` are an `AgentExtension`
    (`createLifecycleHooksExtension`). `SessionStart` fires on the first
    `beforeRun` and appends its `additionalContext` to `ctx.systemPrompt` for
    the rest of the session. `Stop` fires on every `afterRun`.
  - The observational events come from `bridgeLifecycleHooks`
    (`core/src/hooks/lifecycle-bridge.ts`): `PreCompact`/`PostCompact` attach
    to the compactor's `observe()` seam (the journaled compactor every
    compaction path goes through), and the rest subscribe to bus events —
    `delegate.started`/`delegate.completed`, `tool.confirm_needed`,
    `user.input_requested`, and `session.ended` (joined via its `waitUntil`).
    `HookRunner.observe()` runs them.
- **Boot wiring:** `packages/cli/src/wiring/lifecycle-plugins.ts` calls
  `hookRegistry.loadShellHooks(config.hooks)` (policy hooks only under
  `--no-hooks`), installs the middleware + extension into the agent, and calls
  `bridgeLifecycleHooks`. Configured hooks run in the CLI host (REPL, TUI, and
  the WebUI it serves); the standalone WebUI server does not load
  `config.hooks`.

### Public exports

From `@wrongstack/core/hooks`:

```ts
import {
  HookRegistry,           // class
  HookRunner,             // class
  runShellHook,           // (spec, input, logger?) => Promise<HookOutcome | null>
  runShellHookDetailed,   // preserves timeout/exit/parse failure classification
  runHttpHookDetailed,    // POST HookInput JSON to a native HTTP hook
  hookMatcherMatches,     // (matcher, toolName?) => boolean
  shellHooksEqual,        // (a, b) => boolean — structural configured-hook equality
  countShellHooks,        // (hooks) => number — total entries across events
  bridgeLifecycleHooks,   // wires the observational events to a HookRunner
  HOOK_EVENTS,            // every event name, in lifecycle order
  isHookEvent,            // (value) => value is HookEvent
} from '@wrongstack/core/hooks';
import type {
  HookEvent,              // see HOOK_EVENTS for the full list
  ObservationalHookEvent, // the six events whose outcome is ignored
  HookMatcher,            // string
  HookInput,              // the payload
  HookOutcome,            // legacy/non-PreToolUse return shape
  PreToolUseOutcome,      // explicit allow | deny(reason) | mutate(input)
  AnyHookOutcome,         // accepted transport-boundary output
  InProcessHook,          // (input, { signal, deadlineAt }) => value/Promise
  HookRegistrationOptions,// timeout, failure policy, stage, policy marker
  ShellHook,              // command transport configuration
  HttpHook,               // native HTTP transport configuration
  ConfiguredHook,         // ShellHook | HttpHook
  HookEntry,              // discriminated union of registered entries
  HookRunEnv,             // { cwd: string }
  HookRunnerOptions,      // { registry, logger?, allowNonPolicy?, sessionId? }
  PreToolUseResult,       // { block?, reason?, input? }
  PromptResult,           // { block?, reason?, additionalContext? }
  ShellHookSpec,          // { command, timeoutMs? }
} from '@wrongstack/core/hooks';
```

---

## Recipes

### Block a dangerous shell command

`scripts/guard-bash.sh`:

```bash
#!/usr/bin/env bash
input=$(cat)                                                 # HookInput JSON on stdin
cmd=$(printf '%s' "$input" | jq -r '.toolInput.command // ""')
if printf '%s' "$cmd" | grep -qE 'rm -rf|:\(\)\{'; then
  echo '{"action":"deny","reason":"dangerous command blocked"}'
  exit 0                                                     # (or: exit 2)
fi
# allow (no output)
```

`config.json`:

```jsonc
{
  "hooks": {
    "PreToolUse": [{
      "name": "bash-safety",
      "matcher": "bash",
      "stage": "validate",
      "command": "bash ./scripts/guard-bash.sh",
      "timeoutMs": 3000,
      "failurePolicy": "closed",
      "policy": true
    }]
  }
}
```

### Rewrite tool arguments (in-process)

```ts
api.registerHook('PreToolUse', 'bash', async (input) => {
  const cmd = (input.toolInput as { command?: string }).command ?? '';
  // Force `ls` to always show long form
  if (cmd.startsWith('ls ') && !cmd.includes('-l')) {
    return { action: 'mutate', input: { ...input.toolInput, command: cmd.replace('ls', 'ls -l') } };
  }
  return { action: 'allow' };
}, { name: 'long-ls', stage: 'mutate', failurePolicy: 'open' });
```

The rewritten input is **re-validated** against the tool's schema before it
runs — if your rewrite produces an invalid shape, the model gets a clear
validation error instead of a silent misuse.

### Append lint output after every edit

```ts
api.registerHook('PostToolUse', 'edit|write', async (input) => {
  const lint = await runLint(input.toolInput);
  return lint ? { additionalContext: `Lint:\n${lint}` } : {};
});
```

### Inject a project reminder at session start

```ts
api.registerHook('SessionStart', undefined, async () => ({
  additionalContext: 'Reminder: this repo uses conventional commits.',
}));
```

### Run a teardown side effect at end of every turn

```ts
api.registerHook('Stop', undefined, async () => {
  await flushCoverageReport();
});
```

### Get a desktop ping when the agent is waiting on you, and log compactions

```jsonc
{
  "hooks": {
    // Only permission prompts, not structured questions. Commands run without
    // a shell, so pipes and $(...) need an explicit `sh -c "..."`.
    "Notification": [
      { "matcher": "permission", "command": "sh -c \"notify-send wstack \\\"$(jq -r .notification.message)\\\"\"" }
    ],
    // Every pass, whatever triggered it; the payload carries the token counts.
    "PostCompact": [{ "command": "sh -c \"jq -c .compaction >> .wrongstack/compactions.log\"" }],
    // Only when the reviewer subagent finishes.
    "SubagentStop": [{ "matcher": "reviewer", "command": "node ./scripts/on-review-done.mjs" }]
  }
}
```

---

## Disabling hooks

| Mechanism | Scope | Effect |
|---|---|---|
| `--no-hooks` CLI flag | Whole session | Ordinary hooks are skipped across all transports; `policy: true` hooks remain |
| `allowNonPolicy: false` on `HookRunnerOptions` | Runner instance | Ordinary hooks are skipped across all transports; policy hooks still run |
| Plugin uninstall | That plugin's hooks | `drainByOwner` removes every in-process hook the plugin registered |
| `HookRegistry.clear()` | Whole registry | Every entry (configured + in-process) dropped; used in tests and full session teardown |
