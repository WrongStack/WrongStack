import type { Tool } from '@wrongstack/contracts/types/tool';
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
  const wrappedFns = new WeakSet<Function>();

  const enterOwners = (owners: readonly string[]): void => {
    for (const owner of owners) {
      inFlight.set(owner, (inFlight.get(owner) ?? 0) + 1);
    }
  };

  const leaveOwners = (owners: readonly string[]): void => {
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
  };

  const resolveToolOwners = (toolName: string | undefined): string[] => {
    if (!toolName || !toolRegistry) return [];
    const canonical =
      typeof toolRegistry.resolveName === 'function'
        ? toolRegistry.resolveName(toolName)
        : toolName;
    const regWithOwnerOf = toolRegistry as Partial<Pick<ToolRegistry, 'ownerOf'>>;
    const directOwner =
      typeof regWithOwnerOf.ownerOf === 'function' ? regWithOwnerOf.ownerOf(canonical) : undefined;
    const ownerStr =
      directOwner ??
      (typeof toolRegistry.listWithOwner === 'function'
        ? toolRegistry.listWithOwner().find((entry) => entry.tool.name === canonical)?.owner
        : undefined);
    if (!ownerStr) return [];
    return [...new Set(ownerStr.split('+').filter(Boolean))];
  };

  const instrumentTool = (tool: Tool): Tool => {
    const origExec = tool.execute;
    const origStream = tool.executeStream;
    const needExec = typeof origExec === 'function' && !wrappedFns.has(origExec);
    const needStream = typeof origStream === 'function' && !wrappedFns.has(origStream);
    if (!needExec && !needStream) return tool;

    let nextExec = origExec;
    if (needExec && origExec) {
      const wrappedExec: typeof origExec = async function (this: unknown, ...args) {
        const owners = resolveToolOwners(tool.name);
        if (owners.length === 0) return origExec.apply(this, args);
        enterOwners(owners);
        try {
          return await origExec.apply(this, args);
        } finally {
          leaveOwners(owners);
        }
      };
      wrappedFns.add(wrappedExec);
      nextExec = wrappedExec;
    }

    let nextStream = origStream;
    if (needStream && origStream) {
      const wrappedStream: typeof origStream = async function* (this: unknown, ...args) {
        const owners = resolveToolOwners(tool.name);
        if (owners.length === 0) {
          yield* origStream.apply(this, args);
          return;
        }
        enterOwners(owners);
        try {
          yield* origStream.apply(this, args);
        } finally {
          leaveOwners(owners);
        }
      };
      wrappedFns.add(wrappedStream);
      nextStream = wrappedStream;
    }

    if (!Object.isFrozen(tool)) {
      if (needExec) tool.execute = nextExec;
      if (needStream && nextStream) tool.executeStream = nextStream;
      return tool;
    }
    return {
      ...tool,
      execute: nextExec,
      ...(nextStream ? { executeStream: nextStream } : {}),
    };
  };

  const internalReg = toolRegistry as unknown as
    | {
        tools?: Map<string, { tool: Tool }> | undefined;
        storeRegistration?: ((name: string, registration: { tool: Tool }) => void) | undefined;
      }
    | undefined;

  if (internalReg?.tools instanceof Map) {
    for (const entry of internalReg.tools.values()) {
      entry.tool = instrumentTool(entry.tool);
    }
  } else if (typeof toolRegistry?.listWithOwner === 'function') {
    for (const entry of toolRegistry.listWithOwner()) {
      instrumentTool(entry.tool);
    }
  }

  if (internalReg && typeof internalReg.storeRegistration === 'function') {
    const origStore = internalReg.storeRegistration;
    internalReg.storeRegistration = function (
      this: unknown,
      name: string,
      registration: { tool: Tool },
    ) {
      registration.tool = instrumentTool(registration.tool);
      return origStore.call(this, name, registration);
    };
  }

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
        enterOwners(owners);
        try {
          return await next(payload);
        } finally {
          leaveOwners(owners);
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
