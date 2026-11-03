---
name: plugin-author
description: "WrongStack plugin authoring: register tools, hooks, slash commands and host API extensions with config and clean teardown. Use when implementing tools, hooks or host API extensions in packages/plugins; verify contracts from current source and test multiple instances, failed setup and reload."
audience: roster
version: 1.3.0
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "implementing tools, hooks or host API extensions in packages/plugins; verify contracts from current source and test multiple instances, failed setup and reload."
metadata:
  routing-group: integration
---

# Plugin Author — WrongStack

## Selection card
- Task: Author WrongStack plugin hooks and registration.
- Start: Read an existing plugin of the same kind and the Plugin and PluginAPI contracts it implements.
- Finish: The plugin loads, registers its surfaces, tears down cleanly, and its tests pass.

## Overview

Implement the current Plugin/PluginAPI contracts from packages/contracts/src/types/plugin.ts.
Plugin state must remain reachable for teardown and correctly scoped to its
owner; “put everything at module scope” is not a safe universal rule.

## Rules

1. Inspect a neighboring plugin, the loader, registration views and host wiring.
   Use actual API/schema defaults; derive plugin counts from the catalog.
2. Own timers, watchers, listeners, background promises and counters per instance
   or host. Use a factory/closure or API-keyed state where supported. Module
   singletons require evidence that instances cannot overlap.
3. Make setup/reload and teardown consistent with the host contract. Teardown
   releases every acquired resource, including partial setup and failure paths,
   and does not erase persistent user data.
4. Fence async completion by owner/generation after awaits. Cancel or ignore stale
   work after unload; fire-and-forget initialization still needs error handling.
5. Configure options under config.extensions[plugin-name] and validate them with
   the actual schema. Loading enablement and plugin options are distinct surfaces.
6. Register unique tool names and honest permissions/mutating metadata. Tool
   names are not guaranteed to exist on every minimal host; check optional APIs.

## Implementation contract

- Export the Plugin object with current name/version/apiVersion and capability
  declarations. Health reports real state; include teardown/health according to
  project conventions even for simple plugins.
- Tools have input schemas, precise descriptions, bounded results and explicit
  error behavior. Read the executor's current handling before choosing returned
  errors versus thrown validation/execution failures.
- Hooks use supported event/matcher/outcome shapes. Observational events cannot
  block an operation merely by returning a decision.
- Read optional api.llm/host features only after presence checks; route provider
  calls through host services instead of handling secret credentials directly.
- Unregister or restore only owned registrations/wrappers. A stale teardown must
  not remove a successor's tool or another plugin's hook.

## Skeleton

Shape only — copy apiVersion, config handling and helpers from a neighbouring
plugin, and re-read packages/contracts/src/types/plugin.ts before relying on a field.

~~~ts
import type { Plugin } from '@wrongstack/contracts/types';

export function createExamplePlugin(): Plugin {
  const disposers: Array<() => void> = []; // per instance, not module scope
  return {
    name: 'example',
    version: '0.1.0',
    apiVersion: '^0.1.10', // match the neighbours' current value
    capabilities: { tools: true, hooks: true },
    async setup(api, opts) {
      api.tools.register({
        name: 'example_count',
        description: 'Count lines in a project file. Read-only.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        permission: 'auto',
        mutating: false,
        async execute(input, ctx, { signal }) { /* bounded, abortable work */ },
      });
      disposers.push(() => api.tools.unregister('example_count'));
      disposers.push(api.registerHook('PostToolUse', 'edit', async () => undefined));
      disposers.push(api.onConfigChange(() => { /* re-read options */ }));
      opts?.signal?.addEventListener('abort', () => { /* stop partial setup */ });
    },
    async teardown() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
    async health() {
      return { ok: true };
    },
  };
}
~~~

Registration methods return disposers (`registerHook`, `onEvent`, `onPattern`,
`onConfigChange`, `registerSystemPromptContributor`); keep each one and call it in
teardown, newest first. Tool `permission` is `auto`, `confirm` or `deny`;
`mutating: true` for anything that writes, sends or spends.

## Integration

1. Implement under packages/plugins/src/<name>/ and add its named export.
2. Add the actual package subpath export. The official build driver discovers
   plugin entrypoints from the exports map.
3. Wire first-party factories through the current CLI plugin wiring when needed.
4. If extending PluginAPI, update types, implementation/init and host forwarding
   together; add consumer tests. Determine compatibility impact from the real API.
5. Use official manifest/catalog writers rather than manually updating generated
   plugin inventories.

## Validation

Cover registration, configuration errors, two hosts/instances when supported,
partial setup, repeated close, reload, cleanup after failure and stale completion.
Exercise real filesystem/command integration where the plugin owns that behavior.
Run project plugin test/typecheck/build commands and relevant host consumers.

## Before returning

- [ ] Registered tool, hook, and health contracts match current `packages/contracts/src/types/plugin.ts` source.
- [ ] Per-instance state ownership and teardown cleanup are verified, including partial setup and repeated close paths.
- [ ] Async background work is generation-fenced so unloaded instances cannot publish results or unregister a successor's hooks/tools.
- [ ] Package subpath exports, CLI host wiring, and official plugin catalogs are synchronized.
- [ ] Plugin lifecycle tests, typecheck, and build verification results (plus any environment gaps) are reported.

## Skills in scope

- `typescript-strict` — exact `Plugin` and `PluginAPI` type compatibility and schema narrowing
- `node-modern` — `AbortController`, timer cleanup, and async resource lifecycle ownership
- `testing` — multi-instance, failed-setup, reload, and stale-completion regression tests
- `prompt-engineering` — unambiguous tool descriptions and parameter constraints for model invocation
- `verify-before-done` — observable test, typecheck, and catalog verification before completion
