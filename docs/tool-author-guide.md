# Tool Author Guide

How to write a WrongStack tool. Tools are the agent's hands: the model
emits `tool_use` blocks, the executor runs your `execute` function, and
the result feeds back into the next turn.

---

## The minimum viable tool

```ts
import type { Tool } from '@wrongstack/contracts/types';

export const echoTool: Tool<{ text: string }, { echoed: string }> = {
  name: 'echo',
  description: 'Echoes its input back. Useful for testing.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  permission: 'auto',
  mutating: false,
  riskTier: 'safe',
  async execute(input) {
    return { echoed: input.text };
  },
};
```

Register it from a plugin (`api.tools.register(echoTool)`) or directly on
an Agent (`agent.register(echoTool)`).

---

## The `Tool` interface

```ts
interface Tool<I, O> {
  name: string;
  description: string;             // shown in the system prompt; the model reads this
  usageHint?: string;              // optional; richer prose for the system prompt
  inputSchema: JSONSchema;         // validated before execute() runs
  permission: 'auto' | 'confirm' | 'deny';
  mutating: boolean;               // hints UI; doesn't enforce anything
  riskTier?: 'safe' | 'standard' | 'destructive';
  maxOutputBytes?: number;
  preserveFullOutput?: boolean;      // opt out of output previewing/truncation
  timeoutMs?: number;
  estimatedDurationMs?: number;    // TUI spinner hint only
  execute(input: I, ctx: Context, opts: { signal: AbortSignal }): Promise<O>;
  executeStream?(input, ctx, opts): AsyncIterable<ToolStreamEvent<O>>;
  cleanup?(input: I, ctx: Context): Promise<void>;
}
```

| Field | What it does |
|---|---|
| `name` | Must match `/^[a-z][a-z0-9_-]*$/`. MCP tools are prefixed `mcp__<server>__`. |
| `description` | Goes into the system prompt under `## Tool usage`. Be terse and concrete — the model reads every line of this. |
| `selection` | Negative selection boundary for similar tools: say when not to use this tool and name the preferred alternative(s). |
| `usageHint` | Replaces `description` in the prompt when set. Use for richer guidance. |
| `inputSchema` | JSON Schema subset (no `$ref`, no `format`). Validated by `validateAgainstSchema` before `execute` runs. |
| `permission` | `auto` runs without prompting. `confirm` prompts the user. `deny` rejects calls without prompting (useful for read-only modes). |
| `mutating` | UI hint that this tool may change the workspace. Doesn't enforce anything — `permission` is the real gate. |
| `riskTier` | Optional risk classification: `safe`, `standard`, or `destructive`. YOLO auto-approves non-denied calls; when YOLO is off, risk can inform prompts. |
| `capabilities` | Optional capability tags (e.g. `['fs.read']`, `['net.outbound']`). Used by the permission policy and plugin mutation rules to decide who can invoke or modify the tool. See **Capability Model** below. |
| `maxOutputBytes` | Hard cap. The executor truncates and emits a warning. |
| `preserveFullOutput` | Opt out of artifact previewing and iteration-budget truncation when completeness is part of the tool contract. Use sparingly and only with bounded inputs; the result still consumes the remaining budget for accounting. |
| `timeoutMs` | Hard cap. After this, the executor aborts via the run's `AbortController`. |

---

## `permission`: the three settings

- **`auto`** — runs without prompting. Use for read-only or clearly-safe
  ops. The user can still globally enable `--yolo` to skip `confirm`
  prompts when YOLO is off.
- **`confirm`** — prompts the user before each call. Use for write paths,
  shell execution, network mutations, anything reviewable.
- **`deny`** — rejected before `execute` runs. Mostly used by per-tool
  config to disable a tool in a constrained mode.

The CLI also has a per-project trust file
(`~/.wrongstack/projects/<hash>/trust.json`) where users can set `auto` for a
specific tool+pattern combination after confirming it once. You don't need to
think about that as a tool author — just set the right `permission` default.

---

## Capability Model

Tools can declare **capability tags** in the `capabilities` array. These tags
are used by two subsystems:

