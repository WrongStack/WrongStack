/**
 * Dependency watcher → automatic tech-stack audits, for every host.
 *
 * `setupDepWatcherBridge` posts dependency-manifest changes to the project mailbox;
 * `setupDepWatcherConsumers` picks them up and spawns the tech-stack audit, and runs the
 * package-outdated watcher. Both read `extensions."file-watcher".depWatcher` (default on;
 * only `enabled: false` opts out). The CLI and the standalone engine behind WebUI/desktop call
 * the same two functions.
 */
export {
  type SetupDepWatcherBridgeDeps,
  type SetupDepWatcherBridgeResult,
  setupDepWatcherBridge,
} from './dep-watcher/bridge.js';
export {
  type DepWatcherAuditHost,
  type DepWatcherLogger,
  type SetupDepWatcherConsumersDeps,
  setupDepWatcherConsumers,
} from './dep-watcher/consumers.js';
