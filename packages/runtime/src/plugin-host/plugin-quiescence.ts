import type { AgentPipelines, ToolCallPipelinePayload } from '@wrongstack/core/agent';
import type { ToolRegistry } from '@wrongstack/core/registry';

/**
 * Tracks in-flight tool executions per owning/wrapping plugin so `/plugin reload`
 * waits for active tool invocations to settle before tearing down the previous
 * plugin generation.
 */
export function installPluginToolQuiescence(
  pipelines: Pick<AgentPipelines, 'toolCall'> | undefined,
  toolRegistry: Pick<ToolRegistry, 'listWithOwner' | 'resolveName'> | undefined,
): (pluginName: string, timeoutMs: number) => Promise<void> {
  const inFlight = new Map<string, number>();
  const waiters = new Map<string, Set<() => void>>();

  const resolveToolOwners = (toolName: string | undefined): string[] => {
    if (!toolName || typeof toolRegistry?.listWithOwner !== 'function') return [];
    const canonical =
      typeof toolRegistry.resolveName === 'function'
        ? toolRegistry.resolveName(toolName)
        : toolName;
    const match = toolRegistry.listWithOwner().find((entry) => entry.tool.name === canonical);
    if (!match?.owner) return [];
    return [...new Set(match.owner.split('+').filter(Boolean))];
  };

  if (typeof pipelines?.toolCall?.use === 'function') {
    pipelines.toolCall.use({
      name: 'PluginQuiescenceTracker',
      owner: 'plugin-host',
      handler: async (
        payload: ToolCallPipelinePayload,
        next: (v: ToolCallPipelinePayload) => Promise<ToolCallPipelinePayload>,
      ) => {
        const owners = resolveToolOwners(payload.tool?.name ?? payload.toolUse?.name);
        if (owners.length === 0) {
          return next(payload);
        }
        for (const owner of owners) {
          inFlight.set(owner, (inFlight.get(owner) ?? 0) + 1);
        }
        try {
          return await next(payload);
        } finally {
          for (const owner of owners) {
            const remaining = (inFlight.get(owner) ?? 1) - 1;
            if (remaining <= 0) {
              inFlight.delete(owner);
              const set = waiters.get(owner);
              if (set) {
                waiters.delete(owner);
                for (const wake of set) wake();
              }
            } else {
              inFlight.set(owner, remaining);
            }
          }
        }
      },
    });
  }

  return async (pluginName: string, timeoutMs: number): Promise<void> => {
    if ((inFlight.get(pluginName) ?? 0) <= 0) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.get(pluginName)?.delete(done);
        resolve();
      };
      let set = waiters.get(pluginName);
      if (!set) {
        set = new Set();
        waiters.set(pluginName, set);
      }
      set.add(done);
      const timer = setTimeout(done, Math.max(0, timeoutMs));
      timer.unref?.();
    });
  };
}
