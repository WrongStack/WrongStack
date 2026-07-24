import type {
  ConcreteTokenSavingTier,
  MemoryPort,
  Tool,
  ToolDescriptionModeConfig,
  ToolResultRenderModeConfig,
} from '@wrongstack/core/types';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { applyToolDescriptionModes, applyToolResultRenderModes } from '@wrongstack/core/utils';
import { createSageTools, getSageService } from '@wrongstack/sage';
import {
  forgetTool,
  relatedMemoryTool,
  rememberTool,
  searchMemoryTool,
} from '@wrongstack/tools/memory';
import { registerBuiltinToolTier } from '@wrongstack/tools/tool-tier';

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
  const builtinTools = registerBuiltinToolTier({
    registry: options.registry,
    tier: options.tier,
  });

  if (options.contextTool) options.registry.registerDefault(options.contextTool);

  let memoryBackend: CanonicalHostToolRegistrationResult['memoryBackend'] = 'disabled';
  const memoryStore = options.memory?.store;
  if (options.memory?.enabled && memoryStore) {
    const Sage = getSageService(memoryStore);
    if (Sage) {
      options.registry.registerAllOrThrow(createSageTools(Sage), 'sage');
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

  for (const tool of options.coordinationTools ?? []) options.registry.register(tool);

  applyToolDescriptionModes(options.registry, options.descriptionMode);
  applyToolResultRenderModes(options.registry, options.resultRenderMode);
  if (options.disabledTools) options.registry.applyDisabled([...options.disabledTools]);

  return { builtinTools, memoryBackend };
}
