/**
 * HQ auth audit log — append-only JSONL record of token lifecycle events.
 *
 * Stored at `<dataDir>/auth-audit.jsonl`. One entry per token create /
 * revoke / first-run mint / live-reload-driven expiry sweep. Never holds
 * raw token strings — only the token id, label, scope, and actor.
 *
 * Design:
 * - **Append-only.** Nothing ever rewrites or deletes lines. Rotation is
 *   a separate operator concern (the file is bounded only by disk).
 * - **Synchronous append** via `appendFileSync` so a power loss between
 *   the CLI's mutate call and the audit write loses at most the audit
 *   entry, never the auth state. Errors are swallowed (best-effort).
 * - **Ring in memory** is intentionally NOT kept — this log is for
 *   long-term forensic review, not for live UI rendering. The HQ server
 *   doesn't load it; only the CLI mutators write to it.
 * - **No PII.** `actor` is a free-form string the caller fills with
 *   whatever identity context it has (CLI user, env var, machine id).
 *   The token `id` is a UUID — safe to log. The token `token` string
 *   is NEVER recorded.
 *
 * @module hq/auth-audit
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

/** Scope of the token the event is about. */
export type HqAuthAuditScope = 'browser' | 'client';

/** Kind of event recorded. */
export type HqAuthAuditKind =
  /** Token created via `wstack hq token create` (or first-run mint). */
  | 'create'
  /** Token revoked via `wstack hq token revoke`. */
  | 'revoke'
  /**
   * First-run bootstrap — both browser and client tokens minted by
   * `ensureHqFirstRunAuthFile`. Recorded once per fresh data dir;
   * subsequent calls (existing auth.json) do not log.
   */
  | 'first-run'
  /**
   * Operator edited `auth.json` directly and the HQ server's
   * live-reload watcher pruned one or more tokens whose `expiresAt`
   * had already passed. The entry records how many were pruned.
   */
  | 'expired-prune'
  /**
   * Password rotation — the operator changed the browser password, which
   * also rotated the cookie secret (invalidating all active sessions).
   * Recorded by `ensureHqFirstRunAuthFile` for the password-change path.
   */
  | 'password-rotate';

export interface HqAuthAuditEntry {
  /** Epoch milliseconds when the event was recorded. */
  at: number;
  kind: HqAuthAuditKind;
  scope: HqAuthAuditScope;
  /** Token id (UUID) — safe to log. Never the token string. */
  tokenId: string;
  /** Human-readable label, when the token carried one. */
  label?: string;
  /** Capabilities granted to the token, when known. */
  capabilities?: readonly string[];
  /** Optional expiresAt timestamp on the token (ISO). */
  expiresAt?: string;
  /**
   * Who performed the action. Free-form string — the CLI fills this with
   * the OS user + hostname when available. Never contains the token string.
   */
  actor?: string;
  /**
   * For `expired-prune`: how many tokens were filtered out by the
   * live-reload watcher in this reload. For other kinds: undefined.
   */
  prunedCount?: number;
  /**
   * SHA-256 hash (hex) of the redacted `auth.json` contents at the
   * moment of the event — lets an operator reviewing the audit log tie
   * an entry back to the exact on-disk state that produced it without
   * the log ever holding derivable token material. Computed by
   * `hqAuthContentHash` over a projection of the `HqAuthFile` with the
   * raw token strings, `passwordHash`, and `cookieSecret` replaced by
   * the constant sentinel `HQ_AUTH_CONTENT_HASH_REDACTED` (exported
   * from `@wrongstack/core`) — so two files that differ only in secrets
   * hash identically. Absent on entries emitted before the hash landed
   * and when the file is unreadable at emit time. Re-derivable from the
   * current `auth.json` via `hqAuthContentHash(await readHqAuthFile(dir))`.
   */
  contentHash?: string;
}

/** Path to `auth-audit.jsonl` under the given data dir. */
export function hqAuthAuditPath(dataDir: string): string {
  return path.join(dataDir, 'auth-audit.jsonl');
}

/**
 * Read the last `maxEntries` entries from the audit log.
 * Returns entries newest-first. If the file doesn't exist or is empty,
 * returns an empty array.
 */
export function readHqAuthAuditTail(dataDir: string, maxEntries = 50): HqAuthAuditEntry[] {
  const filePath = hqAuthAuditPath(dataDir);
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const lines = content.trimEnd().split('\n');
  const tail = lines.slice(-maxEntries);
  const entries: HqAuthAuditEntry[] = [];
  for (const line of tail) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as HqAuthAuditEntry);
    } catch {
      /* skip malformed line */
    }
  }
  return entries.reverse(); // newest first
}

/**
 * Append a single audit entry to `<dataDir>/auth-audit.jsonl`.
 *
 * Best-effort: errors are swallowed and the optional `onError` callback
 * is invoked instead. The caller's mutation (auth.json write, token
 * mint, etc.) has already succeeded by the time this is called, so a
 * failed audit append must never roll it back.
 *
 * The data dir is created if missing. The file is opened in append mode
 * so concurrent writers (e.g. two CLI invocations) do not clobber each
 * other — JSONL append is the safe granularity.
 */
export function appendHqAuthAudit(
  dataDir: string,
  entry: HqAuthAuditEntry,
  options?: { onError?: (err: Error) => void },
): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const line = `${JSON.stringify(entry)}\n`;
    appendFileSync(hqAuthAuditPath(dataDir), line, { encoding: 'utf8', flag: 'a' });
  } catch (err) {
    options?.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Convenience: build an entry with a sensible default `at` (now) and
 * append it. The `at` field can still be overridden via the partial.
 */
export function logHqAuthAudit(
  dataDir: string,
  partial: Omit<HqAuthAuditEntry, 'at'> & { at?: number },
  options?: { onError?: (err: Error) => void; now?: () => number },
): void {
  const at = partial.at ?? options?.now?.() ?? Date.now();
  const { at: _omit, ...rest } = partial;
  void _omit;
  appendHqAuthAudit(dataDir, { at, ...rest } as HqAuthAuditEntry, options);
}
