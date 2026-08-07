import type { ToolRegistry } from '@wrongstack/core/registry';
import type {
  ConcreteTokenSavingTier,
  MemoryPort,
  Tool,
  ToolDescriptionModeConfig,
  ToolResultRenderModeConfig,
} from '@wrongstack/core/types';
import { applyToolDescriptionModes, applyToolResultRenderModes } from '@wrongstack/core/utils';
import { createSageTools, getSageService } from '@wrongstack/sage';
import { nextStepsTool } from '@wrongstack/tools';
import {
  forgetTool,
  relatedMemoryTool,
  rememberTool,
  searchMemoryTool,
} from '@wrongstack/tools/memory';
import { registerBuiltinToolTier, selectBuiltinToolsForTier } from '@wrongstack/tools/tool-tier';

const DIRECT_LAZY_GATEWAYS = ['tool_search', 'tool_use', 'tool_help'] as const;

export interface CanonicalHostToolRegistrationOptions {
  registry: ToolRegistry;
  tier: ConcreteTokenSavingTier;
  contextTool?: Tool | undefined;
  coordinationTools?: readonly Tool[] | undefined;
  memory?:
    | {
        enabled: boolean;
        store?: MemoryPort | null | undefined;
      }
    | undefined;
  /**
   * Opt-in `nextsteps` tool (`tools.nextsteps.enabled`). Off unless the host
   * explicitly enables it, so the default surface is unchanged and the leader
   * keeps producing `<nextsteps>` the way it always has.
   */
  nextSteps?: { enabled: boolean } | undefined;
  descriptionMode?: ToolDescriptionModeConfig | undefined;
  resultRenderMode?: ToolResultRenderModeConfig | undefined;
  disabledTools?: readonly string[] | undefined;
}

export interface CanonicalHostToolRegistrationResult {
  builtinTools: readonly Tool[];
  memoryBackend: 'disabled' | 'legacy' | 'sage';
}

/**
 * Apply the production host tool composition in one deterministic order:
 * built-ins, context management, memory, coordination, then presentation and
 * disabled-tool policies.
 */
export function registerCanonicalHostTools(
  options: CanonicalHostToolRegistrationOptions,
): CanonicalHostToolRegistrationResult {
  // Keep the complete built-in catalog executable so tool_search/tool_use,
  // roster agents and runtime policy never point at an unregistered name.
  // Provider exposure is the independently bounded surface below.
  const catalogBuiltinTools = registerBuiltinToolTier({
    registry: options.registry,
    tier: 'off',
  });
  const builtinTools = selectBuiltinToolsForTier(options.tier, catalogBuiltinTools);

  if (options.contextTool) options.registry.registerDefault(options.contextTool);

  let memoryBackend: CanonicalHostToolRegistrationResult['memoryBackend'] = 'disabled';
  const memoryStore = options.memory?.store;
  if (options.memory?.enabled && memoryStore) {
    const Sage = getSageService(memoryStore);
    if (Sage) {
      options.registry.registerAllOrThrow(createSageTools(Sage), 'sage');
      // Roster and bundled skills use these backend-stable compatibility
      // names. SAGE has richer memory_search APIs, but must not silently make
      // the legacy search/related names disappear from an assigned tool slice.
      options.registry.registerAllOrThrow(
        [searchMemoryTool(memoryStore), relatedMemoryTool(memoryStore)],
        'sage-compatibility',
      );
      memoryBackend = 'sage';
    } else {
      options.registry.registerAllOrThrow(
        [
          rememberTool(memoryStore),
          forgetTool(memoryStore),
          searchMemoryTool(memoryStore),
          relatedMemoryTool(memoryStore),
        ],
        'legacy-memory',
      );
      memoryBackend = 'legacy';
    }
  }

  if (options.nextSteps?.enabled) options.registry.register(nextStepsTool);

  for (const tool of options.coordinationTools ?? []) options.registry.register(tool);

  if (options.tier !== 'off') {
    const directNames = new Set(builtinTools.map((tool) => tool.name));
    for (const name of DIRECT_LAZY_GATEWAYS) directNames.add(name);
    if (options.contextTool) directNames.add(options.contextTool.name);
    if (options.nextSteps?.enabled) directNames.add(nextStepsTool.name);
    for (const tool of options.coordinationTools ?? []) directNames.add(tool.name);
    if (options.memory?.enabled && memoryStore) {
      for (const name of ['remember', 'search_memory', 'memory_search']) {
        directNames.add(name);
      }
    }
    options.registry.setProviderToolNames([...directNames]);
  } else {
    options.registry.setProviderToolNames(undefined);
  }

  applyToolDescriptionModes(options.registry, options.descriptionMode);
  applyToolResultRenderModes(options.registry, options.resultRenderMode);
  if (options.disabledTools) options.registry.applyDisabled([...options.disabledTools]);

  return { builtinTools, memoryBackend };
}
