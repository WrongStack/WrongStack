# Plugin Author Guide

How to write a WrongStack plugin: register tools, providers, slash
commands, pipeline middleware, and MCP servers. Tested end-to-end with
real plugin fixtures in `packages/core/tests/plugin/`.

> **Third-party authors:** depend on [`@wrongstack/plugin-sdk`](../packages/plugin-sdk/README.md)
> instead of `@wrongstack/core` — it exports the same contract types plus
> `definePlugin` and the shared runtime helpers. Packaging, publishing, and
> the trust model are covered in [plugin-third-party.md](./plugin-third-party.md).

---

## What a plugin is

A plugin is a default-exported `Plugin` object. The host calls
`setup(api)` during boot and `teardown(api)` on shutdown:

```ts
// my-plugin/index.ts
import type { Plugin } from '@wrongstack/plugin-sdk';

const plugin: Plugin = {
  name: 'my-plugin',
  version: '0.1.0',
  description: 'Adds a hello tool',
  apiVersion: '^0.1.0',      // semver range against KERNEL_API_VERSION
  capabilities: { tools: true },

  async setup(api) {
    api.tools.register({
      name: 'hello',
      description: 'Says hello to the user',
      inputSchema: { type: 'object', properties: { who: { type: 'string' } } },
      permission: 'auto',
      mutating: false,
      riskTier: 'safe',
      async execute(input) {
        return { greeting: `Hello, ${input.who ?? 'world'}!` };
      },
    });
  },

  async teardown() {
    // close handles, kill subprocesses, etc.
  },
};

export default plugin;
```

The host loads external plugins from (in precedence order — a `config.plugins`
entry always wins over a discovered plugin with the same name):

1. **`config.plugins` specifier entries** — `"my-plugin"` or
   `"@scope/wstack-plugin-x"` are dynamically imported through normal Node
   module resolution.
2. **`config.plugins` path entries** — `{ "name": "my-plugin", "path": "./my-plugin" }`
   resolves the target (relative paths anchor to the project root; absolute
   paths and `file:` URLs also work) to an entry file or a directory with
   `package.json` / `index.js`.
3. **Directory discovery** —
   - `~/.wrongstack/plugins/<name>/` — user-global, **active by default**
   - `<projectRoot>/.wrongstack/plugins/<name>/` — project-local, **inactive
     by default** (a cloned repo must not auto-execute plugin code; enable
     with a `plugins` entry or `extensions.<name>.enabled: true`)

   Each directory's entry is resolved from `package.json` (`main` or
   `exports["."]`) with `index.js` / `index.mjs` / `index.cjs` fallbacks.

`wstack plugin add <specifier>` registers a config entry;
`wstack plugin add <specifier> --install` additionally installs the package
into `~/.wrongstack/plugins/` via your package manager (npm/pnpm/yarn/bun;
`--pm` overrides detection) with lifecycle scripts **disabled by default**
(`--run-scripts` opts in) and records the explicit install path in config.

---

## Isolation Model — In-Process Only

WrongStack plugins run **in the same Node.js process as the host**. There is no
process boundary, no worker thread sandbox, and no VM isolation between a plugin
and the core. This is a deliberate architectural decision — in-process loading
keeps latency near zero and avoids the serialization overhead of IPC.

This has direct consequences for plugin authors:

| What this means | Why it matters |
|----------------|----------------|
| **A plugin that calls `process.exit()` kills the entire CLI.** | There is no boundary to catch it. |
| **A plugin with an infinite loop hangs the entire agent.** | No separate thread or process to timeout independently. |
| **A plugin with excessive CPU or memory use affects the whole process.** | No cgroup or container-level resource cap. |
| **A plugin with a security flaw has full host privileges.** | It can access `process.env`, the filesystem, and the network just like the core. |
| **`plugin.setup()` and `plugin.teardown()` are wrapped in timeouts** (30 s and 10 s by default), so a hung plugin won't permanently block boot or shutdown. | This is the only host-level safety net for in-process hangs. |

**Implication for plugin authors:** treat your plugin code as production-grade
Node.js — no `while (true) {}`, no unbounded recursion, no synchronous
heavy computation without a way to yield. If your plugin initiates external
work (subprocesses, network requests), manage its lifecycle in `teardown`.

