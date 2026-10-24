import * as path from 'node:path';
import { TOKENS } from '@wrongstack/contracts/kernel';
import { resolveTokenSavingTier } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import type { VectorMemoryStore } from '@wrongstack/vector-memory';
import { bindSystemPromptBuilder } from '../boot/system-prompt-builder.js';
import { registerBuiltinTools } from '../boot/tool-registry.js';
import {
  type ToolRestriction,
  unknownRestrictedToolNames,
} from '../boot/tool-restriction-flags.js';
import { createDomainGlossaryAdapter } from './domain-glossary.js';
import { refreshDomainTermsMirror } from './domain-terms-mirror.js';

// biome-ignore lint/suspicious/noExplicitAny: large dependency bag — exact types add no safety here
type AnyObj = any;

export async function setupCliPromptAndTools(params: {
  container: AnyObj;
  modeStore: AnyObj;
  memoryStore: AnyObj;
  skillLoader: AnyObj;
  sessionRef: { current: import('@wrongstack/contracts/types').SessionWriter | undefined };
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
  /** Resolved `--append-system-prompt[-file]` text, appended to the host prompt. */
  appendedInstructions?: string | undefined;
  /** `--only-tools` / `--disallowed-tools`, already validated at boot. */
  toolRestriction?: ToolRestriction | undefined;
  /** Where to warn about restriction names that match no tool. */
  warn?: ((message: string) => void) | undefined;
  /** `--safe-mode`: no skills, no instruction override files. */
  safeMode?: boolean | undefined;
}): Promise<{ toolRegistry: ToolRegistry }> {
  const {
    appendedInstructions,
    toolRestriction,
    warn,
    safeMode,
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
    skillsEnabled: config.features.skills && safeMode !== true,
    skillMode: config.skills?.mode,
    skillEagerMaxChars: config.skills?.eagerMaxChars,
    tokenSavingMode: tier,
    systemPromptVariant: config.systemPrompt?.variant,
    appendedInstructions,
    paths: {
      projectGoal: wpaths.projectGoal,
      projectSessions: wpaths.projectSessions,
      // Safe mode reads only the bundled instructions: an override file is
      // exactly the kind of customization it exists to rule out.
      globalInstructions: safeMode ? undefined : wpaths.globalInstructions,
      inProjectInstructions: safeMode ? undefined : wpaths.inProjectInstructions,
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
    // Same gate the prompt builder uses (`skillsEnabled`), so the manifest and
    // the tool that loads its entries are present or absent together.
    skillLoader: config.features.skills && safeMode !== true ? skillLoader : undefined,
    events,
    wpaths,
  });

  if (toolRestriction) {
    // Before the agent or any subagent reads the registry: subagent registries
    // are built from `toolRegistry.list()`, so they inherit the restriction.
    toolRegistry.setSessionRestriction(toolRestriction);
    // ownerOf() sees every registration, hidden or not.
    const unknown = unknownRestrictedToolNames(
      toolRestriction,
      (name) => toolRegistry.ownerOf(name) !== undefined,
    );
    if (unknown.length > 0) {
      warn?.(`Tool restriction names match no registered tool: ${unknown.join(', ')}`);
    }
  }

  return { toolRegistry };
}
