/**
 * Dep-watcher bridge wiring. Lives in `@wrongstack/runtime/dep-watcher` so the standalone
 * engine behind WebUI/desktop wires the same bridge under the same config gate.
 */
export {
  type SetupDepWatcherBridgeDeps,
  type SetupDepWatcherBridgeResult,
  setupDepWatcherBridge,
} from '@wrongstack/runtime/dep-watcher';
