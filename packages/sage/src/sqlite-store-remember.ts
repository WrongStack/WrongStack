import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@wrongstack/core/utils';
import { rejectIfUnsafeInput } from './shared/candidate-lifecycle.js';
import { anchorsChanged } from './sqlite-store-anchor-diff.js';
import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { importanceFromPriority } from './sqlite-store-legacy.js';
import { ftsPrefixTerms } from './sqlite-store-search-helpers.js';
import {
  assessRememberQuality,
  clamp01,
  isNearDuplicateMemory,
  isPossiblyContradictory,
  normalizeAnchors,
  normalizeAudience,
  normalizeSources,
  normalizeTags,
  normalizeText,
  normalizeTextKey,
  validateRememberInput,
} from './store-helpers.js';
import type { MemoryAnchor, RememberSageInput, Sage } from './types.js';
import { DEFAULT_PERSISTENCE, legacyToSageScope, legacyTypeToKind } from './types.js';

interface RememberSqliteSageContext {
  input: RememberSageInput;
  projectRoot: string;
  initialize: () => Promise<void>;
  nowIso: () => string;
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  runMutation: <T>(work: () => T) => Promise<T>;
  upsertMemory: (memory: Sage) => void;
  syncAnchorEdges: (memory: Sage) => void;
  emit: (event: 'memory.merged' | 'memory.accepted', payload: Record<string, unknown>) => void;
}

