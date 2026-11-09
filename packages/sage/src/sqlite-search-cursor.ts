import { createHash } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type { SearchOptions, SearchQuery, SearchRanking } from './service-contract.js';
import { InvalidSearchCursorError } from './service-contract.js';
import type { SageStatus } from './types.js';

// ─── Deterministic cursor pagination (B3/B4) ─────────────────────────────

/** Cursor token format version — bump on any token-shape change. */
export const SEARCH_CURSOR_VERSION = 1;

export type CursorSortKey = 'bm25' | 'importance' | 'updatedAt' | 'id';

/**
 * The total-order sort keys for a ranking mode.
 *
 * Every mode ends with `id` so the order is STRICT — a deterministic cursor
 * walk requires a total order, and the pre-pagination ORDER BYs were only a
 * partial order: rows tying on every listed key had DB-defined order, so a
 * keyset walk could duplicate or skip them at page boundaries.
 *
 * Single source of truth: `buildOrderBy` renders these keys and
 * `buildKeysetPredicate` paginates on them, so ordering and pagination
 * cannot drift apart.
 */
export function rankingSortKeys(ranking: SearchRanking, hasBm25: boolean): CursorSortKey[] {
  switch (ranking) {
    case 'recency':
      return ['updatedAt', 'importance', 'id'];
    case 'importance':
      return ['importance', 'updatedAt', 'id'];
    default:
      // 'relevance' and 'hybrid' share the lexical-first order; without a
      // text query there is no bm25 and they collapse to importance-first.
      return hasBm25
        ? ['bm25', 'importance', 'updatedAt', 'id']
        : ['importance', 'updatedAt', 'id'];
  }
}

/** SQL expression for a sort key, with the memories-table alias when joined. */
export function keyExpr(key: CursorSortKey, fts: boolean): string {
  switch (key) {
    case 'bm25':
      return 'bm25(memories_fts)';
    case 'importance':
      return fts ? 'm.importance' : 'importance';
    case 'updatedAt':
      return fts ? 'm.updated_at' : 'updated_at';
    case 'id':
      return fts ? 'm.id' : 'id';
  }
}

/**
 * Build the ORDER BY clause for the given ranking mode.
 * Returns separate clauses for FTS (aliased `m.`) and non-FTS paths
 * because the FTS join requires the `m.` prefix on some columns.
 */
export function buildOrderBy(ranking: SearchRanking): { fts: string; nonFts: string } {
  const render = (keys: readonly CursorSortKey[], fts: boolean): string =>
    keys.map((key) => `${keyExpr(key, fts)} ${key === 'bm25' ? 'ASC' : 'DESC'}`).join(', ');
  return {
    fts: render(rankingSortKeys(ranking, true), true),
    nonFts: render(rankingSortKeys(ranking, false), false),
  };
}

/**
 * Build the keyset ("strictly after the cursor position") predicate for a
 * total order: for keys k1..kn, a row continues the walk iff it is beyond
 * the cursor on the FIRST key where it ties on all previous keys. Rendered
 * as a disjunction of progressively longer equality-prefixes — the SQL form
 * of tuple comparison.
 *
 * Descending keys continue with `<`, the ascending bm25 key with `>`.
 */
export function buildKeysetPredicate(
  keys: readonly CursorSortKey[],
  cursor: { bm25?: number; importance: number; updatedAt: string; id: string },
  fts: boolean,
): { clause: string; params: SQLInputValue[] } {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  for (let i = 0; i < keys.length; i++) {
    const conditions: string[] = [];
    for (let j = 0; j < i; j++) {
      const key = keys[j]!;
      const value = cursor[key];
      if (value === undefined) {
        throw new InvalidSearchCursorError(
          `Search cursor is missing the '${key}' sort key required by this ranking.`,
        );
      }
      params.push(value);
      conditions.push(`${keyExpr(key, fts)} = ?`);
    }
    const beyond = keys[i]!;
    const beyondValue = cursor[beyond];
    if (beyondValue === undefined) {
      throw new InvalidSearchCursorError(
        `Search cursor is missing the '${beyond}' sort key required by this ranking.`,
      );
    }
    params.push(beyondValue);
    conditions.push(`${keyExpr(beyond, fts)} ${beyond === 'bm25' ? '>' : '<'} ?`);
    parts.push(conditions.join(' AND '));
  }
  return { clause: `(${parts.join(' OR ')})`, params };
}

/**
 * Canonical binding of everything that defines the hit set and its order:
 * the text query, every whole-corpus filter, the ranking, and the session
 * context. The cursor carries a truncated SHA-256 of this string; replaying
 * a token under a different binding is a client error, not a silent first
 * page. Set-valued filters are sorted so parameter order never mints a
 * different hash for the same set.
 *
 * `limit` is deliberately excluded: keyset pagination is page-size
 * independent, so a walk may change page size mid-stream.
 */
