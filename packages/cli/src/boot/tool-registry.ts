// PR 6 of Issue #29: extract the inline tool-registry
// construction (the 18-line block that runs immediately
// after the SystemPromptBuilder binding) into a single
// helper.
//
// Why this split:
//
//   - The tool registry bring-up is the *single largest*
//     contiguous import-and-wire block in main() that
//     does not depend on anything other than the container
//     and the runtime config. Extracting it makes the
//     boot sequence scannable: each line of main() becomes
//     a single "phase done, next phase" call.
//
//   - The memory / mailbox / mail_send / mail_inbox
//     registrations are the *only* consumers of
//     `config.features.memory` and the runtime events
//     bus. Lifting them into a helper means a future
//     "always register mailbox" config flag is a single
//     touchpoint, not a 4-place edit through main().
//
//   - The helper takes the tool registry, the feature
//     flags, the memory store, the events bus, and the
//     project directory as inputs. The tool-registry
//     concrete class is passed in (not created) so the
//     helper is a *registration* helper, not a
//     *factory* helper \u2014 a future refactor that wants
//     to inject a different ToolRegistry implementation
//     (e.g. for tests) doesn't need to touch the helper.
//
// What is *not* in this helper:
//
//   - The `compactor` registration. The compactor is
//     resolved from the container at registration time,
//     and lifting the resolve into the helper would force
//     the helper to know about the container's specific
//     tokens. Instead, the caller passes the compactor as
//     `compactorInstance`.
//
//   - The metrics wiring. That is a separate concern
//     (extracted to `wiring/metrics.ts` already) and is
//     not a tool-registry concern.

import type { EventBus, MemoryStore, ToolRegistry, WstackPaths } from '@wrongstack/core';
import { createContextManagerTool, makeMailboxTool, makeMailInboxTool, makeMailSendTool } from '@wrongstack/core';
import { builtinToolsPack, forgetTool, relatedMemoryTool, rememberTool, searchMemoryTool } from '@wrongstack/tools';

export interface RegisterBuiltinToolsDeps {
  toolRegistry: ToolRegistry;
  compactor: unknown;
  config: { features: { memory: boolean } };
  memoryStore: MemoryStore | null | undefined;
  events: EventBus;
  wpaths: Pick<WstackPaths, 'projectDir'>;
}

/**
 * Register the inline tool set: context manager + memory
 * tools (if features.memory) + mailbox tools. The mailbox
 * tools are always registered \u2014 they are needed for
 * inter-agent coordination regardless of the per-session
 * memory feature flag.
 */
export function registerBuiltinTools(deps: RegisterBuiltinToolsDeps): void {
  // Bulk register the builtin tool pack. The
  // `registerAllOrThrow` call is intentional: a malformed
  // pack is a boot-time failure, not a runtime one.
  deps.toolRegistry.registerAllOrThrow(
    [...(builtinToolsPack.tools ?? [])],
    builtinToolsPack.name,
  );

  // Context manager tool: the model uses this to
  // prune/compact its own context window when full. The
  // compactor is resolved from the container at
  // registration time, so a swap to a different
  // compaction strategy at runtime doesn't require
  // re-registering the tool.
  deps.toolRegistry.registerDefault(
    createContextManagerTool({ compactor: deps.compactor as never }),
  );

  if (deps.config.features.memory && deps.memoryStore) {
    deps.toolRegistry.register(rememberTool(deps.memoryStore));
    deps.toolRegistry.register(forgetTool(deps.memoryStore));
    deps.toolRegistry.register(searchMemoryTool(deps.memoryStore));
    deps.toolRegistry.register(relatedMemoryTool(deps.memoryStore));
  }

  // Mailbox tools. The inter-agent mailbox is a
  // project-level concern (GlobalMailbox), so registration
  // is unconditional. The events bus is passed so the
  // mailbox tool can emit `agent_registered` /
  // `heartbeat` events that the TUI/WebUI subscribe to
  // for the status-bar online-agent count.
  deps.toolRegistry.register(
    makeMailboxTool({ projectDir: deps.wpaths.projectDir, events: deps.events }),
  );
  // High-affordance thin wrappers (mail_send / mail_inbox).
  // The explicit verbs are what makes agents use the
  // mailbox autonomously mid-task; without them, agents
  // only see the mailbox through the `mailbox` core
  // tool, which has a less discoverable API.
  deps.toolRegistry.register(
    makeMailSendTool({ projectDir: deps.wpaths.projectDir, events: deps.events }),
  );
  deps.toolRegistry.register(
    makeMailInboxTool({ projectDir: deps.wpaths.projectDir, events: deps.events }),
  );
}
