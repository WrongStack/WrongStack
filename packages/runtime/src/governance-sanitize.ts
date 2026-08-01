/**
 * Redact governance credentials (`wsg_`-prefixed tokens) from a message and
 * cap its length. Single source of truth — imported by both the governance
 * runtime bootstrap (`governance-bootstrap.ts`) and the CLI's legacy-fallback
 * path (`cli-main-helpers.ts`) so the redaction format cannot drift between
 * them (Chimera MEDIUM — byte-for-byte duplicate).
 *
 * Lives in its own module (not `governance-bootstrap.ts`) so the CLI can import
 * it statically without eagerly loading the governance bootstrap — the CLI uses
 * it precisely in the path that runs when that dynamic import fails
 * (`module_unavailable`).
 */
export function sanitizeGovernanceMessage(message: string): string {
  return message.replace(/wsg_\S{1,700}/gu, '[credential]').slice(0, 512);
}
