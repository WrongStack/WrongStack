/**
 * Rebuild the live system prompt after something that feeds it changed.
 *
 * Two things can move underneath a running session: the active mode (which
 * contributes a whole prompt layer) and the identity variant (Lite / Standard /
 * Pro, which selects `system.md` vs `system-lite.md` vs `system-pro.md`). Both
 * need the exact same eleven-dependency `DefaultSystemPromptBuilder` call, and
 * a second copy of that call is a second place to forget `injectMemory: false`
 * — which would double-inject SAGE memories, since its turn middleware is the
 * single memory channel.
 */

import { type Container, TOKENS } from '@wrongstack/contracts/kernel';
import {
  type Config,
  type MemoryPort,
  type ModeStore,
  resolveTokenSavingTier,
  type SkillLoader,
  type TokenSavingTier,
} from '@wrongstack/contracts/types';
import {
  type Context,
  DefaultSystemPromptBuilder,
  providerToolsForVariant,
  type SystemInstructionVariant,
} from '@wrongstack/core/agent';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { resolveWstackPaths, type WstackPaths } from '@wrongstack/core/utils';
import {
  createHostSystemPromptSections,
  type HostSystemPromptSections,
} from '@wrongstack/runtime/system-prompt-contributors';

type ModelCapabilities = NonNullable<
  ConstructorParameters<typeof DefaultSystemPromptBuilder>[0]
>['modelCapabilities'];

export interface SystemPromptRebuildDeps {
  modeStore: ModeStore | undefined;
  memoryStore: MemoryPort | undefined;
  skillLoader: SkillLoader | undefined;
  modelCapabilities: ModelCapabilities;
  context: Context;
  toolRegistry: ToolRegistry;
  getConfig: () => Pick<
    Config,
    'provider' | 'model' | 'systemPrompt' | 'features' | 'skills' | 'indexing'
  >;
  projectRoot: string;
  globalRoot: string;
  /**
   * When supplied, the freshly built builder replaces the container-bound one.
   *
   * Matters for the identity variant specifically: the boot-time builder has
   * the old variant baked into its `instructionPaths`, and everything that
   * resolves `TOKENS.SystemPromptBuilder` later — the subagent factory, most
   * visibly — would otherwise keep composing subagent prompts from the variant
   * the user just moved away from.
   */
  container?: Container | undefined;
}

/**
 * The host-owned prompt sections of this engine — session plan, ETERNAL
 * AUTONOMY block, WrongTrace digest, Atlas brief and domain glossary — from the
 * same shared assembly the CLI binds (`bindSystemPromptBuilder`).
 *
 * Both of this engine's builders (the boot one in `pre-context-services.ts` and
 * every rebuild below) take their sections from here, so a mode or identity
 * switch never swaps in a builder that lost them. No process-wide autonomy:
 * each conversation's own mode (`ctx.autonomy`) decides the autonomy block.
 */
export function standaloneSystemPromptSections(input: {
  paths: Pick<WstackPaths, 'projectGoal' | 'projectSessions'>;
  projectRoot: string;
  memoryStore: MemoryPort | undefined;
  getSessionId: () => string | undefined;
  tokenSavingMode: TokenSavingTier | boolean | undefined;
  config: Pick<Config, 'indexing'>;
}): HostSystemPromptSections {
  return createHostSystemPromptSections({
    goalPath: input.paths.projectGoal,
    projectSessionsDir: input.paths.projectSessions,
    getSessionId: input.getSessionId,
    tokenSavingMode: input.tokenSavingMode,
    projectRoot: input.projectRoot,
    atlas: input.config.indexing?.atlas,
    memoryStore: input.memoryStore,
  });
}

