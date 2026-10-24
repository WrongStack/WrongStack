import { resolveTokenSavingTier } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { isOutsideProject, resolveWstackPaths } from '@wrongstack/core/utils';
import { patchConfig } from './boot.js';
import type { WebuiDeps, WebuiMutableState } from './route-contracts.js';
import { rebuildSystemPrompt } from './system-prompt-rebuild.js';

/**
 * The system-prompt surface the session and prefs routes share: preview
 * context, instruction paths, the current variant, and per-tab variant apply
 * (which rebuilds the asking tab's prompt).
 */
export function createSystemPromptRouteAdapter(
  state: WebuiMutableState,
  deps: WebuiDeps,
  sessionContext: (sessionId?: string) => Context,
) {
  return {
    previewContext: (sessionId?: string) => {
      const target = sessionContext(sessionId);
      return {
        toolNames: target.tools.map((tool) => tool.name),
        tier: resolveTokenSavingTier(
          state.getConfig().features?.tokenSavingMode,
          (state.getModelCapabilities() as { maxContextTokens?: number } | undefined)
            ?.maxContextTokens,
        ),
      };
    },
    paths: () => {
      const wpaths = resolveWstackPaths({
        projectRoot: state.getProjectRoot(),
        globalRoot: deps.wpaths.globalRoot,
      });
      return {
        globalDir: wpaths.globalInstructions,
        projectDir: wpaths.inProjectInstructions,
      };
    },
    profileConfigPath: deps.profileConfigPath,
    current: () => state.getConfig().systemPrompt?.variant ?? 'default',
    outsideProject: () => isOutsideProject(state.getProjectRoot()),
    // Move the in-memory default too: `persistPrefsToConfig` writes the file,
    // not the object, and everything that has no per-tab answer reads the
    // object — `current()` for a picker in a tab that never chose, and the
    // meta seed a NEWLY created session starts from.
    //
    // It is only a default. The rebuild below no longer reads it for a tab
    // that has its own variant (see `variantForContext`), so a pick here
    // cannot reach a tab that already made one.
    applyVariant: async (variant: string, sessionId?: string) => {
      const config = state.getConfig();
      state.setConfig(
        patchConfig(config, {
          systemPrompt: { ...(config.systemPrompt ?? {}), variant: variant as never },
        }),
      );
      // Rebuild the asking tab's prompt. The container rebind stays global on
      // purpose: it only changes which builder NEW subagents are composed
      // from, which is a default rather than live conversation state.
      const targetCtx = sessionContext(sessionId);
      const modeId =
        typeof targetCtx.meta['modeId'] === 'string' && targetCtx.meta['modeId']
          ? (targetCtx.meta['modeId'] as string)
          : state.getModeId();
      targetCtx.meta['systemPromptVariant'] = variant;
      await rebuildSystemPrompt(
        {
          modeStore: deps.modeStore,
          memoryStore: deps.memoryStore,
          skillLoader: deps.skillLoader,
          modelCapabilities: (() => state.getModelCapabilities()) as never,
          context: targetCtx,
          toolRegistry: deps.toolRegistry,
          getConfig: state.getConfig,
          projectRoot: state.getProjectRoot(),
          globalRoot: deps.wpaths.globalRoot,
          // Rebind the container ONLY when the tab that asked owns the root
          // context. The rebound builder carries the rebuilding tab's mode
          // and mode prompt as well as its variant, and `Agent`'s pre-run
          // refresh resolves that one token for every conversation — so a
          // rebind from tab A put tab A's MODE layer into tab B's prompt on
          // B's next turn. `mode-handlers` already omits the container for
          // this reason. Nothing is lost: the identity variant now travels
          // per conversation in `ctx.meta`, which that refresh reads, and
          // subagents compose from `host.deps.systemPromptBuilder` rather
          // than the token.
          ...(targetCtx === deps.context ? { container: deps.container } : {}),
        },
        modeId,
      );
    },
  };
}