export function computeCursorBinding(
  query: SearchQuery,
  statuses: readonly SageStatus[],
  ranking: SearchRanking,
  options: SearchOptions | undefined,
): string {
  const canonicalAudience = query.audience
    ? {
        roles: query.audience.roles ? [...query.audience.roles].sort() : undefined,
        taskTypes: query.audience.taskTypes ? [...query.audience.taskTypes].sort() : undefined,
        modes: query.audience.modes ? [...query.audience.modes].sort() : undefined,
      }
    : null;
  const canonicalAnchor = query.anchor
    ? {
        type: query.anchor.type ?? null,
        path: query.anchor.path ?? null,
        symbol: query.anchor.symbol ?? null,
        command: query.anchor.command ?? null,
        role: query.anchor.role ?? null,
      }
    : null;
  const canonical = JSON.stringify({
    text: query.text?.trim() ?? '',
    kinds: [...(query.kinds ?? [])].sort(),
    scopes: [...(query.scopes ?? [])].sort(),
    importanceAtLeast: query.importanceAtLeast ?? null,
    freshnessCreated: query.freshness?.createdAfter ?? null,
    freshnessVerified: query.freshness?.verifiedAfter ?? null,
    audience: canonicalAudience,
    anchor: canonicalAnchor,
    paths: [...(query.paths ?? [])].sort(),
    statuses: [...statuses].sort(),
    ranking,
    sessionId: options?.sessionId ?? null,
    includeAllSessions: options?.includeAllSessions ?? false,
    excludeSessionScoped: options?.excludeSessionScoped ?? false,
  });
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 22);
}

/**
 * Encode the next-page cursor: binding hash, ranking, channel, and the
 * anchor row's total-order tuple. base64url of a compact JSON payload —
 * opaque to callers, validated structurally on decode.
 */
export function encodeSearchCursor(args: {
  binding: string;
  ranking: SearchRanking;
  channel: 'fts' | 'plain';
  values: { bm25?: number; importance: number; updatedAt: string; id: string };
}): string {
  const payload: Record<string, unknown> = {
    v: SEARCH_CURSOR_VERSION,
    h: args.binding,
    r: args.ranking,
    c: args.channel,
    p: args.values.importance,
    u: args.values.updatedAt,
    i: args.values.id,
  };
  // The bm25 slot exists only for bm25-first rankings on the FTS channel;
  // its absence elsewhere is part of the token's shape validation.
  if (args.values.bm25 !== undefined) payload.b = args.values.bm25;
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode and STRICTLY validate a cursor token against the request that is
 * trying to replay it. Every failure mode throws {@link InvalidSearchCursorError}
 * — pagination never silently restarts on a bad or foreign token.
 */
export function decodeSearchCursor(
  token: string,
  expected: {
    binding: string;
    ranking: SearchRanking;
    channel: 'fts' | 'plain';
  },
): { bm25?: number; importance: number; updatedAt: string; id: string } {
  const fail = (why: string): never => {
    throw new InvalidSearchCursorError(
      `Invalid search cursor (${why}) — restart the search from the first page.`,
    );
  };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return fail('malformed token');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('malformed token');
  }
  if (parsed.v !== SEARCH_CURSOR_VERSION) return fail('unsupported version');
  if (typeof parsed.h !== 'string' || parsed.h !== expected.binding) {
    return fail('query/filter binding mismatch');
  }
  if (parsed.r !== expected.ranking) return fail('ranking mismatch');
  if (parsed.c !== expected.channel) return fail('channel mismatch');
  if (typeof parsed.i !== 'string' || parsed.i.length === 0) return fail('missing id');
  if (typeof parsed.u !== 'string' || parsed.u.length === 0) return fail('missing updatedAt');
  if (typeof parsed.p !== 'number' || !Number.isFinite(parsed.p)) {
    return fail('missing importance');
  }
  // The bm25 slot must be present exactly when the ranking's total order
  // starts with bm25 (relevance/hybrid on the FTS channel) — a token minted
  // by any other tuple shape must not replay against this one.
  const needsBm25 = rankingSortKeys(expected.ranking, expected.channel === 'fts').includes('bm25');
  if (needsBm25) {
    if (typeof parsed.b !== 'number' || !Number.isFinite(parsed.b)) {
      return fail('missing bm25');
    }
    return { bm25: parsed.b, importance: parsed.p, updatedAt: parsed.u, id: parsed.i };
  }
  if (parsed.b !== undefined) return fail('unexpected bm25');
  return { importance: parsed.p, updatedAt: parsed.u, id: parsed.i };
}