1. **Permission policy** — the `AutoApprovePermissionPolicy` can allowlist or
denylist by capability rather than by individual tool name.
2. **Plugin mutation rules** — a plugin can only wrap or unregister a tool it
doesn't own if the plugin declares a matching `toolMutateCapabilities` entry.

### Canonical capability names

| Capability | Meaning | Example tools |
|---|---|---|
| `fs.read` | Reads files or directories | `read`, `glob`, `grep`, `tree`, `diff` |
| `fs.write` | Writes or modifies files | `write`, `edit`, `replace`, `patch`, `plan` |
| `fs.write.outside-project` | Writes outside `projectRoot` | `scaffold` (templates), `codebase-index` |
| `shell.arbitrary` | Runs arbitrary shell commands | `bash` |
| `shell.restricted` | Runs allowlisted commands | `exec`, `git`, `audit`, `lint`, `format`, `typecheck`, `test` |
| `shell.exec` | Runs a specific formatter-style shell command | plugin tools |
| `net.outbound` | Makes outbound network requests | `fetch`, `search`, `outdated` |
| `memory.read` | Reads from agent memory | `memory` (read/search), `search_memory`, `find_related_memories` |
| `memory.write` | Writes to agent memory | `memory` (write), `remember` |
| `memory.delete` | Deletes from agent memory | `memory` (delete), `forget` |
| `session.todo` | Manages session todos | `todo` |
| `session.mode` | Changes agent mode | `mode` |
| `tool.meta` | Queries tool metadata | `tool-help`, `tool-search` |
| `tool.mutate.any` | Can mutate any tool (broad power) | `tool-use`, `batch-tool-use` |
| `package.install` | Installs packages | `install` |
| `mcp.proxy` | Proxies to an MCP server | *(reserved for MCP tools; automatically set by `wrapMCPTool`)* |
| `subagent.spawn` | Spawns subagents | *(reserved for subagent tools)* |
| `config.mutate` | Mutates global config | `mcp_control` (MCP server lifecycle) |

### Declaring capabilities on a tool

```ts
export const myTool: Tool<{ path: string }, { content: string }> = {
  name: 'my-reader',
  description: 'Reads a file.',
  inputSchema: { ... },
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],   // ← declare what this tool can do
  async execute(input) { ... },
};
```

### Plugin mutation rules

When a plugin wants to **wrap** or **unregister** a tool it doesn't own, it must
declare the matching capability in its `PluginCapabilities`:

```ts
// plugin manifest or init
const capabilities: PluginCapabilities = {
  toolMutateCapabilities: ['fs.read', 'fs.write'],
};
```

Rules:
- **Official plugins** (bundled with WrongStack) can mutate any tool.
- **Tool owners** can always mutate their own tools.
- **External plugins** can only mutate tools whose `capabilities` array
  overlaps with the plugin's `toolMutateCapabilities`.
- If a tool has **no capabilities declared**, external plugins cannot mutate it.

---

## Streaming output

If your tool emits incremental output (a long `bash` command, a paginated
search, a slow HTTP fetch), implement `executeStream` instead of `execute`:

```ts
async *executeStream(input, ctx, opts) {
  yield { type: 'log', text: `Connecting to ${input.host}…` };

  const conn = await connect(input.host, { signal: opts.signal });

  for await (const chunk of conn.lines()) {
    yield { type: 'partial_output', text: chunk + '\n' };
  }

  yield { type: 'metric', data: { lines: conn.totalLines } };
  yield { type: 'final', output: { ok: true, lines: conn.totalLines } };
},
```

### Event types

| `type` | When |
|---|---|
| `log` | Verbose info that's not part of the final output. "Scanning…", "Found 12 candidates". Shown by the TUI as a dim ephemeral line. |
| `partial_output` | Streamed body text. The TUI prints it live, joined into the assistant view. |
| `metric` | Numeric updates (files scanned, bytes downloaded). The UI may render a progress widget. |
| `file_changed` | Announces a write the user might want to know about. `data.path` should be absolute. |
| `warning` | Non-fatal issue. The UI surfaces it in dim yellow. |
| `final` | **Required.** The terminal event. Its `output` is unwrapped and treated as the `execute` return value. |

