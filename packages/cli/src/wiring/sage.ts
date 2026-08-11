/**
 * CLI host adapter for shared SAGE wiring.
 *
 * Implementation lives in `@wrongstack/sage` so CLI and WebUI cannot drift.
 */
export {
  AUTO_HYGIENE_INTERVAL_MS,
  _resetAutoHygieneThrottleForTesting,
  sageHygieneOptionsFromConfig,
  setupSage,
  type SageHostWiringDeps as SageWiringDeps,
} from '@wrongstack/sage';
