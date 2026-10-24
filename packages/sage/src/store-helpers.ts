/**
 * Pure helper functions shared across store implementations.
 * These functions have no side effects and no dependency on the store instance.
 */

import type { MemoryScope } from '@wrongstack/contracts/types';
import { normalizeProjectPath, normalizeSlashes } from './paths.js';
import { legacyToSageScope, type MemoryAnchor, type Sage, type SageScope } from './types.js';

export {
  assessRememberQuality,
  isEphemeralMemoryText,
  MAX_MEMORY_METADATA_ITEMS,
  MAX_MEMORY_TEXT_CHARS,
  normalizeAudience,
  STRUCTURAL_KINDS,
  VALID_KINDS,
  validateMemoryAnchors,
  validateMemoryTags,
  validateRememberInput,
} from './memory-input-validation.js';
export {
  isNearDuplicateMemory,
  isPossiblyContradictory,
  scoreMemoryRelationship,
} from './memory-similarity.js';
export { canonicalMemoryText, normalizeText, normalizeTextKey, tokenize } from './memory-text.js';

export function normalizeTags(tags: string[] | undefined): string[] {
  return [
    ...new Set(
      (tags ?? []).map((tag) => tag.replace(/^#/, '').trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

export function normalizeAnchors(projectRoot: string, anchors: MemoryAnchor[]): MemoryAnchor[] {
  return dedupeAnchors(
    anchors.map((anchor) => ({
      ...anchor,
      path: anchor.path ? normalizeProjectPath(projectRoot, anchor.path) : undefined,
      symbol: anchor.symbol?.trim() || undefined,
      command: anchor.command?.trim().replace(/\s+/g, ' ') || undefined,
      role: anchor.role?.trim().toLowerCase() || undefined,
    })),
  );
}

export function normalizeSources(sources: Sage['sources']): Sage['sources'] {
  return dedupeSources(
    sources.map((source) => ({
      ...source,
      path: source.path ? normalizeSlashes(source.path.trim()) : undefined,
      command: source.command?.trim().replace(/\s+/g, ' ') || undefined,
    })),
  );
}

// ─── Private dedup helpers ──────────────────────────────────────────────

function dedupeAnchors(anchors: MemoryAnchor[]): MemoryAnchor[] {
  return dedupeByKey(anchors, (anchor) =>
    JSON.stringify([
      anchor.type,
      anchor.path ?? null,
      anchor.symbol ?? null,
      anchor.command ?? null,
      anchor.role ?? null,
      anchor.contentHash ?? null,
      anchor.gitBlobHash ?? null,
      anchor.lineStart ?? null,
      anchor.lineEnd ?? null,
    ]),
  );
}

function dedupeSources(sources: Sage['sources']): Sage['sources'] {
  return dedupeByKey(sources, (source) =>
    JSON.stringify([
      source.type,
      source.sessionId ?? null,
      source.toolUseId ?? null,
      source.path ?? null,
      source.command ?? null,
      source.excerptHash ?? null,
    ]),
  );
}

function dedupeByKey<T>(values: T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Secret-detection guard (shared by JSONL and SQLite stores) ─────

/**
 * Check whether `text` looks like a secret or credential.
 * Used by both legacy and current store implementations to reject
 * unsafe candidate proposals before they reach the ReviewQueue.
 */
// Single anchored alternation covering every provider. Replaces the
// previous 11-regex array (which ran in O(11) per text node via
// .some(pattern => pattern.test(text))) with one engine pass. Each
// alternative is the full body of the original pattern verbatim —
// boundaries, character classes, and quantifiers are preserved
// exactly, so the synthetic-token fixtures in store-helpers.test.ts
// continue to match without modification. Unified flag is /i to
// preserve the generic env-style key=value match
// (api|secret|token|password, any case); the trade-off is that
// AWS AKIA matches case-insensitively (akia... would also match),
// but no real akia-prefixed token exists, so the false-positive
// cost is nil.
//
// Compiled once at module load rather than per call: `looksLikeSecret` runs
// against every nested string of a candidate (collectStringValues walks text,
// tags, anchors, sources), so rebuilding a ten-alternative pattern inside the
// function body paid the regex compiler on every string. No /g or /y flag, so
// the shared instance carries no lastIndex state between calls.
const SECRET_PATTERN = new RegExp(
  [
    // ` BLOCK`: a PGP armor header ends in `PRIVATE KEY BLOCK` plus dashes.
    '-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----',
    // Env-style `KEY = VALUE`. The keyword boundaries are lookarounds over
    // ALPHANUMERICS rather than `\b`, because `_` is a word character: with
    // `\b` there is no boundary inside `AWS_SECRET_ACCESS_KEY`, so the
    // alternative could not match the env-var spelling of its own keywords —
    // and `api[_-]?key` shows underscore spelling was the intent. The trailing
    // `[A-Za-z0-9_.-]*` consumes the rest of an env-var name so `=` can still
    // be reached (`..._ACCESS_KEY=`). The keyword must remain a whole segment:
    // an alphanumeric on either side still disqualifies the match, so
    // `mytoken=`/`secretly=` stay clean.
    '(?<![A-Za-z0-9])(?:api[_-]?key|secret|token|password)(?![A-Za-z0-9])[A-Za-z0-9_.-]*\\s*[:=]\\s*[\'"]?[A-Za-z0-9_\\-./+=]{16,}',
    '\\b[A-Za-z0-9_]{20,}\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\b',
    '\\b(?:sk-(?:ant-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{16,}\\b',
    '\\bAKIA[0-9A-Z]{16}\\b',
    '\\bAIza[0-9A-Za-z_-]{35}\\b',
    '\\bhf_[A-Za-z0-9]{20,}\\b',
    '\\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\\b',
    '\\bnpm_[A-Za-z0-9]{36,}\\b',
    '\\b[MNO][A-Za-z\\d]{23,}\\.[A-Za-z\\d_-]{6,}\\.[A-Za-z\\d_-]{27,}\\b',
  ].join('|'),
  'i',
);

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERN.test(text);
}

/**
 * Recursively collect every string value from a nested object/array.
 * Walks arrays and object values so every user-supplied field (text,
 * tags, anchors, sources, etc.) can be checked for unsafe content.
 */
export function collectStringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStringValues(item, out);
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>))
      collectStringValues(item, out);
  }
  return out;
}

/**
 * Clamp a number into the [0, 1] range. Non-finite inputs collapse to 0,
 * which is the safe default for score-like values (a missing or NaN
 * score should not auto-accept or auto-reject in any non-trivial way).
 *
 * Shared across `SqliteSageStore`, the
 * memory-graph helpers, and `shared/session-consolidation` so every
 * score normalisation agrees on the same edge-case behaviour.
 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Build a `(scope = ? OR legacy_scope = ?)` SQL fragment for legacy scope
 * filters. The two columns exist on the `memories` table so the predicate
 * matches both modern Sage-scope rows (`scope` column) and legacy-import
 * rows (`legacy_scope` column) without a JSON parse.
 *
 * Returns the **bare** predicate (no leading `AND`); callers prefix it
 * themselves to splice into their WHERE clause. This keeps the helper
 * independent of the surrounding condition (`status != 'deleted'`,
 * `status IN ('active','stale')`, etc.) that each callsite owns.
 *
 * Always emits the same two bind parameters so the helper is a true
 * source of truth for the dual-column filter — eliminate the four
 * near-identical copies that today each redeclare the same fragment.
 *
 * Replaces: `sqlite-store-legacy-clear.ts`, `sqlite-store-legacy-list.ts`,
 * `sqlite-store-legacy-forget.ts`, `sqlite-store-legacy-consolidate.ts`.
 */
export function legacyScopeFilterClause(scope: MemoryScope): {
  clause: string;
  params: [SageScope, MemoryScope];
} {
  return {
    clause: '(scope = ? OR legacy_scope = ?)',
    params: [legacyToSageScope(scope), scope],
  };
}

// ─── Live advisory counters (H6, docs/archive/plans/sage-phase4-design.md) ────────────

const LIVE_COUNTER_COUNT_KEYS = ['injectionCount', 'useCount'] as const;
const LIVE_COUNTER_STAMP_KEYS = ['lastUsedAt', 'lastAccessedAt'] as const;

function isValidIsoStamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

/**
 * Carry live advisory counters forward through a whole-column memory write.
 *
 * `recordSqliteInjection` / `recordSqliteUse` run on the independent counter
 * chain and `json_set` four keys inside `data`: `injectionCount`, `useCount`,
 * `lastUsedAt`, `lastAccessedAt`. A content write (remember merge, update,
 * verification) replaces the whole column from an in-memory object that was
 * read earlier — an advisory bump committing between that read and the
 * write-back would be silently lost. Merging from the row that is about to be
 * replaced keeps the bump (H6, docs/archive/plans/sage-phase4-design.md).
 *
 * - No previous row (`previousData` undefined/empty) → `next` returned
 *   untouched: new memories have nothing to reconcile.
 * - A corrupt or non-object previous row → `next` untouched: counters are
 *   advisory and loss-tolerant, and must never fail a content write.
 * - Counts take the max of both sides; ISO stamps keep the newer (byte-wise —
 *   both producers write `toISOString()` output). Keys absent on both sides
 *   stay absent; every other field comes from `next` unchanged.
 */
export function mergeLiveCounterFields(previousData: string | undefined, next: Sage): Sage {
  if (!previousData) return next;
  let previous: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(previousData);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return next;
    previous = parsed as Record<string, unknown>;
  } catch {
    return next;
  }
  const merged = { ...next } as Sage & Record<string, unknown>;
  for (const key of LIVE_COUNTER_COUNT_KEYS) {
    const previousValue: unknown = previous[key];
    const nextValue: unknown = merged[key];
    const previousCount =
      typeof previousValue === 'number' && Number.isFinite(previousValue) ? previousValue : 0;
    const nextCount = typeof nextValue === 'number' && Number.isFinite(nextValue) ? nextValue : 0;
    if (previousCount > 0 || nextCount > 0) merged[key] = Math.max(previousCount, nextCount);
  }
  for (const key of LIVE_COUNTER_STAMP_KEYS) {
    const previousStamp = isValidIsoStamp(previous[key]) ? previous[key] : undefined;
    const nextStamp = isValidIsoStamp(merged[key]) ? merged[key] : undefined;
    if (previousStamp === undefined) {
      if (nextStamp !== undefined) merged[key] = nextStamp;
      continue;
    }
    if (nextStamp === undefined) {
      merged[key] = previousStamp;
      continue;
    }
    merged[key] = previousStamp >= nextStamp ? previousStamp : nextStamp;
  }
  return merged;
}