**Implication for operators:** only install plugins from sources you trust.
There is no sandbox between a plugin and the host. If you need to run
untrusted code, that would require a future out-of-process plugin architecture
(which does not exist yet).

What the host *does* enforce for external (non-built-in) plugins:

- **Capability honesty is strict.** An external plugin calling an API surface
  it declared `capabilities.<surface>: false` (or omitted while using
  `false`-declared surfaces) is rejected at setup time. First-party plugins
  keep warn-only behaviour.
- **Trust-on-first-use pinning.** The first load of an external plugin hashes
  its resolved entry file (`sha256-…`) into `~/.wrongstack/plugin-trust.json`
  *before any module code executes*. A later load with a changed hash is
  refused until you confirm the change with `wstack plugin trust <name>`
  (or disable pinning globally with `features.pluginsTrust: false`).
- **Name spoofing is blocked.** External plugins may not declare a name owned
  by a built-in plugin, and their slash commands are namespaced
  (`owner:name`) instead of claiming bare names.

This tradeoff is the same model used by Webpack, Rollup, Babel, ESLint, and
Fastify — the dominant pattern in the JS/TS ecosystem. VS Code is the notable
counterexample (per-extension Node.js process), chosen because its marketplace
distributes extensions from unknown third parties.

---

## The `api` surface

`setup(api)` receives a scoped `PluginAPI`:

| Field | What it is |
|---|---|
| `api.container` | DI container — bind/resolve `TOKENS.*` |
| `api.pipelines` | All six core pipelines, plus any custom ones |
| `api.events` | `EventBus` for subscribing or emitting |
| `api.tools` | `register / registerAll / wrap / unregister / get / list` tools |
| `api.providers` | Register provider factories |
| `api.mcp` | Start / stop / restart MCP servers |
| `api.slashCommands` | Register `/cmd` handlers |
| `api.config` | The loaded `Config` (read-only snapshot) |
| `api.log` | Scoped `Logger` — entries are tagged with `plugin=<name>` |
| `api.onEvent(name, h)` | Auto-removed-on-teardown event listener |
| `api.onPattern('tool.*', h)` | Wildcard event listener (all matching events) |
| `api.emitCustom(event, payload)` | Emit a custom event on the EventBus |
| `api.onConfigChange(h)` | Called when ConfigStore.update() fires |
| `api.extensions` | Register lifecycle hooks (beforeRun, afterRun, onError, etc.) |
| `api.session` | Append custom events to the JSONL session log |
| `api.metrics` | Record scoped counters/histograms/gauges → Prometheus/OTLP |
| `api.llm` | Host-routed One Shot completions and optional Council deliberation (guard for `undefined`) |

Use `onEvent` instead of `events.on(...)` when you want the listener to
disappear with the plugin. Use raw `events.on` only when you need to
explicitly unsubscribe yourself in `teardown`.

### `api.llm` — LLM access for plugins

Plugins can call the LLM without ever touching API keys. Production CLI
completions run through the shared One Shot orchestrator, including live model
routing, provider health tracking, timeout enforcement, and fallback chains:

```ts
async setup(api) {
  if (!api.llm) return; // minimal hosts (tests, LSP server) don't wire it

  const result = await api.llm.complete('Summarize: …', {
    system: 'You are terse.',
    role: 'document',             // model-matrix routing hint
    fallbackModels: ['openai/gpt-5-mini'],
    timeoutMs: 30_000,            // hard-capped at 120 seconds
    maxTokens: 200,              // default 2048, hard-capped at 32768
    responseFormat: 'json',      // optional: ask for a JSON object
  });
  api.log.info(result.text, {
    model: result.model,
    usage: result.usage,
    fromFallback: result.fromFallback,
    attempts: result.attempts,
  });
}
```

Provider/model resolution, per call:

1. A configured model-matrix entry for `role` — explicit user routing intent
2. `complete(prompt, { provider, model })` — per-call target
3. `config.extensions['<plugin>'].llm = { provider, model }` — per-plugin
   default the USER configures (any key of `config.providers`, e.g. a
   cheap local `omniroute` model for background chores)
