/**
 * Compatibility re-export for the canonical model-reference parser.
 *
 * The single source of truth lives in `core/model-ref.ts` (`parseModelRef`).
 * This module was historically a separate near-duplicate implementation that
 * caused subtle drift between the LLM tools and the rest of the runtime.
 *
 * New code MUST import `parseModelRef` directly from `core/model-ref.js`.
 * This file is kept only so existing tests and consumers can keep their
 * `parseRefInternal` import working without churn — both names return the
 * same `{ provider, model }` shape with identical parsing rules.
 */

export type { ModelRef as ParsedRef } from '../core/model-ref.js';
export { parseModelRef as parseRefInternal } from '../core/model-ref.js';
