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

import {
  type Context,
  DefaultSystemPromptBuilder,
  type SystemInstructionVariant,
} from '@wrongstack/core/agent';
import { type Container, TOKENS } from '@wrongstack/core/kernel';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { Config, MemoryPort, ModeStore, SkillLoader } from '@wrongstack/core/types';
import { resolveWstackPaths } from '@wrongstack/core/utils';

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
  getConfig: () => Pick<Config, 'provider' | 'model' | 'systemPrompt' | 'features'>;
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
  if (scoped === 'lite' || scoped === 'default' || scoped === 'pro') return scoped;
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
  const builder = new DefaultSystemPromptBuilder({
    memoryStore: deps.memoryStore,
    injectMemory: false,
    skillLoader: deps.skillLoader,
    modeStore: deps.modeStore,
    modeId,
    modePrompt,
    modelCapabilities: deps.modelCapabilities,
    tokenSavingMode: config.features?.tokenSavingMode,
    instructionPaths: {
      globalDir: paths.globalInstructions,
      projectDir: paths.inProjectInstructions,
      systemVariant: variantForContext(deps.context, config),
    },
  });
  deps.context.systemPrompt = await builder.build({
    cwd: deps.projectRoot,
    projectRoot: deps.projectRoot,
    tools: deps.toolRegistry.listForProvider(),
    catalogTools: deps.toolRegistry.list(),
    provider: config.provider,
    model: config.model,
  });
  if (deps.container?.has(TOKENS.SystemPromptBuilder)) {
    deps.container.override(TOKENS.SystemPromptBuilder, () => builder, {
      owner: 'system-prompt-rebuild',
    });
  }
}
