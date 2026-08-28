import * as path from 'node:path';
import { TOKENS } from '@wrongstack/core/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import type { VectorMemoryStore } from '@wrongstack/vector-memory';
import { bindSystemPromptBuilder } from '../boot/system-prompt-builder.js';
import { registerBuiltinTools } from '../boot/tool-registry.js';
import { createDomainGlossaryAdapter } from './domain-glossary.js';
import { refreshDomainTermsMirror } from './domain-terms-mirror.js';

// biome-ignore lint/suspicious/noExplicitAny: large dependency bag — exact types add no safety here
type AnyObj = any;

export async function setupCliPromptAndTools(params: {
  container: AnyObj;
  modeStore: AnyObj;
  memoryStore: AnyObj;
  skillLoader: AnyObj;
  sessionRef: { current: import('@wrongstack/core/types').SessionWriter | undefined };
  autonomyModeRef: { current: import('../services/autonomy-mode.js').AutonomyMode };
  modeId: string;
  modePrompt?: string | undefined;
  modelCapabilitiesRef: { current: AnyObj };
  config: AnyObj;
  wpaths: AnyObj;
  projectRoot: string;
  events: AnyObj;
  /**
   * Optional vector memory store. When provided, the four
   * `vector_memory_*` tools are registered alongside the SAGE tools so
   * agents get both lexical and semantic retrieval paths in one surface.
   * Omit (or pass `undefined`) to keep the CLI on the SAGE-only surface.
   */
  vectorMemoryStore?: VectorMemoryStore | undefined;
}): Promise<{ toolRegistry: ToolRegistry }> {
  const {
    container,
    modeStore,
    memoryStore,
    skillLoader,
    sessionRef,
    autonomyModeRef,
    modeId,
    modePrompt,
    modelCapabilitiesRef,
    config,
    wpaths,
    projectRoot,
    events,
    vectorMemoryStore,
  } = params;

  bindSystemPromptBuilder({
    container,
    modeStore,
    memoryStore,
    domainGlossary: createDomainGlossaryAdapter(memoryStore),
    skillLoader,
    sessionRef,
    autonomyModeRef,
    modeId,
    modePrompt: modePrompt ?? '',
    modelCapabilities: () => modelCapabilitiesRef.current,
    skillsEnabled: config.features.skills,
    skillMode: config.skills?.mode,
    skillEagerMaxChars: config.skills?.eagerMaxChars,
    tokenSavingMode: config.features.tokenSavingMode,
    systemPromptVariant: config.systemPrompt?.variant,
    paths: {
      projectGoal: wpaths.projectGoal,
      projectSessions: wpaths.projectSessions,
      globalInstructions: wpaths.globalInstructions,
      inProjectInstructions: wpaths.inProjectInstructions,
    },
    pathJoiner: { join: (a, b) => path.join(a, b) },
    systemPromptBuilderToken: TOKENS.SystemPromptBuilder,
  });

  await refreshDomainTermsMirror({ projectRoot });

  const toolRegistry = new ToolRegistry();
  registerBuiltinTools({
    toolRegistry,
    compactor: container.resolve(TOKENS.Compactor),
    config,
    memoryStore,
    vectorMemoryStore,
    events,
    wpaths,
  });

  return { toolRegistry };
}
