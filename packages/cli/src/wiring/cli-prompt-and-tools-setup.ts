import * as path from 'node:path';
import { TOKENS } from '@wrongstack/core/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import { resolveTokenSavingTier } from '@wrongstack/core/types';
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

  // One tier decision per session, shared by both halves of the tier.
  //
  // `'auto'` (the config default) expands two different ways: window-blind to
  // `'medium'` via `normalizeTokenSavingTier`, window-aware to `'minimal'` on a
  // modern context window via `resolveTokenSavingTier`. The registry used the
  // first and the prompt builder the second, so a default session ran a
  // minimal-shaped prompt over a medium tool surface. Resolving here — the
  // model is already resolved by the time this runs — and passing the SAME
  // concrete tier to both makes "the tier" one answer instead of two.
  //
  // Explicit tiers ('off' … 'aggressive') pass through verbatim, so a user who
  // picks a tier at session start still gets exactly that tier. Freezing the
  // decision at boot is also what makes it hold: the tool registry is never
  // re-tiered mid-session, so a prompt that kept drifting with the live window
  // would only drift away from the tools it describes.
  const tier = resolveTokenSavingTier(
    config.features.tokenSavingMode,
    (modelCapabilitiesRef.current as { maxContextTokens?: number } | undefined)?.maxContextTokens,
  );

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
    tokenSavingMode: tier,
    systemPromptVariant: config.systemPrompt?.variant,
    paths: {
      projectGoal: wpaths.projectGoal,
      projectSessions: wpaths.projectSessions,
      globalInstructions: wpaths.globalInstructions,
      inProjectInstructions: wpaths.inProjectInstructions,
    },
    projectRoot,
    atlas: config.indexing?.atlas,
    pathJoiner: { join: (a, b) => path.join(a, b) },
    systemPromptBuilderToken: TOKENS.SystemPromptBuilder,
  });

  await refreshDomainTermsMirror({ projectRoot });

  const toolRegistry = new ToolRegistry();
  registerBuiltinTools({
    toolRegistry,
    compactor: container.resolve(TOKENS.Compactor),
    config,
    tier,
    memoryStore,
    vectorMemoryStore,
    events,
    wpaths,
  });

  return { toolRegistry };
}
