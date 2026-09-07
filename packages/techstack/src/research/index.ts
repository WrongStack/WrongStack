/**
 * TechStack — research stage barrel.
 *
 * @see docs/specs/techstack-sdd.md §31, §557
 */

export { createProviderLlm, type LlmAccessor, parseResearchJson } from './llm.js';
export { type CreateResearcherOptions, createResearcher } from './researcher.js';
export { createToolSearch, type SearchToolOptions } from './search.js';
export {
  clusterCandidates,
  DEFAULT_TRIAGE_LIMIT,
  type TriageOptions,
  triageCandidates,
} from './triage.js';
export type {
  ResearchCluster,
  ResearchLlm,
  ResearchLlmRequest,
  ResearchOptions,
  ResearchSearch,
  ResearchSearchResult,
  TechStackResearcher,
  TriageCandidate,
} from './types.js';
