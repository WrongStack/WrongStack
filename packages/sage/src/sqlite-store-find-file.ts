import { normalizeProjectPath, normalizeSlashes } from './paths.js';
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

function anchorPath(projectRoot: string, value: string): string | null {
  try {
    return normalizeProjectPath(projectRoot, value);
  } catch {
    const normalized = normalizeSlashes(value).replace(/^\.\/+/, '');
    return normalized.startsWith('../') ? null : normalized;
  }
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
  lineStart?: number,
  lineEnd?: number,
): { via: MemoryMatchVia; strength: number } | null {
  for (const anchor of memory.anchors) {
    if (!anchor.path) continue;
    const normalized = anchorPath(projectRoot, anchor.path);
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
  const pendingByMemoryId = new Map<
    string,
    NonNullable<MemoryForFileMatch['pendingReview']>
  >();

  try {
    for (const candidate of await ctx.listCandidates()) {
      if (candidate.status !== 'pending') continue;
      const sourceId = candidate.tags.find((tag) => tag.startsWith('source:'))?.slice(7);
      if (!sourceId || !memoryById.has(sourceId)) continue;
      const action = candidate.tags
        .find((tag) => tag.startsWith('suggested:'))
        ?.slice('suggested:'.length);
      pendingByMemoryId.set(sourceId, {
        candidateId: candidate.id,
        reason:
          candidate.tags.find((tag) => tag.startsWith('review:'))?.slice('review:'.length) ??
          candidate.kind,
        suggestedAction:
          action === 'delete' || action === 'archive' || action === 'update'
            ? action
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

  for (const memory of memories) {
    if (memory.status === 'deleted' && !includeDeleted) continue;
    if (memory.status === 'superseded' && !includeSuperseded) continue;
    const matched = matchMemory(
      ctx.projectRoot,
      memory,
      target,
      basename,
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
