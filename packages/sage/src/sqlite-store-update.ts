import type { DatabaseSync } from 'node:sqlite';
import { applySpanBaselines, type SpanBaseline } from './anchors/symbol-span.js';

import { rejectIfUnsafeInput } from './shared/candidate-lifecycle.js';
import { normalizeValidity } from './shared/memory-validity.js';
import { appendModelFeedback } from './shared/model-feedback.js';
import { VALID_MEMORY_STATUSES } from './shared/pagination.js';
import { readSqliteSageRow } from './sqlite-store-codec.js';
import { cleanReferencingMemories, memoryNodeId } from './sqlite-store-graph-helpers.js';
import {
  clamp01,
  isEphemeralMemoryText,
  MAX_MEMORY_METADATA_ITEMS,
  MAX_MEMORY_TEXT_CHARS,
  normalizeAnchors,
  normalizeAudience,
  normalizeSources,
  normalizeTags,
  normalizeText,
  STRUCTURAL_KINDS,
  VALID_KINDS,
  validateMemoryAnchors,
  validateMemoryTags,
  validateRememberInput,
} from './store-helpers.js';
import type { Sage, SageStatus, UpdateSageInput } from './types.js';
import { DEFAULT_PERSISTENCE, VALID_PERSISTENCE } from './types.js';

interface SqliteUpdateContext {
  projectRoot: string;
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  nowIso: () => string;
  upsertMemory: (memory: Sage) => void;
  syncAnchorEdges: (memory: Sage) => void;
  cascadeDeleteEdges: (nodeId: string) => void;
  audit: (event: string, data?: Record<string, unknown>) => void;
  emitUpdated: (memory: Sage) => void;
  emitDeleted: (memory: Sage, reason: string, removedEdges: number) => void;
  /**
   * Symbol-span baselines read before the mutation (#418), for the anchors this update sets or,
   * when it confirms a stale memory as active, for the memory's own anchors.
   */
  spanBaselines?: ReadonlyMap<string, SpanBaseline> | undefined;
}

