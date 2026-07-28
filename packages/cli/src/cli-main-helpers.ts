import {
  getSharedProjectMailbox,
  type MailboxAgentStatus,
} from '@wrongstack/core/coordination';
import type { Logger, ModelsRegistry } from '@wrongstack/core/types';
import type { Config } from '@wrongstack/core/types';
import { refreshRuntimeModelCatalog } from './context-limit.js';
import { buildPickableProviders } from './provider-helpers.js';

export interface CliMainEventSource {
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
}

export function createTeardownEventRegistrar(
  events: CliMainEventSource,
  teardownHandlers: Array<() => void>,
): (event: string, handler: (...args: any[]) => void) => void {
  return (
    event: string,
    handler: (
      // biome-ignore lint/suspicious/noExplicitAny: dynamic event dispatch mirrors EventBus
      ...args: any[]
    ) => void,
  ) => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic event dispatcher signature
    (events.on as (e: string, h: (...args: any[]) => void) => void)(event, handler);
    teardownHandlers.push(() =>
      // biome-ignore lint/suspicious/noExplicitAny: dynamic event dispatcher signature
      (events.off as (e: string, h: (...args: any[]) => void) => void)(event, handler),
    );
  };
}

export async function loadOnlineAgentsForPrompt(
  projectDir: string,
  skip: boolean,
): Promise<MailboxAgentStatus[]> {
  if (skip) return [];
  try {
    const systemMailbox = getSharedProjectMailbox(projectDir);
    return await systemMailbox.getAgentStatuses();
  } catch {
    return [];
  }
}

export async function getSddRuntimeStateForCli(): Promise<{
  tracker: unknown;
  builder: unknown;
  graphId: string | null;
}> {
  const sdd = await import('./services/sdd-runtime.js');
  return {
    tracker: sdd.getTaskTracker(),
    builder: sdd.getActiveBuilder(),
    graphId: sdd.getTaskGraphId(),
  };
}

export function createPickableProvidersLoader(args: {
  modelsRegistry: ModelsRegistry;
  logger: Logger;
  getConfig: () => Config;
}): () => Promise<Awaited<ReturnType<typeof buildPickableProviders>>> {
  const { modelsRegistry, logger, getConfig } = args;
  return async () => {
    await refreshRuntimeModelCatalog({
      modelsRegistry,
      logger,
      reason: 'model-picker',
    });
    return buildPickableProviders(modelsRegistry, getConfig());
  };
}
