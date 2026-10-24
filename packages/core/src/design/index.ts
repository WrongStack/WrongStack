// Design Studio public surface. The implementation remains in execution while
// consumers migrate away from the package root; this facade keeps design
// concerns independently addressable without exposing unrelated execution APIs.

export {
  type DesignKitLoader,
  type DesignStack,
  isDesignStack,
  type SkippedKitInfo,
} from '@wrongstack/contracts/types/design-kit';
export * from '../execution/design-capture.js';
export * from '../execution/design-deal.js';
export * from '../execution/design-detect.js';
export * from '../execution/design-dna.js';
export * from '../execution/design-dna-compare.js';
export * from '../execution/design-dna-extractor.js';
export * from '../execution/design-inspect.js';
export * from '../execution/design-inspect-extractor.js';
export * from '../execution/design-kit-loader.js';
export * from '../execution/design-materialize.js';
export * from '../execution/design-md.js';
export * from '../execution/design-md-diff.js';
export * from '../execution/design-project-store.js';
export * from '../execution/design-tune.js';
export * from '../execution/design-turn-gate.js';
export * from '../execution/design-verify.js';
export * from '../execution/design-verify-run.js';