The executor publishes each non-`final` event as `tool.progress` on the
EventBus — subscribers can react without you doing anything special.

You must yield exactly one `final` event, and it must be last. The
executor enforces this.

### When NOT to use `executeStream`

If your tool is fast (<100ms) and atomic, just use `execute`. The stream
path has overhead and adds complexity for no win.

---

## Aborts and cancellation

Every `execute` / `executeStream` call receives an `opts.signal`. Honor it:

- Pass it to `fetch`, `spawn`, anything that takes a signal natively
- Wire `signal.addEventListener('abort', …)` for handles that don't
- Check `signal.aborted` between long chunks

The signal aborts when:
- The user hits Ctrl-C during the tool call
- A `timeoutMs` you set on the tool elapses
- The whole agent run aborts

If you ignore the signal, your tool can wedge the agent until the OS
notices. Don't.

---

## `cleanup` vs `ctx.registerAbortHook`

Two distinct teardown channels.

### `Tool.cleanup` — for resources owned by the tool author

Use this for resources established **at execute-time** that the tool
itself created: child processes spawned, file handles opened, network
connections initiated. Co-located with the tool definition so readers
see the resource and its teardown in one place.

```ts
async execute(input, ctx, opts) {
  const child = spawn(input.command, { signal: opts.signal });
  this.activeChild = child;
  // … tool work …
},
async cleanup(_input, _ctx) {
  // Best-effort kill of any child still running
  await this.activeChild?.kill('SIGTERM');
},
```

`cleanup` fires when the tool's own run is aborted (its signal triggers).
Errors are swallowed — they never mask the originating failure.

### `ctx.registerAbortHook` — for context-scoped teardown

Use this when the tool delegates to a library that needs cancellation,
or when the resource is created lazily somewhere down the call stack and
the natural cleanup point isn't at the tool boundary. The hook fires
when the **agent run** ends, not when this specific tool call aborts.

```ts
async execute(input, ctx, opts) {
  const handle = await openHelper();
  ctx.registerAbortHook(() => handle.dispose());
  // … work …
}
```

If you register both for the same resource, `cleanup` fires first (on
tool abort) and the abort-hook fires later on the wider run abort. Don't
double-free — gate one on the other or pick a single channel per
resource.

---

## Talking back to the user

Most tools just return — the model reads the result and writes prose.
But for long ops you want to send signals:

```ts
async *executeStream(input, ctx, opts) {
  yield { type: 'log', text: 'Starting batch upload…' };
  for (let i = 0; i < items.length; i++) {
    await upload(items[i]);
    yield { type: 'metric', data: { uploaded: i + 1, total: items.length } };
  }
  yield { type: 'final', output: { count: items.length } };
}
```

For permanent records (errors the user should see in the session log),
write to `ctx.session.append({...})` — but be aware: every tool result
already gets a `tool_result` session entry from the executor, so you
rarely need to write your own.

---

## `inputSchema` — what's supported

The validator in [`packages/core/src/utils/json-schema-validate.ts`](../packages/core/src/utils/json-schema-validate.ts)
is intentionally small and tolerant. Supported keywords:

- `type` (`string`, `number`, `integer`, `boolean`, `object`, `array`)
- `properties`, `required`, `additionalProperties`
- `items`
- `enum`
- `minimum`, `maximum`, `minLength`, `maxLength`
- `pattern` (RegExp string)

Unknown keywords are ignored (so `description`, `examples`, vendor
extensions are fine). NOT supported: `$ref`, `anyOf`/`oneOf`/`allOf`,
`format`, conditional schemas. If you need those, bring your own AJV
validator inside `execute`.

---

## File reads — the mtime contract

Tools that read files should record the read so the agent's stale-write
detector can do its job:

```ts
const stat = await fs.stat(absPath);
const buf = await fs.readFile(absPath);
ctx.recordRead(absPath, stat.mtimeMs);
```

`ctx.hasRead(absPath)` returns true if the file was seen during this run.
`ctx.lastReadMtime(absPath)` returns when. The `write`/`edit` tools use
both: they refuse a blind overwrite of a file that's changed on disk
since the agent last read it.

---

## Testing your tool

Tool tests use minimal `Context` shims since most tools only need a few
fields:

