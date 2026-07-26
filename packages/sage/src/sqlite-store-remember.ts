import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@wrongstack/core/utils';
import { rejectIfUnsafeInput } from './shared/candidate-lifecycle.js';
import { anchorsChanged } from './sqlite-store-anchor-diff.js';
import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { importanceFromPriority } from './sqlite-store-legacy.js';
import {
  clamp01,
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
  const nowIso = ctx.nowIso();

  return ctx.runMutation(() => {
    const canonical = normalizeTextKey(normalizedText);
    const audienceKey = audience ? JSON.stringify(audience) : null;
    const row = ctx
      .stmt(
        `SELECT data FROM memories
           WHERE status IN ('active','stale') AND scope = ? AND canonical_text = ?
             AND audience IS ?
           LIMIT 1`,
      )
      .get(scope, canonical, audienceKey) as { data: string } | undefined;

    if (row) {
      const existing = sqliteRowToMemory(row);
      const merged: Sage = {
        ...existing,
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
        contradicts: [
          ...new Set([...(existing.contradicts ?? []), ...(input.contradicts ?? [])]),
        ],
        importance: Math.max(
          existing.importance,
          clamp01(input.importance ?? importanceFromPriority(input.priority)),
        ),
        confidence: Math.max(existing.confidence, input.confidence ?? 0.8),
        freshness: Math.max(existing.freshness, input.freshness ?? 1),
        updatedAt: nowIso,
        revision: existing.revision + 1,
      };
      ctx.upsertMemory(merged);
      if (
        anchorsChanged(merged.anchors, existing.anchors) ||
        merged.confidence !== existing.confidence
      ) {
        ctx.syncAnchorEdges(merged);
      }
      ctx.emit('memory.merged', { memoryId: merged.id, mergedIds: [] });
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
      importance: clamp01(input.importance ?? importanceFromPriority(input.priority)),
      confidence: clamp01(input.confidence ?? 0.8),
      freshness: clamp01(input.freshness ?? 1),
      persistence: input.persistence,
      supersedes: input.supersedes,
      contradicts: input.contradicts,
      supersededBy: undefined,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    ctx.upsertMemory(memory);
    ctx.syncAnchorEdges(memory);
    ctx.emit('memory.accepted', {
      memoryId: memory.id,
      kind: memory.kind,
      persistence: memory.persistence ?? DEFAULT_PERSISTENCE,
      confidence: memory.confidence,
      freshness: memory.freshness,
    });
    return memory;
  });
}
