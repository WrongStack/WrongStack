# @wrongstack/core

Kernel, types, and default implementations that drive the WrongStack CLI agent.

This package has no `bin`. It's a library you'd depend on if you were building a plugin, embedding the agent in another tool, or replacing one of the default implementations (a custom session store, a stricter permission policy, your own retry strategy).

If you're just using WrongStack from the terminal, install [`wrongstack`](../../README.md) instead.

## Install

```bash
pnpm add @wrongstack/core
```

Requires **Node.js ≥ 22.19.0**.

## What's in here

```
src/
  core/         — Agent, Context, ConversationState, ProviderRunner, InputBuilder
  defaults/     — Production-ready implementations (session store, secret vault, …)
  kernel/       — Container, TOKENS, EventBus, ScopedEventBus, Pipeline, RunController
  plugin/       — Plugin loader, PluginAPI, manifest validation
  registry/     — SlashCommandRegistry, ToolRegistry, ProviderRegistry
  types/        — Public type surface (Tool, Provider, SessionStore, …)
  utils/        — wstack-paths, safe-json, deterministic-stringify, lru-cache
```

## Quick example

The kernel is the small set of primitives the agent is built on. You can use them
standalone — for instance, to wire a small observability pipeline around a tool call:

```ts
import {
  Container,
  EventBus,
  Pipeline,
  RunController,
  TOKENS,
  DefaultLogger,
  DefaultPermissionPolicy,
} from '@wrongstack/core';

// 1. DI container — bind defaults to TOKENS, override per token.
const container = new Container();
container.bind(TOKENS.Logger, () => new DefaultLogger());
container.bind(TOKENS.PermissionPolicy, () => new DefaultPermissionPolicy());

// 2. Typed event bus — observe, don't mutate. Listener errors are isolated
//    and routed to the optional logger; one bad subscriber can't kill emit().
const events = new EventBus();
events.on('tool.executed', ({ name, durationMs }) => {
  console.log(`tool ${name} ran in ${durationMs}ms`);
});

// 3. Koa-style pipeline — chain middleware around a value. The error
//    boundary decides per-middleware whether to rethrow or swallow, so
//    one bad plugin can't take down the agent loop.
type Req = { url: string };
const requestLog = new Pipeline<Req>();
requestLog.use({
  name: 'timing',
  handler: async (req, next) => {
    const start = Date.now();
    const res = await next(req);
    console.log(`${req.url} took ${Date.now() - start}ms`);
    return res;
  },
});
requestLog.setErrorHandler(() => 'swallow');

// 4. Abort + cleanup — hooks fire in LIFO order on abort OR dispose().
const run = new RunController();
const off = run.onAbort(() => console.log('cleaning up'));
// later, when the run ends:  await run.dispose();
```

For a full agent loop with a real LLM provider and tools, see
[`packages/cli/src/wiring/pipeline.ts`](../cli/src/wiring/pipeline.ts) — the
`Agent` constructor needs a `ToolExecutor`, `ProviderRegistry`, and several
container-resolved policies, which the CLI assembles from the user's config.

## Replacing a default

Every concrete class under `defaults/` implements an interface in `types/`. The container resolves by token, so swapping is a one-line change:

```ts
import { TOKENS } from '@wrongstack/core';

class StrictPolicy implements PermissionPolicy {
  async check(tool, input, ctx) {
    if (tool.name === 'bash') return { decision: 'deny', reason: 'no shell' };
    return { decision: 'allow' };
  }
}

container.bind(TOKENS.PermissionPolicy, () => new StrictPolicy());
```

The same pattern works for `SessionStore`, `MemoryStore`, `SystemPromptBuilder`, `RetryPolicy`, `ErrorHandler`, `TokenCounter`, `SecretScrubber`, `Compactor`, `ConfigStore`, `ModelsRegistry`, `ModeStore`. (`SecretVault` isn't container-resolved — pass it to `ConfigLoader` instead.)

## Building a tool

```ts
import type { Tool } from '@wrongstack/core';

export const echoTool: Tool<{ text: string }, string> = {
  name: 'echo',
  description: 'Echo a string back.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  permission: 'auto',
  mutating: false,
  async execute(input) {
    return input.text;
  },
};
```

See [docs/tool-author-guide.md](../../docs/tool-author-guide.md) for the full contract (`subjectKey`, `executeStream`, `cleanup`, abort handling, output bounds).

## Building a provider

Most providers can ride the declarative wire-format adapter — see [`@wrongstack/providers`](../providers). For direct implementation, see [docs/provider-author-guide.md](../../docs/provider-author-guide.md).

## Building a plugin

```ts
import type { Plugin } from '@wrongstack/core';

export default {
  name: 'my-plugin',
  version: '1.0.0',
  capabilities: { tools: true, slashCommands: true },
  async setup(api) {
    api.registerTool(myTool);
    api.registerSlashCommand({ name: 'my-cmd', description: '…', run: async () => {} });
  },
} satisfies Plugin;
```

See [docs/plugin-author-guide.md](../../docs/plugin-author-guide.md).

## Path layout

All developer-level state lives under `~/.wrongstack/`. Per-project state is keyed by `sha256(absoluteProjectRoot).slice(0,12)` under `~/.wrongstack/projects/<hash>/`. The only thing inside the project tree itself is the optional, committable `.wrongstack/AGENTS.md` and `.wrongstack/skills/`. See `WstackPaths` in [utils/wstack-paths.ts](src/utils/wstack-paths.ts) for the full layout.

## Security model

See [SECURITY.md](../../SECURITY.md) at the repo root for the threat model, adversary trust assumptions, and the catalog of controls (SSRF defenses, child-env sanitization, secret vault, prompt-injection assumptions for LLM-generated tool inputs).

## License

MIT