/**
 * The identity variant the context being rebuilt is actually running.
 *
 * With four tabs the config's `systemPrompt.variant` is the wrong answer: it
 * holds whichever variant was picked LAST, by any tab. A rebuild triggered in
 * one tab for an unrelated reason — a mode switch, a skill reload — would then
 * recompose that tab's prompt from another tab's identity. The context's own
 * meta is the tab's answer; the config stays as the fallback for surfaces that
 * keep no per-context meta (CLI, TUI, and the boot path).
 */
function variantForContext(
  context: Context,
  config: Pick<Config, 'systemPrompt'>,
): SystemInstructionVariant | undefined {
  const scoped = context.meta['systemPromptVariant'];
  if (
    scoped === 'lite' ||
    scoped === 'default' ||
    scoped === 'pro' ||
    scoped === 'scout' ||
    scoped === 'quick'
  ) {
    return scoped;
  }
  return config.systemPrompt?.variant;
}

/**
 * Recompose `context.systemPrompt` for `modeId` using the variant that context
 * is running. Mutates the context in place; the caller decides what to
 * broadcast afterwards.
 */
export async function rebuildSystemPrompt(
  deps: SystemPromptRebuildDeps,
  modeId: string,
): Promise<void> {
  const modePrompt =
    modeId === 'default' ? '' : ((await deps.modeStore?.getMode(modeId))?.prompt ?? '');
  const paths = resolveWstackPaths({
    projectRoot: deps.projectRoot,
    globalRoot: deps.globalRoot,
  });
  const config = deps.getConfig();
  const variant = variantForContext(deps.context, config);
  // Resolve `'auto'` here rather than handing the sentinel to the builder,
  // for the same reason boot does: the tool registry was tiered once, at
  // boot, from this same function and this same window. Passing the raw
  // sentinel would let a rebuilt prompt land on a different tier than the
  // tool surface it is describing. Concrete tiers pass through verbatim.
  const tokenSavingMode = resolveTokenSavingTier(
    config.features?.tokenSavingMode,
    (typeof deps.modelCapabilities === 'function'
      ? deps.modelCapabilities()
      : deps.modelCapabilities
    )?.maxContextTokens,
  );
  const builder = new DefaultSystemPromptBuilder({
    memoryStore: deps.memoryStore,
    injectMemory: false,
    skillLoader: deps.skillLoader,
    skillMode: config.skills?.mode,
    skillEagerMaxChars: config.skills?.eagerMaxChars,
    modeStore: deps.modeStore,
    modeId,
    modePrompt,
    modelCapabilities: deps.modelCapabilities,
    tokenSavingMode,
    instructionPaths: {
      globalDir: paths.globalInstructions,
      projectDir: paths.inProjectInstructions,
      systemVariant: variant,
    },
    userInstructionsFile: config.systemPrompt?.includeGlobalAgents === false ? false : undefined,
    projectInstructions: config.systemPrompt?.includeProjectAgents !== false,
    // The rebuilt context's own session plan, not the boot tab's.
    ...standaloneSystemPromptSections({
      paths,
      projectRoot: deps.projectRoot,
      memoryStore: deps.memoryStore,
      getSessionId: () => deps.context.session?.id,
      tokenSavingMode,
      config,
    }),
  });
  const tools = providerToolsForVariant(
    deps.toolRegistry,
    variant,
    deps.context.meta,
    deps.context.provider,
  );
  // The surface moves with the identity; the context view reads it from here.
  deps.context.tools = tools;
  deps.context.systemPrompt = await builder.build({
    cwd: deps.projectRoot,
    projectRoot: deps.projectRoot,
    tools,
    catalogTools: deps.toolRegistry.list(),
    provider: config.provider,
    model: config.model,
    // The conversation's own autonomy, as the per-turn refresh passes it.
    ...(typeof deps.context.meta['autonomy'] === 'string'
      ? { autonomy: deps.context.meta['autonomy'] }
      : {}),
  });
  if (deps.container?.has(TOKENS.SystemPromptBuilder)) {
    deps.container.override(TOKENS.SystemPromptBuilder, () => builder, {
      owner: 'system-prompt-rebuild',
    });
  }
}
