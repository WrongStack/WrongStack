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

import type {
  EventBus,
  MemoryStore,
  ToolDescriptionModeConfig,
  ToolRegistry,
  ToolResultRenderModeConfig,
  WstackPaths,
} from '@wrongstack/core';
import { applyToolDescriptionModes, applyToolResultRenderModes, createContextManagerTool, makeMailboxTool, makeMailInboxTool, makeMailSendTool, normalizeTokenSavingTier } from '@wrongstack/core';
import { builtinToolsPack, configureDangerBypass, configureExecPolicy, forgetTool, relatedMemoryTool, rememberTool, searchMemoryTool, TIER1_TOOLS, TIER2_TOOLS, TIER3_TOOLS } from '@wrongstack/tools';
import { configureAutophasePolicy } from '../autophase-host.js';
import type { TokenSavingTier } from '@wrongstack/core';
import type { Tool } from '@wrongstack/core';

export interface RegisterBuiltinToolsDeps {
  toolRegistry: ToolRegistry;
  compactor: unknown;
  config: {
    features: { memory: boolean; tokenSavingMode?: TokenSavingTier | boolean | undefined };
    tools?:
      | {
          descriptionMode?: ToolDescriptionModeConfig | undefined;
          resultRenderMode?: ToolResultRenderModeConfig | undefined;
          disabledTools?: string[] | undefined;
          exec?:
            | {
                allow?: string[] | undefined;
                deny?: string[] | undefined;
                danger?: { bypass?: string[] | undefined } | undefined;
              }
            | undefined;
        }
      | undefined;
  };
  memoryStore: MemoryStore | null | undefined;
  events: EventBus;
  wpaths: Pick<WstackPaths, 'projectDir'>;
}

/**
 * Returns the tool subset for the given token-saving tier.
 * @see getToolsForTier in `wiring/tools.ts` — kept in sync
 */
function toolsForTier(tier: TokenSavingTier, allTools: Tool[]): Tool[] {
  switch (tier) {
    case 'off':
      return allTools;
    case 'minimal':
    case 'light':
      return TIER1_TOOLS;
    case 'medium':
      return [...TIER1_TOOLS, ...TIER2_TOOLS];
    case 'aggressive': {
      const t2WithoutTask = TIER2_TOOLS.filter((t) => t.name !== 'task');
      const t3WithoutSetCwd = TIER3_TOOLS.filter((t) => t.name !== 'setWorkingDir');
      return [...TIER1_TOOLS, ...t2WithoutTask, ...t3WithoutSetCwd];
    }
  }
}

/**
 * Register the inline tool set: context manager + memory
 * tools (if features.memory) + mailbox tools. The mailbox
 * tools are always registered \u2014 they are needed for
 * inter-agent coordination regardless of the per-session
 * memory feature flag.
 */
export function registerBuiltinTools(deps: RegisterBuiltinToolsDeps): void {
  // Bulk register the builtin tool pack. Token-saving tier determines which
  // tools are included (see `toolsForTier`).
  const tier = normalizeTokenSavingTier(deps.config.features.tokenSavingMode);
  const allTools = builtinToolsPack.tools ?? [];
  const toolsToRegister = toolsForTier(tier, allTools);
  deps.toolRegistry.registerAllOrThrow([...toolsToRegister], builtinToolsPack.name);

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
  applyToolDescriptionModes(deps.toolRegistry, deps.config.tools?.descriptionMode);
  // Apply on-screen result render modes. Independent of descriptionMode —
  // the user can toggle one without affecting the other via `/tool <name>
  // desc simple|extend` and `/tool <name> result simple|extend`. The
  // legacy `/tool <name> simple` writes both at once.
  applyToolResultRenderModes(deps.toolRegistry, deps.config.tools?.resultRenderMode);
  // Apply disabled tools from config. Tools not yet registered are silently
  // skipped — the registry's disable() returns false for unknown names, which
  // is fine: the tool will be registered later (e.g. MCP / plugin tools) and
  // we apply the disabled list after every registration batch anyway.
  if (deps.config.tools?.disabledTools) {
    deps.toolRegistry.applyDisabled(deps.config.tools.disabledTools);
  }
  // Apply the configured exec command policy (DEFAULT ∪ allow − deny). `allow`
  // is trusted-config-only — the config loader strips `tools.exec.allow` from
  // any in-project repo config before this point.
  configureExecPolicy(deps.config.tools?.exec ?? {});
  configureDangerBypass(deps.config.tools?.exec?.danger ?? {});
  // Autonomous autophase verification honors the same trusted exec.allow opt-ins
  // (added to autophase's narrower base), so non-JS projects (go/cargo/…) can
  // run their verify command without confirmation when the user allowed it.
  configureAutophasePolicy(deps.config.tools?.exec ?? {});
}
