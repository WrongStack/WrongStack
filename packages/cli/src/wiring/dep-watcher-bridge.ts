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
import type { EventBus } from '@wrongstack/contracts/kernel';
import { attachDepWatcherBridge, getSharedProjectMailbox } from '@wrongstack/core/coordination';

interface SetupDepWatcherBridgeDeps {
  config: { extensions?: Record<string, unknown> };
  wpaths: { globalRoot: string; projectSlug: string };
  projectRoot: string;
  events: EventBus;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  teardownHandlers: Array<() => void>;
}

interface SetupDepWatcherBridgeResult {
  /**
   * Parsed dep-watcher config fragment — the RAW host config, or undefined when
   * the namespace is absent.
   *
   * `undefined` does NOT mean "off": the gate below defaults to enabled, so an
   * absent block starts the bridge. Only an explicit `enabled: false` opts out.
   * (Behaviour change 2026-10-05.)
   */
  dwCfg: Record<string, unknown> | undefined;
}

export function setupDepWatcherBridge(
  deps: SetupDepWatcherBridgeDeps,
): SetupDepWatcherBridgeResult {
  const { config, wpaths, projectRoot, events, logger, teardownHandlers } = deps;

  const fwCfg = config.extensions?.['file-watcher'] as Record<string, unknown> | undefined;
  const dwCfg = fwCfg?.['depWatcher'] as Record<string, unknown> | undefined;
  let depWatcherDispose: (() => void) | undefined;

  // Default-on (behaviour change, 2026-10-05).
  //
  // This reads the HOST config, not the plugin's resolved options: the loader
  // merges `defaultConfig` into `opts.pluginOptions` (loader.ts:417) and never
  // into `config.extensions`. So flipping the plugin's own `enabled` default
  // would leave `dwCfg` undefined here and the gate shut — the flip has to be
  // expressed at the gate too, or it is a silent no-op.
  //
  // Opt back out with `extensions."file-watcher".depWatcher.enabled = false`.
  const depWatcherEnabled = dwCfg?.['enabled'] !== false;

  if (depWatcherEnabled) {
    try {
      const projectDir = path.join(wpaths.globalRoot, 'projects', wpaths.projectSlug);
      const dwMailbox = getSharedProjectMailbox(projectDir, events);
      depWatcherDispose = attachDepWatcherBridge({
        events,
        mailbox: dwMailbox,
        projectRoot,
        targetAgent: (dwCfg?.['targetAgent'] as string) ?? 'tech-stack',
        watcherAgentId: 'dep-watcher',
        debounceMs: (dwCfg?.['debounceMs'] as number) ?? 3000,
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
