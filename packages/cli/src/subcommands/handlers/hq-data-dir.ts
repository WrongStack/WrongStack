import { resolveHqDataDir } from '@wrongstack/hq';
import type { SubcommandDeps } from '../contracts.js';

// ── --ttl parsing ──────────────────────────────────────────────────────────
//
// Delegates to the shared `parseTokenTtlValue` from utils/hq-ttl.ts so the
// same syntax (1h, 7d, 3600s, bare ms) is accepted here and in the
// server-startup `--hq-token-ttl` flag.

/**
 * Build a free-form actor string for the auth audit log. Combines the OS
 * username (best-effort) with the hostname so an operator reviewing the
 * log can see "who minted this token" without parsing environment
 * variables. Never includes the token string.
 *
 * Shared by the `wstack hq token` create/revoke handlers and by
 * `startHqServer`'s first-run bootstrap so every audit entry point
 * produces the same actor shape.
 */
export function resolveDataDir(deps: SubcommandDeps): string {
  const override =
    typeof deps.flags?.['data-dir'] === 'string' ? deps.flags['data-dir'] : undefined;
  return resolveHqDataDir(override);
}