export function updateSqliteSage(
  ctx: SqliteUpdateContext,
  id: string,
  input: UpdateSageInput,
): Sage {
  rejectIfUnsafeInput(input);
  // Field-value validation mirrors validateRememberInput (store-helpers.ts):
  // unknown persistence/kind values are rejected instead of silently behaving
  // as a different class (an invalid persistence used to slip through and act
  // as non-permanent everywhere; an invalid kind would pollute byStatus and
  // byKind stats). `scope` is deliberately NOT part of UpdateSageInput — a
  // memory's scope and session ownership are immutable after creation
  // (change = delete+recreate).
  if (input.text !== undefined) {
    if (input.text.length > MAX_MEMORY_TEXT_CHARS) {
      throw new Error(`SAGE text exceeds ${MAX_MEMORY_TEXT_CHARS} characters.`);
    }
    const normalizedText = normalizeText(input.text);
    if (!normalizedText) throw new Error('SAGE text must not be empty.');
    if (normalizedText.length < 4) {
      throw new Error('SAGE text is too short to be useful long-term memory.');
    }
  }
  if (input.persistence !== undefined && !VALID_PERSISTENCE.has(input.persistence)) {
    throw new Error(
      `SAGE persistence must be one of: ${[...VALID_PERSISTENCE].join(', ')}; got "${input.persistence}".`,
    );
  }
  if (input.kind !== undefined && !VALID_KINDS.has(input.kind)) {
    throw new Error(
      `SAGE kind must be one of: ${[...VALID_KINDS].join(', ')}; got "${input.kind}".`,
    );
  }
  if (input.status !== undefined && !VALID_MEMORY_STATUSES.has(input.status)) {
    throw new Error(`Invalid SAGE status: "${input.status}".`);
  }
  for (const [name, values] of [
    ['tags', input.tags],
    ['anchors', input.anchors],
    ['supersedes', input.supersedes],
    ['contradicts', input.contradicts],
  ] as const) {
    if (values && values.length > MAX_MEMORY_METADATA_ITEMS) {
      throw new Error(`SAGE ${name} exceeds ${MAX_MEMORY_METADATA_ITEMS} items.`);
    }
  }
  validateMemoryTags(input.tags);
  validateMemoryAnchors(input.anchors);
  const existing = readSqliteSageRow(ctx.stmt, id);
  if (!existing) throw new Error(`SAGE ${id} not found.`);
  if (
    input.expectedRevision !== undefined &&
    (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== existing.revision)
  ) {
    throw new Error('SAGE revision changed; read the current memory before updating it.');
  }
  if (input.feedback !== undefined) {
    if (
      Object.entries(input).some(
        ([key, value]) => key !== 'feedback' && key !== 'expectedRevision' && value !== undefined,
      )
    ) {
      throw new Error('Submit SAGE feedback separately from content or lifecycle updates.');
    }
    const reviewed = appendModelFeedback(existing, input.feedback, ctx.nowIso());
    if (reviewed !== existing) {
      ctx.upsertMemory(reviewed);
      ctx.audit('memory.feedback', { memoryId: id, details: reviewed.feedback?.at(-1) });
    }
    return reviewed;
  }
  if (input.sources !== undefined) {
    validateRememberInput({
      text: input.text ?? existing.text,
      scope: existing.scope,
      ownerSessionId: existing.ownerSessionId,
      sources: input.sources,
    });
  }
  if (
    input.text !== undefined &&
    existing.scope !== 'session' &&
    isEphemeralMemoryText(normalizeText(input.text))
  ) {
    throw new Error(
      'SAGE rejected ephemeral progress text. Store durable facts, decisions, conventions, or root causes — not WIP/todo chatter. Use todos for task state.',
    );
  }
  if (input.supersededBy !== undefined) {
    if ((input.status ?? existing.status) !== 'superseded') {
      throw new Error('SAGE supersededBy requires status "superseded".');
    }
    if (input.supersededBy === id) {
      throw new Error('SAGE memory cannot supersede itself.');
    }
    const successor = readSqliteSageRow(ctx.stmt, input.supersededBy);
    if (!successor || successor.status === 'deleted') {
      throw new Error(`SAGE successor "${input.supersededBy}" not found.`);
    }
    if (successor.supersededBy === id) {
      throw new Error(`SAGE successor "${input.supersededBy}" is itself superseded by "${id}".`);
    }
  }
  const resultingKind = input.kind ?? existing.kind;
  const resultingAnchors = input.anchors ?? existing.anchors;
  // Enforced when the update sets the kind or the anchors. Anchorless file
  // notes written before the rule existed must still move through their
  // lifecycle: checking every update made archive/delete/supersede of them
  // throw, so review resolutions on those targets reverted to pending forever.
  if (
    (input.kind !== undefined || input.anchors !== undefined) &&
    STRUCTURAL_KINDS.has(resultingKind) &&
    resultingAnchors.length === 0
  ) {
    throw new Error(
      `SAGE kind "${resultingKind}" requires at least one anchor (file/symbol/command binding).`,
    );
  }
  if (input.status === 'deleted') {
    const permanentTarget =
      (existing.persistence ?? DEFAULT_PERSISTENCE) === 'permanent' ||
      input.persistence === 'permanent';
    const authorized = input.force === true || input.deleteAuthorized === true;
    if (!authorized) {
      if (permanentTarget) {
        throw new Error(
          `SAGE "${id}" is marked 'permanent' and cannot be deleted. ` +
            `Pass { force: true } to override; the override will be recorded in the audit log.`,
        );
      }
      throw new Error(
        `SAGE "${id}" cannot be deleted without explicit authorization. ` +
          `Pass { force: true } to the memory_delete tool. ` +
          `The force flag is recorded in the audit log.`,
      );
    }
    // Candidate-resolution time-of-check: the resolution policy was computed
    // from an earlier snapshot, while `existing` above is the fresh
    // in-mutation reread. An authorized-but-not-forced delete must still
    // refuse a target that is permanent NOW — a concurrent
    // promotion-to-permanent wins the race; only user-level `force: true`
    // overrides permanence.
    if (permanentTarget && input.force !== true) {
      throw new Error(
        `SAGE "${id}" was promoted to 'permanent'; an authorized candidate ` +
          `resolution cannot delete it. Re-review the candidate, or pass ` +
          `{ force: true } to override; the override will be recorded in the audit log.`,
      );
    }
  }
  const updated: Sage = {
    ...existing,
    ...(input.validity !== undefined && {
      validity: input.validity === null ? undefined : normalizeValidity(input.validity),
    }),
    ...(input.sources !== undefined && { sources: normalizeSources(input.sources) }),
    ...(input.text !== undefined && { text: normalizeText(input.text) }),
    ...(input.persistence !== undefined && { persistence: input.persistence }),
    ...(input.kind !== undefined && { kind: input.kind }),
    // A status set through the API is a decision, not a verification outcome:
    // mark a manual `stale` so automatic passes never revive the retirement.
    ...(input.status !== undefined &&
      input.status !== existing.status && {
        status: input.status as SageStatus,
        staleReason: input.status === 'stale' ? ('manual' as const) : undefined,
      }),
    ...(input.tags !== undefined && { tags: normalizeTags(input.tags) }),
    ...(input.anchors !== undefined && {
      anchors: applySpanBaselines(
        normalizeAnchors(ctx.projectRoot, input.anchors),
        ctx.spanBaselines ?? new Map(),
      ),
    }),
    // Confirming a stale memory as active accepts its anchors as they are now: the symbol
    // bodies it was demoted for become its new baseline, or it would demote again.
    ...(input.anchors === undefined &&
      input.status === 'active' &&
      existing.status === 'stale' &&
      ctx.spanBaselines?.size && {
        anchors: applySpanBaselines(existing.anchors, ctx.spanBaselines),
      }),
    ...(input.importance !== undefined && { importance: clamp01(input.importance) }),
    ...(input.confidence !== undefined && { confidence: clamp01(input.confidence) }),
    ...(input.freshness !== undefined && { freshness: clamp01(input.freshness) }),
    ...(input.audience !== undefined && { audience: normalizeAudience(input.audience) }),
    ...(input.supersedes !== undefined && { supersedes: input.supersedes }),
    ...(input.contradicts !== undefined && { contradicts: input.contradicts }),
    // Leaving `superseded` drops the stale chain pointer; entering it may set one.
    ...(input.status !== undefined &&
      input.status !== 'superseded' &&
      existing.supersededBy !== undefined && { supersededBy: undefined }),
    ...(input.supersededBy !== undefined && { supersededBy: input.supersededBy }),
    ...(input.status === 'deleted' && {
      supersedes: undefined,
      contradicts: undefined,
      supersededBy: undefined,
    }),
    revision: existing.revision + 1,
    updatedAt: ctx.nowIso(),
  };
  ctx.upsertMemory(updated);
  const statusAffectsAnchorEdges =
    input.status !== undefined &&
    existing.status !== updated.status &&
    updated.status !== 'deleted';
  if (
    updated.status !== 'deleted' &&
    (input.anchors !== undefined ||
      input.confidence !== undefined ||
      input.supersedes !== undefined ||
      input.contradicts !== undefined ||
      statusAffectsAnchorEdges)
  ) {
    ctx.syncAnchorEdges(updated);
  }
  ctx.emitUpdated(updated);
  if (existing.status !== 'deleted' && updated.status === 'deleted') {
    const nodeId = memoryNodeId(updated.id);
    cleanReferencingMemories(ctx, updated.id);
    const removedEdges = ctx
      .stmt(
        "SELECT COUNT(*) AS n FROM edges WHERE (from_node = ? OR to_node = ?) AND relation != 'related_to'",
      )
      .get(nodeId, nodeId) as { n: number };
    ctx.cascadeDeleteEdges(nodeId);
    const reason = 'Memory status changed to deleted.';
    ctx.audit('memory.deleted', {
      memoryId: updated.id,
      reason,
      details: {
        force: input.force === true,
        persistence: updated.persistence ?? DEFAULT_PERSISTENCE,
        removedEdges: removedEdges.n,
      },
    });
    ctx.emitDeleted(updated, reason, removedEdges.n);
  }
  return updated;
}