```ts
import { describe, it, expect } from 'vitest';
import type { Context } from '@wrongstack/core/agent';
import { echoTool } from '../src/echo.js';

const ctx = {} as Context;
const opts = { signal: new AbortController().signal };

describe('echo', () => {
  it('echoes its input', async () => {
    const out = await echoTool.execute({ text: 'hi' }, ctx, opts);
    expect(out.echoed).toBe('hi');
  });

  it('streams a final event', async () => {
    if (!echoTool.executeStream) return;
    const events = [];
    for await (const e of echoTool.executeStream({ text: 'hi' }, ctx, opts)) events.push(e);
    expect(events.at(-1)?.type).toBe('final');
  });
});
```

For tools that need a real signal/abort interaction, drive the
`AbortController` from the test and assert the tool stops.

---

## Examples in the repo

- **Simple read-only**: [`packages/tools/src/glob.ts`](../packages/tools/src/glob.ts)
- **Streaming with subprocess**: [`packages/tools/src/bash.ts`](../packages/tools/src/bash.ts) (uses `spawnStream` from `_util.ts`)
- **Mutating with file-mtime contract**: [`packages/tools/src/write.ts`](../packages/tools/src/write.ts)
- **HTTP fetch with streaming body**: [`packages/tools/src/fetch.ts`](../packages/tools/src/fetch.ts)
- **Meta-tool**: [`packages/tools/src/tool-search.ts`](../packages/tools/src/tool-search.ts)

When in doubt, read the closest analogue, then write yours.

---

## Security Considerations for Tool Authors

WrongStack treats **all LLM-generated tool inputs as adversarial** (see `SECURITY.md`).
When you write a new tool you are extending the agent's attack surface.

### Mandatory checklist before shipping a tool

- [ ] **Permission, mutating, and risk flags** — Did you set `permission`, `mutating`, and `riskTier` truthfully? `mutating: true` tools default to `'confirm'` for normal users, and `riskTier: 'destructive'` keeps YOLO from silently running high-risk actions.
- [ ] **Input validation** — `inputSchema` + runtime checks inside `execute`. Never trust `input.foo` blindly.
- [ ] **Path containment** — If the tool touches the filesystem, use `safeResolve` / `safeResolveReal` (see `_util.ts`). Never do `path.join(base, userInput)` without subsequent realpath check.
- [ ] **Child process / shell** — Prefer `spawn` with argument array + `shell: false`. If you must use the user's shell, go through the existing `bash`/`exec` infrastructure or get explicit security review.
- [ ] **Network / SSRF** — Any outbound fetch should go through (or copy the logic from) the guarded fetch helpers.
- [ ] **Secrets** — Never log or persist secrets. If your tool needs credentials, declare it and let the secret scrubber + vault handle them.
- [ ] **Capability declaration** (2026-06+) — When the capability system lands, declare the capabilities your tool grants (`shell.arbitrary`, `fs.write.outside-project`, `net.outbound`, `mcp.proxy`, etc.). New dangerous capabilities must be reviewed.
- [ ] **Subagent impact** — Will this tool be dangerous for subagents? If yes, it will likely be blocked by `AutoApprovePermissionPolicy` by default — document this clearly.

### New tool that touches these areas requires extra review

- Anything that spawns processes outside the strict `exec` allowlist
- Filesystem write / delete / move outside the project root
- Arbitrary outbound HTTP from inside a tool
- MCP tool proxying or dynamic tool registration
- Changes to `onlyBuiltDependencies` or `allowBuilds` in `pnpm-workspace.yaml`

See `docs/archive/plans/security-hardening-2026-06.md` (P2) for the current process expectations.

## Reference

- Tool type: [`packages/core/src/types/tool.ts`](../packages/core/src/types/tool.ts)
- Tool executor (what calls you): [`packages/core/src/execution/tool-executor.ts`](../packages/core/src/execution/tool-executor.ts)
- Streaming util used by bash/install/etc: [`packages/tools/src/_util.ts`](../packages/tools/src/_util.ts)
- JSON schema validator: [`packages/core/src/utils/json-schema-validate.ts`](../packages/core/src/utils/json-schema-validate.ts)
