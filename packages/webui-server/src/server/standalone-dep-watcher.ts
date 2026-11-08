import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Config } from '@wrongstack/contracts/types';
import {
  type DepWatcherAuditHost,
  type DepWatcherLogger,
  setupDepWatcherBridge,
  setupDepWatcherConsumers,
} from '@wrongstack/runtime/dep-watcher';

export interface StandaloneDepWatcherInput {
  config: Pick<Config, 'extensions'>;
  paths: { globalRoot: string; projectSlug: string };
  projectRoot: string;
  events: EventBus;
  logger: DepWatcherLogger;
  /** The engine's fleet host; absent when `delegate` is disabled. */
  host: DepWatcherAuditHost | undefined;
  /** The boot session: the consumer's mailbox identity (CLI parity: its boot session). */
  sessionId: string;
}

/**
 * Dependency watcher → automatic tech-stack audits for the standalone engine behind
 * WebUI/desktop (CLI parity: `cli-main-boot.ts` `setupDepWatcherBridge` +
 * `cli-main-orchestration.ts` `setupDepWatcherConsumers`). Same functions, same gate
 * (`extensions."file-watcher".depWatcher.enabled`, default on). The tech-stack consumer
 * spawns its audit through the engine's fleet host, so without one (`delegate` disabled) only
 * the bridge runs — manifest changes still reach the project mailbox, and a host with a fleet
 * on the same project picks them up. Returns the disposer for shutdown.
 */
export function startStandaloneDepWatcher(input: StandaloneDepWatcherInput): () => void {
  const teardownHandlers: Array<() => void> = [];
  const { dwCfg } = setupDepWatcherBridge({
    config: input.config,
    wpaths: input.paths,
    projectRoot: input.projectRoot,
    events: input.events,
    logger: input.logger,
    teardownHandlers,
  });
  if (input.host) {
    setupDepWatcherConsumers({
      dwCfg,
      globalRoot: input.paths.globalRoot,
      projectSlug: input.paths.projectSlug,
      events: input.events,
      multiAgentHost: input.host,
      sessionId: input.sessionId,
      logger: input.logger,
      teardownHandlers,
      projectRoot: input.projectRoot,
    });
  }
  return () => {
    for (const dispose of teardownHandlers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        // One watcher that cannot stop must not keep the others running.
      }
    }
  };
}
