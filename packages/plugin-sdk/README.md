# @wrongstack/plugin-sdk

Authoring SDK for [WrongStack](../../README.md) plugins. Third-party plugin
authors should depend on **this package only** — it exposes the plugin
contract, the `definePlugin` helper, and the same audit-hardened runtime
helpers the built-in plugins use.

```bash
npm install @wrongstack/plugin-sdk
```

## Minimal plugin

```ts
import { definePlugin } from '@wrongstack/plugin-sdk';

export default definePlugin(
  {
    name: 'wstack-plugin-hello',
    version: '1.0.0',
    description: 'Greets the team',
    capabilities: { tools: true },
    defaultConfig: { greeting: 'hello' },
  },
  async (api, options) => {
    api.tools.register({
      name: 'hello_greet',
      description: `Say ${options.greeting} to someone`,
      inputSchema: {
        type: 'object',
        properties: { who: { type: 'string' } },
        required: ['who'],
      },
      permission: 'auto',
      riskTier: 'safe',
      async execute(input) {
        return { greeting: `${options.greeting}, ${input.who}!` };
      },
    });
  },
);
```

`definePlugin` injects the current `KERNEL_API_VERSION` for you. If you
write the plugin object by hand instead, declare the contract version
your plugin was built against:

```ts
import { KERNEL_API_VERSION } from '@wrongstack/plugin-sdk';

export const plugin = {
  name: 'wstack-plugin-hello',
  apiVersion: '^0.1', // keep loading across additive host releases
  // ...
  async setup(api) {},
};
```

## What's in the box

| Import | Purpose |
|---|---|
| `definePlugin` | Typed authoring helper (infers options, injects `apiVersion`) |
| `KERNEL_API_VERSION` | The host's plugin contract version |
| `Plugin`, `PluginAPI`, `PluginCapabilities`, … | The full plugin contract types |
| `HookEvent`, `HookOutcome`, `InProcessHook`, … | Lifecycle hook types (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`) |
| `AgentExtension`, `ProviderRunnerWrapper`, … | Agent-loop extension point types |
| `Tool`, `EventName`, `Config`, `ConfigStore` | Registry, event, and config types |
| `@wrongstack/plugin-sdk/runtime` | Bounded collections, `releaseHandles`, sandboxed paths (`safePath`, `isInsideProject`), ReDoS guards (`withReDoSGuard`), safe runner spawning (`resolveRunnerCommand`, `runRunnerCommand`), optional-LLM helpers (`runOptionalPluginLlm`, `runOptionalPluginCouncil`) |

## Versioning

The SDK tracks the host's **plugin contract** (`KERNEL_API_VERSION`), not the
host package version. Pin `apiVersion: '^0.1'` for additive compatibility;
the host refuses plugins whose declared range no longer satisfies the kernel
(see `docs/plugin-third-party.md` in the repository for the compatibility
policy and release checklist).

## Loading your plugin in WrongStack

```bash
# register an npm-installed package (installs into ~/.wrongstack/plugins,
# scripts disabled by default for supply-chain safety)
wstack plugin add wstack-plugin-hello --install

# or point at local code during development
wstack plugin add ./my-plugin          # writes { name, path } into config.plugins
```

External plugins run in-process with full host privileges. On first load the
host pins a SHA-256 of your plugin's entry file
(`~/.wrongstack/plugin-trust.json`); after an update, users re-confirm with
`wstack plugin trust <name>`. See `docs/plugin-author-guide.md` for the full
isolation and capability-enforcement model.