4. the host session's active provider/model

`api.llm.defaults()` returns the effective per-plugin `{ provider, model }`.
Calls are metered under `plugin.<name>.llm.*` (calls, tokens_in,
tokens_out, errors). Minimal hosts may supply only a provider; that compatibility
path remains bounded but does not provide the production fallback ladder.

Consequential analysis can prefer the optional Council API:

```ts
const result = await api.llm.council?.('Which migration risk is most urgent?', {
  profile: 'risk-review',
  context: boundedEvidence,
});
```

Council is deliberately optional. A plugin using it must degrade to
`api.llm.complete()` and then to a deterministic result when Council is absent,
cancelled, fails, or returns an invalid answer.

Built-in consumers (all opt-in, all fall back to non-LLM behavior on any
failure):

| Plugin | Flag | Engine | What it does |
|---|---|---|---|
| `auto-doc` | `useLlm` / `use_llm` | One Shot | Writes real doc-comment prose instead of `TODO:` placeholders |
| `git-autocommit` | `generate` / `useLlm` | One Shot | Writes the conventional commit message from the staged diff |
| `session-recap` | `aiSummary` | One Shot | Prepends a natural-language session summary to the recap |
| `error-lens` | `aiHints` | One Shot | Produces a one-line fix hint on each new failure digest |
| `changelog-writer` | `polish` | One Shot | Rewrites entries into user-facing release-notes wording |
| `commit-validator` | `suggestFix` | One Shot | Suggests a corrected conventional-commit subject after deterministic validation |
| `dep-guard` | `confirmTyposquatsWithLlm` | Council → One Shot | Reviews a package name already flagged by deterministic similarity checks |
| `migration-planner` | `useLlm` / `use_llm` | Council → One Shot | Adds separate evidence-bounded risk and verification analysis |
| `pr-drafter` | `aiSummary` | One Shot | Writes a PR title and narrative from session facts |
| `release-notes-generator` | `useLlm` / `use_llm` | One Shot | Polishes wording only when every short commit hash is preserved |
| `test-generator` | `useLlm` / `use_llm` | One Shot | Authors behavior-focused tests from bounded source context |
| `wstack-prompts` | `/prompts extend` | One Shot | Extends a saved prompt through the scoped plugin LLM API |

Every consumer is guarded on `api.llm` and honors the per-plugin
`extensions[<name>].llm` provider/model override. Plugins that expose
optional generation declare `capabilities.llm: true`; this is an audit/UX
signal, not permission to require an LLM. The deterministic path must stay
usable when `api.llm` is absent, cancelled, fails, or returns invalid output.

---

## Capabilities — declare what you touch

```ts
capabilities: {
  tools: true,
  providers: false,
  slashCommands: true,
  mcp: false,
  llm: true, // this plugin may call api.llm, but still has a non-LLM fallback
  pipelines: ['request', 'toolCall'],
}
```

The loader uses this for diagnostics (`wstack plugin list` shows what
each plugin contributes) and for warning when a plugin calls
`api.tools.register()` without declaring `tools: true` (L0-D check).
Capabilities are advisory — they do not block at runtime — but lying is
loud and reviewers will catch it.

---

## Dependencies

```ts
dependsOn: [
  'wstack-auth',                              // string form
  { name: 'wstack-router', version: '^1.2' }, // structured form
],
optionalDeps: [{ name: 'wstack-cache', version: '^0.5' }],
conflictsWith: ['wstack-other-router'],
```

The loader topologically sorts plugins by `dependsOn`, rejects cycles
with a clear error, and surfaces version mismatches before calling
`setup`. Missing `optionalDeps` are silently skipped.

---

## Config schema

Plugin options come from either `plugins[].options` or
`extensions[<name>]`. `extensions[<name>]` wins when both are present. Declare
a `configSchema` and the loader validates the merged options before calling
`setup`:

```ts
configSchema: {
  type: 'object',
  properties: {
    endpoint: { type: 'string' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 60_000 },
  },
  required: ['endpoint'],
},
```

Reach validated options at runtime via `api.config.extensions[name]`. A
validation failure aborts plugin load with `error.path` pointing at the
offending field.

---

