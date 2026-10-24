/**
 * Compatibility export for callers that historically loaded the runtime
 * capability contract from the agent catalog. The contract itself lives in
 * `@wrongstack/contracts` so low-level prompt composition does not depend on
 * coordination.
 *
 * Named, not `export *`: esbuild drops a star re-export of an external package
 * from a module that is not a build entry, so `@wrongstack/core/agent-catalog`
 * shipped without these bindings and the standalone binary failed to link.
 * Only the names consumed through the catalog are listed; import the rest from
 * `@wrongstack/contracts/types/runtime-capability-manifest`.
 */
export {
  inferRuntimeCapabilities,
  missingRequiredRuntimeTools,
  missingRuntimeCapabilities,
  RUNTIME_CAPABILITY_MANIFEST,
  type RuntimeCapabilityDefinition,
  type RuntimeCapabilityExposure,
  type RuntimeCapabilityId,
  type RuntimeCapabilityPack,
  runtimeToolReferencesFromText,
  toolsForRuntimeCapabilities,
} from '@wrongstack/contracts/types/runtime-capability-manifest';
