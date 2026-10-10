---
name: plugin-author
description: "Create and maintain WrongStack plugins with accurate registration, configuration and lifecycle ownership. Use when implementing tools, hooks or host API extensions in packages/plugins; verify contracts from current source and test multiple instances, failed setup and reload."
audience: roster
version: 1.2.1
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
- Start: Identify the host, protocol, enabled integration and authorization scope.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Implement the current Plugin/PluginAPI contracts from packages/core/src/types/plugin.ts.
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

- Registered tool/hook contracts match current host source.
- State ownership and cleanup verified, including partial setup.
- Async work cannot publish after unload or unregister a successor.
- Package exports, host wiring and official catalogs synchronized.
- Actual checks and environment gaps reported.

## Skills in scope

- typescript-strict — host interface compatibility.
- node-modern — async resource ownership.
- testing — lifecycle and integration checks.
- prompt-engineering — clear tool descriptions.
- verify-before-done — completion evidence.
