/**
 * Tech-stack consumer + package-outdated watcher wiring. Lives in
 * `@wrongstack/runtime/dep-watcher` so the standalone engine behind WebUI/desktop starts the
 * same consumers under the same config gate.
 */
export {
  type SetupDepWatcherConsumersDeps,
  setupDepWatcherConsumers,
} from '@wrongstack/runtime/dep-watcher';
