import { normalizeProjectPath, normalizeSlashes } from './paths.js';
import { isVisibleToSession } from './sqlite-store-search-helpers.js';
import type {
  FindMemoriesForFileOptions,
  FindMemoriesForFileResponse,
  MemoryCandidate,
  MemoryForFileMatch,
  MemoryMatchVia,
  Sage,
} from './types.js';

interface SqliteFindFileContext {
  projectRoot: string;
  listMemories(): Sage[];
  listCandidates(): Promise<MemoryCandidate[]>;
  now(): Date;
}

/**
 * Normalize one anchor path, memoized for the lifetime of a single query.
 *
 * `normalizeProjectPath` performs two uncached `fs.realpathSync` calls per
 * invocation (the parent and the leaf — `paths.ts`'s `realpathCache` only
 * covers the project root). A single `findMemoriesForFile` over a mature
 * store walks every anchor of every memory, and those anchors repeat heavily:
 * measured on a real 11k-memory store, 5,920 anchor paths collapse to 1,216
 * distinct ones, and the ~11,800 resulting syscalls accounted for ~865ms of a
 * ~950ms query — a full second of lag on every file click in the WebUI.
 *
 * The memo is deliberately **per call**: it cannot go stale, so it preserves
 * `normalizeProjectPath`'s semantics exactly, including its containment check
 * (a leaf symlink that escapes the project root still throws and still maps to
 * `null`). A process-lifetime cache would have to remember *misses* too — and
 * a cached miss is what would let a symlink created after the first lookup
 * slip past that check.
 */
function anchorPath(
  projectRoot: string,
  value: string,
  cache: Map<string, string | null>,
): string | null {
  const cached = cache.get(value);
  if (cached !== undefined) return cached;
  let resolved: string | null;
  try {
    resolved = normalizeProjectPath(projectRoot, value);
  } catch {
    const normalized = normalizeSlashes(value).replace(/^\.\/+/, '');
    resolved = normalized.startsWith('../') ? null : normalized;
  }
  cache.set(value, resolved);
  return resolved;
}

/**
 * Descending byte comparison for ISO-8601 timestamps (newest first),
 * matching the sign convention of `compareByUpdatedDesc` in
 * `shared/pagination.ts`. `localeCompare` is locale-aware and can reorder
 * ASCII-only ISO strings across locales. Valid for uniform-format strings
 * (all writers use `new Date().toISOString()`); mixed precision (with/without
 * milliseconds) does not compare byte-wise chronologically.
 */
function compareIsoDescending(a: string, b: string): number {
  if (a > b) return -1;
  if (a < b) return 1;
  return 0;
}

function matchMemory(
  projectRoot: string,
  memory: Sage,
  target: string,
  basename: string,
  anchorCache: Map<string, string | null>,
  lineStart?: number,
  lineEnd?: number,
): { via: MemoryMatchVia; strength: number } | null {
  for (const anchor of memory.anchors) {
    if (!anchor.path) continue;
    const normalized = anchorPath(projectRoot, anchor.path, anchorCache);
    if (!normalized) continue;
    if (normalized === target) {
      if (anchor.type === 'symbol') {
        const overlaps =
          lineStart !== undefined &&
          lineEnd !== undefined &&
          anchor.lineStart !== undefined &&
          anchor.lineEnd !== undefined &&
          lineStart <= anchor.lineEnd &&
          lineEnd >= anchor.lineStart;
        if (memory.scope === 'symbol') {
          return { via: 'scope_symbol', strength: overlaps ? 1 : 0.92 };
        }
        return { via: 'anchor_symbol', strength: overlaps ? 0.95 : 0.75 };
      }
      if (memory.scope === 'file') return { via: 'scope_file', strength: 1 };
      return { via: 'anchor_file', strength: 0.9 };
    }
    if (
      (anchor.type === 'directory' || anchor.type === 'package') &&
      target.startsWith(`${normalized}/`)
    ) {
      return { via: 'anchor_directory', strength: 0.5 };
    }
  }
  if (basename && memory.text.toLowerCase().includes(basename.toLowerCase())) {
    return { via: 'mention', strength: 0.3 };
  }
  return null;
}

