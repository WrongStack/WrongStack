/**
 * Backward-compatible service entry point.
 *
 * The engine implementation is split by pipeline responsibility under
 * `service/`; existing imports from `service.js` remain stable.
 */

export type { AnalyzeOptions, EnrichOptions, ReportFormat } from './service/techstack-engine.js';
export { TechStackEngine } from './service/techstack-engine.js';