## Patterns by concern

### Register a tool

```ts
api.tools.register({
  name: 'greet',
  description: 'Greet someone',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  permission: 'auto',
  mutating: false,
  riskTier: 'safe',
  async execute(input) {
    return { msg: `Hi, ${input.name}` };
  },
});
```

See [tool-author-guide.md](tool-author-guide.md) for the full Tool contract
(streaming, cleanup, permission semantics).

### Register a provider factory

```ts
import { WireFormatProvider } from '@wrongstack/providers';
import { myWireFormat } from './my-wire-format.js';

api.providers.register({
  type: 'my-llm',
  family: 'openai-compatible',
  create: (cfg) => {
    const c = cfg as { apiKey: string; baseUrl?: string };
    return new WireFormatProvider(myWireFormat, {
      apiKey: c.apiKey,
      baseUrl: c.baseUrl,
    });
  },
});
```

See [provider-author-guide.md](provider-author-guide.md) for writing the
`myWireFormat` config and for cases that genuinely need a custom provider
class.

### Add middleware to a pipeline

```ts
api.pipelines.request.use({
  name: 'inject-headers',
  owner: 'my-plugin',           // shown in /diag, used by host error policy
  handler: async (req, next) => {
    (req as { headers?: Record<string, string> }).headers = {
      ...(req as any).headers,
      'x-tenant': api.config.extensions?.['my-plugin']?.tenant ?? 'default',
    };
    return next(req);
  },
});
```

Throwing from a handler bubbles up unless the host installed a boundary
(`Pipeline.setErrorHandler`). The CLI installs a default boundary at boot
that surfaces the failure to `/diag` but doesn't crash the agent (L1-F).

### Subscribe to events

```ts
api.onEvent('tool.executed', (e) => {
  api.log.info(`${e.name} ran in ${e.durationMs}ms`);
});
```

The listener is removed when the plugin is unloaded. For long-lived
external state, do the cleanup in `teardown`.

### Register a slash command

```ts
api.slashCommands.register({
  name: 'tenant',
  description: 'Switch active tenant',
  async execute({ args, ctx }) {
    ctx.meta.tenant = args.join(' ') || 'default';
    return { message: `Tenant set to ${ctx.meta.tenant}` };
  },
});
```

### Start an MCP server

```ts
await api.mcp.start({
  name: 'my-mcp',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@me/my-mcp-server'],
  enabled: true,
});
```

The registry handles reconnect-with-backoff and tools/list_changed
invalidation; you don't need to manage either yourself.

### Agent lifecycle hooks

Plugins can hook into every phase of the agent run via `api.extensions.register()`:

```ts
api.extensions.register({
  name: 'my-plugin-hooks',
  beforeRun: async (ctx, input) => { /* before iteration loop starts */ },
  afterRun: async (ctx, result) => { /* after run finishes */ },
  beforeIteration: async (ctx, idx) => { /* start of each iteration */ },
  afterIteration: async (ctx, idx) => { /* end of each iteration */ },
  onError: async (ctx, err, phase, idx) => {
    return { action: 'retry' }; // or 'fail' | 'continue'
  },
  wrapProviderRunner: async (ctx, req, inner) => {
    // wrap/replace the provider call
    return inner(ctx, req);
  },
  beforeToolExecution: async (ctx, toolUses) => {
    // filter or reorder tools before execution
    return toolUses;
  },
  afterToolExecution: async (ctx, outputs) => { /* inspect results */ },
});
```

Each hook is optional. Failures are caught and logged — one bad hook
never crashes the agent.

### Inject context into the system prompt

```ts
api.registerSystemPromptContributor(async (ctx) => [
  { type: 'text', text: '## My Plugin Context\nCurrent state: ...' },
]);
```

Contributors fire on every `build()` call, so the prompt stays current
across turns. The host's `DefaultSystemPromptBuilder` must have
`contributors` wired (the CLI does this automatically when plugins pass
`api.extensions`).

### Write custom session events

Plugins can persist events to the JSONL session log:

```ts
await api.session.append({
  type: 'my-plugin:cache_hit',
  ts: new Date().toISOString(),
  key: 'user-123',
  latencyMs: 2.4,
});
```

