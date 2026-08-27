import type { EventBus } from '@wrongstack/core/kernel';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type {
  AutoThinConfig,
  ConcreteTokenSavingTier,
  DisabledToolMeta,
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
import { createVectorMemoryTools, type VectorMemoryStore } from '@wrongstack/vector-memory';
import { wireKanbanPorts } from './kanban-ports.js';

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
   * Optional vector memory store. When provided, the four
   * `vector_memory_*` tools (remember/search/stats/forget) are registered
   * alongside the SAGE tools under the `vector-memory` namespace. When
   * omitted the registry stays unchanged from the SAGE-only surface.
   *
   * The vector store is independent of SAGE — its own SQLite file under
   * `.wrongstack/vector-memory/`. Failures during search (e.g. the
   * transformers.js backend is unavailable) are swallowed at the store
   * layer and return empty results, so registration is safe even when
   * the embedding model is not yet cached.
   */
  vectorMemory?: { store: VectorMemoryStore } | undefined;
  /**
   * Opt-in `nextsteps` tool (`tools.nextsteps.enabled`). Off unless the host
   * explicitly enables it, so the default surface is unchanged and the leader
   * keeps producing `<nextsteps>` the way it always has.
   */
  nextSteps?: { enabled: boolean } | undefined;
  descriptionMode?: ToolDescriptionModeConfig | undefined;
  resultRenderMode?: ToolResultRenderModeConfig | undefined;
  disabledTools?: readonly string[] | undefined;
  /**
   * Audit-trail metadata for `disabledTools` — written by `/tool autothin
   * apply` and consumed by `boot-time auto-thin` so the decision survives
   * restarts. Pair with `disabledTools`: the names live in both, the
   * `reason`/`at` lives here.
   */
  disabledToolMeta?: Readonly<Record<string, DisabledToolMeta>> | undefined;
  /**
   * Stats-driven tool auto-thinning policy (`tools.autoThin`). When provided,
   * the host's boot-time auto-apply uses it to disable underused tools.
   * Pair with `events` so the registry can emit `tool.thinned`.
   */
  autoThin?: AutoThinConfig | undefined;
  /**
   * EventBus the registry should publish `tool.thinned` on. Optional —
   * `thinUnderused()` is a no-op (with a warning) if the registry has no
   * bus. Hosts that wire `wireMetricsToEvents` already have one.
   */
  events?: EventBus | undefined;
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
  // Composition-root wiring (#11): core's kanban ports must be live before
  // any tool can run; the governance port fires on every tool call. Idempotent,
  // so every host boot path (CLI, WebUI, MCP, ACP) can call it safely.
  wireKanbanPorts();
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

  // Vector memory is a sibling surface, not a replacement for SAGE —
  // register it independently so callers get both lexical (SAGE) and
  // semantic (transformers.js) retrieval paths side-by-side.
  if (options.vectorMemory?.store) {
    options.registry.registerAllOrThrow(
      createVectorMemoryTools(options.vectorMemory.store),
      'vector-memory',
    );
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
  if (options.events) options.registry.setEventBus(options.events);
  if (options.disabledTools) options.registry.applyDisabled([...options.disabledTools]);
  if (options.disabledToolMeta) options.registry.applyDisabledMeta(options.disabledToolMeta);

  return { builtinTools, memoryBackend };
}
