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

import { type Context, DefaultSystemPromptBuilder } from '@wrongstack/core/agent';
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
 * Recompose `context.systemPrompt` for `modeId` using the config's current
 * `systemPrompt.variant`. Mutates the context in place; the caller decides what
 * to broadcast afterwards.
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
      systemVariant: config.systemPrompt?.variant,
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
