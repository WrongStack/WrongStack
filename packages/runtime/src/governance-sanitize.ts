/**
 * Re-export the governance-credential sanitizer from `@wrongstack/governance`
 * (its canonical home). The sanitizer lives in governance — a dependency-free
 * leaf package — so both governance and runtime can use it without an import
 * cycle (runtime depends on governance, never the reverse). Kept as a
 * `@wrongstack/runtime/governance-sanitize` subpath so the CLI's legacy-fallback
 * path can import it without eagerly loading `governance-bootstrap`.
 */
export { sanitizeGovernanceMessage } from '@wrongstack/governance';
