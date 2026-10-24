import type { Tool } from '@wrongstack/contracts/types/tool';
import { resolveSandboxConfigForAgent } from './agent-overrides.js';
import { SandboxDeniedError } from './types.js';

/**
 * Plan 28 T4 — the `browser_*`-disabled tier rule. Under an enforced
 * container tier, browser automation cannot work (deny-by-default network,
 * no browser inside the image) and must not silently fall back to a
 * host-side Chromium: every gated browser tool denies with `sandbox_denied`.
 * Other backends pass through unchanged.
 */
export function createSandboxBrowserTierGate(): <I, O>(tool: Tool<I, O>) => Tool<I, O> {
  return <I, O>(tool: Tool<I, O>): Tool<I, O> => {
    const rawExecute = tool.execute;
    if (!rawExecute) return tool;
    const gated: Tool<I, O> = {
      ...tool,
      execute: async (input, ctx, opts) => {
        const config = resolveSandboxConfigForAgent(
          (ctx as { agentId?: string } | undefined)?.agentId,
        );
        if (config.mode === 'enforced' && config.backend === 'container') {
          const decision = {
            outcome: 'deny' as const,
            reason:
              'browser automation is disabled under the container tier (deny-by-default network; no browser in the image)',
            missing: [],
          };
          throw new SandboxDeniedError(tool.name, decision);
        }
        return rawExecute.call(tool, input, ctx, opts);
      },
    };
    return gated;
  };
}
