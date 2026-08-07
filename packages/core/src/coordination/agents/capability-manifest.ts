/**
 * Compatibility export for callers that historically loaded the runtime
 * capability contract from the agent catalog. The contract itself lives in
 * `types/` so low-level prompt composition does not depend on coordination.
 */
export * from '../../types/runtime-capability-manifest.js';
