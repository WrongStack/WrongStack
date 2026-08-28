/**
 * Dep-watcher bridge wiring — extracted from cli-main.ts.
 *
 * Parses the `extensions['file-watcher']['depWatcher']` config and wires
 * the dep-watcher bridge when enabled. The bridge posts dependency manifest
 * changes (package.json, go.mod, etc.) to the project-level mailbox for
 * tech-stack audit.
 *
 * Returns the parsed `dwCfg` so the caller can pass it directly to
 * `setupDepWatcherConsumers()` without reparsing.
 */
import * as path from 'node:path';
import { attachDepWatcherBridge, getSharedProjectMailbox } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';

interface SetupDepWatcherBridgeDeps {
  config: { extensions?: Record<string, unknown> };
  wpaths: { globalRoot: string; projectSlug: string };
  projectRoot: string;
  events: EventBus;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  teardownHandlers: Array<() => void>;
}

interface SetupDepWatcherBridgeResult {
  /** Parsed dep-watcher config fragment (or undefined when absent/disabled). */
  dwCfg: Record<string, unknown> | undefined;
}

export function setupDepWatcherBridge(
  deps: SetupDepWatcherBridgeDeps,
): SetupDepWatcherBridgeResult {
  const { config, wpaths, projectRoot, events, logger, teardownHandlers } = deps;

  const fwCfg = config.extensions?.['file-watcher'] as Record<string, unknown> | undefined;
  const dwCfg = fwCfg?.['depWatcher'] as Record<string, unknown> | undefined;
  let depWatcherDispose: (() => void) | undefined;

  if (dwCfg?.['enabled'] === true) {
    try {
      const projectDir = path.join(wpaths.globalRoot, 'projects', wpaths.projectSlug);
      const dwMailbox = getSharedProjectMailbox(projectDir, events);
      depWatcherDispose = attachDepWatcherBridge({
        events,
        mailbox: dwMailbox,
        projectRoot,
        targetAgent: (dwCfg['targetAgent'] as string) ?? 'tech-stack',
        watcherAgentId: 'dep-watcher',
        debounceMs: (dwCfg['debounceMs'] as number) ?? 3000,
      });
      logger.info(
        'Dep-watcher bridge activated — dependency changes will trigger tech-stack audits',
      );
    } catch (err) {
      logger.warn(`Failed to wire dep-watcher bridge: ${err}`);
    }
  }

  // Clean up dep-watcher bridge on teardown
  if (depWatcherDispose) {
    teardownHandlers.push(depWatcherDispose);
  }

  return { dwCfg };
}