export async function findSqliteMemoriesForFile(
  ctx: SqliteFindFileContext,
  filePath: string,
  options: FindMemoriesForFileOptions = {},
): Promise<FindMemoriesForFileResponse> {
  const target = normalizeProjectPath(ctx.projectRoot, filePath);
  const basename = target.split('/').at(-1) ?? '';
  const includeSuperseded = options.includeSuperseded !== false;
  const includeDeleted = options.includeDeleted === true;
  const limit = Math.max(1, Math.min(250, Math.floor(options.limit ?? 50)));
  const memories = ctx.listMemories();
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const pendingByMemoryId = new Map<string, NonNullable<MemoryForFileMatch['pendingReview']>>();

  try {
    for (const candidate of await ctx.listCandidates()) {
      if (candidate.status !== 'pending') continue;
      // E1: correlation uses the typed targetMemoryId linkage (the legacy
      // `source:<id>` tag channel is fully retired); review metadata comes
      // from the typed reviewReason/suggestedAction fields.
      const sourceId = candidate.targetMemoryId ?? candidate.memoryId;
      if (!sourceId || !memoryById.has(sourceId)) continue;
      const suggestedAction = candidate.suggestedAction;
      pendingByMemoryId.set(sourceId, {
        candidateId: candidate.id,
        reason: candidate.reviewReason ?? candidate.kind,
        suggestedAction:
          suggestedAction === 'delete' ||
          suggestedAction === 'archive' ||
          suggestedAction === 'update'
            ? suggestedAction
            : 'investigate',
        ageDays: Math.max(
          0,
          Math.floor((ctx.now().getTime() - Date.parse(candidate.createdAt)) / 86_400_000),
        ),
      });
    }
  } catch {
    // File memory remains useful when review metadata is temporarily unavailable.
  }

  const primaryMatches: MemoryForFileMatch[] = [];
  const symbolMatches: MemoryForFileMatch[] = [];
  const relatedMatches: MemoryForFileMatch[] = [];
  // Scoped to this query only — see `anchorPath`.
  const anchorCache = new Map<string, string | null>();

  for (const memory of memories) {
    if (memory.status === 'deleted' && !includeDeleted) continue;
    if (memory.status === 'superseded' && !includeSuperseded) continue;
    // Session isolation, which this surface previously skipped entirely: with
    // no clause and no option to carry a session id, a file lookup returned
    // every session's session-scoped memories to whoever asked.
    if (!isVisibleToSession(memory, options)) continue;
    const matched = matchMemory(
      ctx.projectRoot,
      memory,
      target,
      basename,
      anchorCache,
      options.lineStart,
      options.lineEnd,
    );
    if (!matched) continue;
    const head =
      memory.status === 'superseded' && memory.supersededBy
        ? memoryById.get(memory.supersededBy)
        : undefined;
    const match: MemoryForFileMatch = {
      memory,
      matchedVia: matched.via,
      matchStrength: matched.strength,
      ...(head?.status === 'active' ? { supersededByActiveId: head.id } : {}),
      ...(pendingByMemoryId.has(memory.id)
        ? { pendingReview: pendingByMemoryId.get(memory.id) }
        : {}),
    };
    if (matched.via === 'scope_symbol' || matched.via === 'anchor_symbol') {
      symbolMatches.push(match);
    } else if (matched.via === 'mention') {
      relatedMatches.push(match);
    } else {
      primaryMatches.push(match);
    }
  }

  const sorter = (left: MemoryForFileMatch, right: MemoryForFileMatch): number =>
    right.matchStrength - left.matchStrength ||
    compareIsoDescending(left.memory.updatedAt, right.memory.updatedAt);
  primaryMatches.sort(sorter);
  symbolMatches.sort(sorter);
  relatedMatches.sort(sorter);
  const primary = primaryMatches.slice(0, limit);
  const symbol = symbolMatches.slice(0, limit);
  const related = relatedMatches.slice(0, limit);
  const returned = [...primary, ...symbol, ...related];
  return {
    filePath: target,
    primaryMatches: primary,
    symbolMatches: symbol,
    relatedMatches: related,
    totalCount: returned.length,
    activeCount: returned.filter((match) => match.memory.status === 'active').length,
    supersededCount: returned.filter((match) => match.memory.status === 'superseded').length,
    reviewPendingCount: returned.filter((match) => match.pendingReview !== undefined).length,
  };
}