Custom events are serialized verbatim next to built-in events
(`user_input`, `tool_result`, etc.). The `ts` field is required;
everything else is free-form.

### Record metrics (Prometheus / OTLP)

```ts
api.metrics.counter('cache_hits', 1, { tier: 'l1' });
api.metrics.histogram('cache_latency_ms', 42.5);
api.metrics.gauge('cache_size', 142);
```

Metric names are auto-prefixed with `plugin.<pluginName>.` so they
don't collide across plugins. Values flow to the host's `MetricsSink`
— `InMemoryMetricsSink` (CLI), Prometheus, or OTLP. A noop sink is
used when metrics are disabled.

### Subscribe to config changes

```ts
api.onConfigChange((next, prev) => {
  this.ttl = next.plugins?.['my-plugin']?.ttl ?? 3600;
});
```

Fires when `ConfigStore.update()` is called (e.g., via `/config` slash
command). Use this instead of caching `api.config` values at `setup` time.

### Decorate (wrap) existing tools

```ts
api.tools.wrap('bash', (original) => ({
  ...original,
  permission: 'confirm',          // tighter permission
  riskTier: 'destructive',        // raw shell is powerful; policy gates clearly destructive commands even in YOLO
  async execute(input, ctx, opts) {
    api.log.info('bash called with', input);
    return original.execute(input, ctx, opts);
  },
}));
```

Multiple wraps stack — each wrapper receives the output of the previous.

### Emit custom events

```ts
api.emitCustom('my-plugin:state_changed', { state: 'active' });
```

Custom events flow through the same `EventBus` as built-in events.
Use `pluginName:eventName` convention to avoid collisions. Other
plugins (and the host) can subscribe via `events.on` or `api.onEvent`.

### Wildcard event subscriptions

```ts
api.onPattern('tool.*', (name, payload) => {
  api.log.info(`Tool event: ${name}`, payload);
});
```

Matches `tool.started`, `tool.executed`, `tool.progress`, etc.
`'*'` matches every event. `onPattern` listeners are auto-removed on
teardown.

### Bulk tool registration

```ts
api.tools.registerAll([toolA, toolB, toolC], 'my-plugin');
```

Conflicts are silently skipped. Use `registerAllOrThrow` on the raw
`ToolRegistry` if you need strict registration.

### Tool categories

```ts
api.tools.register({
  name: 'cache_stats',
  category: 'Cache',         // ← groups tools in the system prompt
  // ...
});
```

Tools are listed by category in the system prompt:
```
### Cache
- **cache_stats** — Show cache statistics
- **cache_clear** — Clear the cache
```

### Plugin defaults and health

```ts
const plugin: Plugin = {
  name: 'my-plugin',
  defaultConfig: { ttl: 3600, maxEntries: 100 },  // merged before setup
  configSchema: { /* validates merged config */ },
  async health() {
    return { ok: this.connected, message: 'Redis: connected' };
  },
  // ...
};
```

`defaultConfig` is shallow-merged with user config before `configSchema`
validation. `health()` is exposed via `/diag plugins` for diagnostics.

### Capabilities enforcement (strict mode)

Set `enforceCapabilities: true` in `loadPlugins` options to make the
loader THROW (instead of logging a warning) when a plugin calls an API
method not declared in its `capabilities`:

```ts
await loadPlugins(plugins, {
  enforceCapabilities: true,  // strict mode — lying = load failure
  // ...
});
```

---

## Teardown contract

`teardown(api)` runs on:

- `SIGINT` from the user
- Natural process exit
- When the loader unloads the plugin individually (rare)

Inside it: stop intervals, kill subprocesses, close handles, flush
buffered writes. Errors thrown from `teardown` are logged but do not
prevent other plugins from tearing down. Make every cleanup
best-effort.

`teardown` is wrapped in a **10-second timeout** (configurable via
`loadPlugins({ teardownTimeoutMs: ... })`). If your cleanup logic is
slow (e.g., a remote flush), split it into a fast critical path that
synchronously closes handles and a background path that fires and forgets
the slow part.

```ts
async teardown(api) {
  clearInterval(this.heartbeat);
  await this.subprocess?.kill();
  api.log.info('shut down cleanly');
},
```