export async function rememberSqliteSage(ctx: RememberSqliteSageContext): Promise<Sage> {
  const { input } = ctx;
  rejectIfUnsafeInput(input);
  validateRememberInput(input);
  const normalizedText = normalizeText(input.text);
  if (!normalizedText) throw new Error('SAGE text must not be empty.');
  await ctx.initialize();

  const scope = input.scope ?? legacyToSageScope(input.legacyScope ?? 'project-memory');
  const legacyScope = input.legacyScope;
  const kind = input.kind ?? legacyTypeToKind(input.type);
  const tags = normalizeTags(input.tags);
  const anchors = normalizeAnchors(ctx.projectRoot, input.anchors ?? []);
  const audience = normalizeAudience(input.audience);
  const sources = normalizeSources(input.sources ?? [{ type: 'user' }]);
  const quality = assessRememberQuality({
    text: normalizedText,
    kind,
    anchors,
    tags,
    scope,
  });
  const requestedImportance = clamp01(input.importance ?? importanceFromPriority(input.priority));
  const requestedConfidence = clamp01(input.confidence ?? 0.8);
  // Explicit caller scores (including legacy priority labels) are authoritative.
  // Soft quality caps only demote *defaulted* scores so unanchored auto-writes
  // do not outrank anchored knowledge, without fighting intentional critical/high.
  const importance =
    input.importance !== undefined || input.priority !== undefined
      ? requestedImportance
      : Math.min(requestedImportance, quality.importanceCap);
  const confidence =
    input.confidence !== undefined
      ? requestedConfidence
      : Math.min(requestedConfidence, quality.confidenceCap);
  const freshness = clamp01(input.freshness ?? 1);
  const nowIso = ctx.nowIso();

  return ctx.runMutation(() => {
    const canonical = normalizeTextKey(normalizedText);
    const audienceKey = audience ? JSON.stringify(audience) : null;
    // Session-scoped writes must only match memories owned by the same
    // session — otherwise session B silently merges into session A's memory.
    const sessionMatchClause =
      scope === 'session' && input.ownerSessionId ? ' AND owner_session_id = ?' : '';
    const sessionMatchParams =
      scope === 'session' && input.ownerSessionId
        ? ([input.ownerSessionId] as const)
        : ([] as const);
    const exactRow = ctx
      .stmt(
        `SELECT data FROM memories
           WHERE status IN ('active','stale') AND scope = ? AND canonical_text = ?
             AND audience IS ?
             ${sessionMatchClause}
           LIMIT 1`,
      )
      .get(scope, canonical, audienceKey, ...sessionMatchParams) as { data: string } | undefined;

    const existing =
      (exactRow ? sqliteRowToMemory(exactRow) : undefined) ??
      findNearDuplicate(ctx, {
        scope,
        audienceKey,
        kind,
        text: normalizedText,
        anchors,
        ...(scope === 'session' && input.ownerSessionId
          ? { ownerSessionId: input.ownerSessionId }
          : {}),
      });

    if (existing) {
      // Prefer the richer wording when near-dup merge finds a paraphrase, but
      // keep the exact canonical text when the match was identity-level.
      const preferIncomingText =
        !exactRow &&
        tokenizeCount(normalizedText) > tokenizeCount(existing.text) &&
        normalizedText.length > existing.text.length;
      const merged: Sage = {
        ...existing,
        text: preferIncomingText ? normalizedText : existing.text,
        legacyScope: existing.legacyScope,
        tags: [...new Set([...existing.tags, ...tags])],
        anchors: [
          ...new Map(
            [...existing.anchors, ...anchors].map((a) => [
              JSON.stringify(a, Object.keys(a).sort()),
              a,
            ]),
          ).values(),
        ] as MemoryAnchor[],
        ...(audience ? { audience } : {}),
        sources: [
          ...new Map([...existing.sources, ...sources].map((s) => [JSON.stringify(s), s])).values(),
        ],
        supersedes: [...new Set([...(existing.supersedes ?? []), ...(input.supersedes ?? [])])],
        contradicts: [...new Set([...(existing.contradicts ?? []), ...(input.contradicts ?? [])])],
        importance: Math.max(existing.importance, importance),
        confidence: Math.max(existing.confidence, confidence),
        freshness: Math.max(existing.freshness, freshness),
        ...(input.persistence !== undefined
          ? {
              persistence:
                (existing.persistence ?? DEFAULT_PERSISTENCE) === 'permanent' &&
                input.persistence !== 'permanent'
                  ? 'permanent'
                  : input.persistence,
            }
          : {}),
        updatedAt: nowIso,
        revision: existing.revision + 1,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        // ownerSessionId is preserved on merge. The strict SQL clause
        // (owner_session_id = ?) guarantees the existing row is owned by
        // the same session, so existing.ownerSessionId is always set here.
        // No fallback to input.ownerSessionId is needed — the merge can
        // only match same-session records.
        ...(scope === 'session' && existing.ownerSessionId
          ? { ownerSessionId: existing.ownerSessionId }
          : {}),
      };
      ctx.upsertMemory(merged);
      if (
        anchorsChanged(merged.anchors, existing.anchors) ||
        merged.confidence !== existing.confidence ||
        merged.text !== existing.text ||
        // The merge unions `supersedes`/`contradicts` above, so a merge can
        // introduce a relationship the graph has never seen while anchors,
        // text and confidence all stay put. Skipping the sync then loses the
        // assertion entirely — the row JSON keeps it, the graph never does.
        relationshipsGrew(merged, existing)
      ) {
        ctx.syncAnchorEdges(merged);
      }
      ctx.emit('memory.merged', {
        memoryId: merged.id,
        mergedIds: [],
        nearDuplicate: !exactRow,
        qualityReasons: quality.reasons,
      });
      return merged;
    }

    const memory: Sage = {
      id: ulid(),
      revision: 1,
      text: normalizedText,
      kind,
      scope,
      legacyScope,
      status: 'active',
      tags,
      anchors,
      sources,
      audience,
      importance,
      confidence,
      freshness,
      persistence: input.persistence,
      supersedes: input.supersedes,
      contradicts: input.contradicts,
      supersededBy: undefined,
      createdAt: nowIso,
      updatedAt: nowIso,
      ...(scope === 'session' && input.ownerSessionId
        ? { ownerSessionId: input.ownerSessionId }
        : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    ctx.upsertMemory(memory);
    ctx.syncAnchorEdges(memory);
    ctx.emit('memory.accepted', {
      memoryId: memory.id,
      kind: memory.kind,
      persistence: memory.persistence ?? DEFAULT_PERSISTENCE,
      confidence: memory.confidence,
      freshness: memory.freshness,
      qualityReasons: quality.reasons,
    });
    return memory;
  });
}

function findNearDuplicate(
  ctx: Pick<RememberSqliteSageContext, 'stmt'>,
  opts: {
    scope: string;
    audienceKey: string | null;
    kind: Sage['kind'];
    text: string;
    anchors: MemoryAnchor[];
    ownerSessionId?: string | undefined;
  },
): Sage | undefined {
  // Bound the scan: near-dup is a quality feature, not a full-corpus join.
  // Session-scoped writes only match memories owned by the same session.
  const sessionClause =
    opts.scope === 'session' && opts.ownerSessionId ? ' AND owner_session_id = ?' : '';
  const sessionParams =
    opts.scope === 'session' && opts.ownerSessionId ? [opts.ownerSessionId] : [];

  // Two candidate windows, unioned by id.
  //
  // The importance window is the historical one: the 64 highest-importance
  // rows in the scope. It is a good *tie-breaker* pool and a bad *recall*
  // pool — it is ordered by a signal that has nothing to do with the text
  // being written, so a paraphrase of an ordinary 0.5-importance memory was
  // invisible to dedupe on any project with more than 64 memories in the
  // scope. That is precisely the corpus size where duplicates start to hurt.
  //
  // The lexical window fixes the recall side: seed the scan with the rows FTS
  // ranks closest to the incoming text. `isNearDuplicateMemory` still makes
  // the actual call — this only decides which rows it gets to see.
  const rows = new Map<string, { data: string }>();
  const importanceRows = ctx
    .stmt(
      `SELECT id, data FROM memories
         WHERE status IN ('active','stale') AND scope = ? AND audience IS ?
         ${sessionClause}
         ORDER BY importance DESC, updated_at DESC
         LIMIT 64`,
    )
    .all(opts.scope, opts.audienceKey, ...sessionParams) as Array<{ id: string; data: string }>;
  for (const row of importanceRows) rows.set(row.id, { data: row.data });

  const terms = ftsPrefixTerms(opts.text);
  if (terms.length > 0) {
    try {
      // CROSS JOIN with memories_fts first — same join-order pin as every
      // other FTS read path in this package (see sqlite-store-search-sage.ts).
      const lexicalRows = ctx
        .stmt(
          `SELECT m.id AS id, m.data AS data FROM memories_fts f
             CROSS JOIN memories m ON m.rowid = f.rowid
             WHERE m.status IN ('active','stale') AND m.scope = ? AND m.audience IS ?
             ${sessionClause.replace('owner_session_id', 'm.owner_session_id')}
             AND memories_fts MATCH ?
             ORDER BY bm25(memories_fts) ASC
             LIMIT 32`,
        )
        .all(opts.scope, opts.audienceKey, ...sessionParams, terms.join(' OR ')) as Array<{
        id: string;
        data: string;
      }>;
      for (const row of lexicalRows) rows.set(row.id, { data: row.data });
    } catch {
      // FTS5 unavailable (or a malformed MATCH we already sanitize against):
      // dedupe degrades to the importance window rather than failing a write.
    }
  }

  let best: { memory: Sage; score: number } | undefined;
  for (const row of rows.values()) {
    const candidate = sqliteRowToMemory(row);
    if (
      !isNearDuplicateMemory(
        { text: opts.text, kind: opts.kind, anchors: opts.anchors },
        { text: candidate.text, kind: candidate.kind, anchors: candidate.anchors },
      )
    ) {
      continue;
    }
    // A polarity pair ("is stable" vs "is not stable") is NOT a duplicate —
    // merging it at write time would destroy the contradiction before the
    // hygiene pass can flag it. Create a separate memory instead.
    if (isPossiblyContradictory({ text: opts.text }, candidate)) continue;
    // Prefer same-kind already enforced; score by importance then recency.
    const score = candidate.importance * 2 + candidate.confidence + candidate.freshness;
    if (!best || score > best.score) best = { memory: candidate, score };
  }
  return best?.memory;
}

function tokenizeCount(text: string): number {
  // Local count avoids importing tokenize solely for length — keep merge hot path light.
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.-]+/u)
    .filter((term) => term.length >= 3).length;
}

/**
 * Did the merge introduce a `supersedes`/`contradicts` id the stored row did
 * not already carry? Only growth matters: the union above can never shrink an
 * array, and the relationship sync is insert-only, so an unchanged set has
 * nothing to assert.
 */
function relationshipsGrew(merged: Sage, existing: Sage): boolean {
  const grew = (next: string[] | undefined, prev: string[] | undefined): boolean => {
    if (!next || next.length === 0) return false;
    const before = new Set(prev ?? []);
    return next.some((id) => !before.has(id));
  };
  return (
    grew(merged.supersedes, existing.supersedes) || grew(merged.contradicts, existing.contradicts)
  );
}
