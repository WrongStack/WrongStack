/**
 * Redact governance credentials (`wsg_`-prefixed tokens) from a message and
 * cap its length. Single source of truth for the whole workspace — imported by
 * the governance runtime-compatibility and credential-lease paths, and
 * re-exported by `@wrongstack/runtime/governance-sanitize` for the CLI's
 * legacy-fallback path. Lives in `@wrongstack/governance` (a dependency-free
 * leaf package) so both governance and runtime can use it without an import
 * cycle (runtime depends on governance, never the reverse).
 */
export function sanitizeGovernanceMessage(message: string): string {
  if (typeof message !== 'string') return '';
  return message.replace(/wsg_[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/gu, '[credential]').slice(0, 512);
}