For resources tied to a single agent run (not the whole plugin lifetime),
use `ctx.registerAbortHook` from inside `Tool.execute` instead. See the
JSDoc on [`Tool.cleanup`](../packages/core/src/types/tool.ts) for the rule.

---

## Testing your plugin

Plugins are plain TS modules with a default export. Test them by
constructing a real (or stub) `PluginAPI` and asserting the side
effects:

```ts
import { describe, it, expect, vi } from 'vitest';
import { Container, EventBus, ToolRegistry } from '@wrongstack/core';
import myPlugin from '../src/index.js';

describe('my-plugin', () => {
  it('registers the greet tool', async () => {
    const tools = new ToolRegistry();
    const api: any = {
      container: new Container(),
      events: new EventBus(),
      tools,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: {},
      onEvent: () => () => {},
      pipelines: {},
      providers: { register: vi.fn(), create: vi.fn(), list: () => [] },
      mcp: { start: vi.fn(), stop: vi.fn(), restart: vi.fn(), list: () => [] },
      slashCommands: { register: vi.fn(), unregister: vi.fn(), get: vi.fn(), list: () => [] },
    };

    await myPlugin.setup(api);
    expect(tools.get('greet')).toBeDefined();
  });
});
```

For richer integration tests, use the fixtures in
[`packages/core/tests/plugin/`](../packages/core/tests/plugin/) which
exercise the loader, capability warning, teardown, and dependency cycle
detection paths.

---

## Common pitfalls

- **`apiVersion` mismatch.** The loader compares your declared range against
  `KERNEL_API_VERSION`. Off-by-one bumps fail loud — fix the range.
- **Mutating `api.config`.** Treat it as a frozen snapshot. To react to
  config changes at runtime, subscribe via `api.container.resolve(TOKENS.ConfigStore).watch(...)`.
- **Forgetting `teardown` for sockets / timers.** The process won't exit cleanly.
- **Throwing from `setup`.** Aborts the entire CLI boot. If your plugin can't
  function with the current config, log and return early — don't throw.
- **Registering inside a pipeline handler.** Registries are not append-safe
  during iteration. Do registrations only in `setup`.
- **`setup` or `teardown` hangs.** Both are wrapped in timeouts (30 s / 10 s).
  If you have genuinely slow startup (e.g., establishing a remote connection),
  do it asynchronously after `setup` returns, and handle the timeout in your
  own code by listening to the `AbortSignal` passed as `setup(api, { signal })`.

## Security Considerations for Plugin Authors

> ⚠️ **First read:** [Isolation Model — In-Process Only](#isolation-model--in-process-only) above.
> WrongStack plugins run in the same process as the host with full privileges.
> Only install plugins from sources you trust.

Plugins run with significant power (they can register tools, wrap existing tools,
register slash commands, contribute pipelines, and load MCP servers).

### Security checklist for plugins

- [ ] **Capability declaration** — Be honest in `capabilities`. Over-declaring is better than under-declaring.
- [ ] **Tool mutation** — External (non-official) plugins can only `wrap`/`unregister` tools they solely own. Attempting to downgrade a built-in will throw (see `packages/core/src/plugin/api.ts`).
- [ ] **MCP servers** — Loading an MCP server means proxying arbitrary tools from that server. This has major subagent impact (most `mcp__*` tools are blocked for subagents by default).
- [ ] **Pipeline middleware** — Middleware runs on every request/response. Be extremely careful with mutation and performance.
- [ ] **Secret access** — Plugins should almost never need direct access to the secret vault. Use the provided abstractions.

Adding a plugin that grants new powerful capabilities (especially shell, arbitrary FS write, or MCP proxying) should be treated as a security-sensitive change.

See `docs/plans/security-hardening-2026-06.md` (P2) and `SECURITY.md`.

---

## Reference

- Plugin type: [`packages/core/src/types/plugin.ts`](../packages/core/src/types/plugin.ts)
- Loader: [`packages/core/src/plugin/loader.ts`](../packages/core/src/plugin/loader.ts)
- Test fixtures: [`packages/core/tests/plugin/`](../packages/core/tests/plugin/)
