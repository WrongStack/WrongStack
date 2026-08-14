import * as path from 'node:path';
import { TOKENS } from '@wrongstack/core/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import { bindSystemPromptBuilder } from '../boot/system-prompt-builder.js';
import { registerBuiltinTools } from '../boot/tool-registry.js';
import { createDomainGlossaryAdapter } from './domain-glossary.js';
import { refreshDomainTermsMirror } from './domain-terms-mirror.js';

export async function setupCliPromptAndTools(params: {
  container: any;
  modeStore: any;
  memoryStore: any;
  skillLoader: any;
  sessionRef: { current: import('@wrongstack/core/types').SessionWriter | undefined };
  autonomyModeRef: { current: import('../services/autonomy-mode.js').AutonomyMode };
  modeId: string;
  modePrompt?: string | undefined;
  modelCapabilitiesRef: { current: any };
  config: any;
  wpaths: any;
  projectRoot: string;
  events: any;
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

  await refreshDomainTermsMirror({ projectRoot, memoryStore });

  const toolRegistry = new ToolRegistry();
  registerBuiltinTools({
    toolRegistry,
    compactor: container.resolve(TOKENS.Compactor),
    config,
    memoryStore,
    events,
    wpaths,
  });

  return { toolRegistry };
}
