export { assessAtomicity, candidateFromKanbanTask, hashAtomicityConfig } from './assess.js';
export {
  type AtomicityCandidate,
  type AtomicityCriterion,
  type AtomicityCriterionId,
  buildDefaultRuleSet,
  countScopeMarkers,
  DEFAULT_ATOMICITY_CONFIG,
  type ResolvedAtomicityConfig,
  resolveAtomicityConfig,
} from './criteria.js';
