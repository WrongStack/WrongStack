import type { Tool } from '@wrongstack/contracts/types';
import type { SageServiceLike } from '../service-contract.js';
import { validityKey } from '../shared/memory-validity.js';
import type { Sage, UpdateSageInput } from '../types.js';
import { assertSessionMayMutate, callerSessionId } from './memory-tool-session.js';
import {
  anchorsSchema,
  audienceSchema,
  enumSchema,
  KIND_VALUES,
  numberSchema,
  objectSchema,
  STATUS_VALUES,
  sourcesSchema,
  stringArraySchema,
  stringSchema,
  validitySchema,
} from './tool-schema-helpers.js';

export function memoryUpdateTool(
  memory: SageServiceLike,
): Tool<{ id: string } & UpdateSageInput, Sage> {
  return {
    name: 'memory_update',
    category: 'Session',
    description:
      'Update a single SAGE entry by id — edit text, tags, kind, anchors, importance/confidence, status, or relationships.',
    usageHint:
      'Refine or re-scope an existing memory instead of creating a near-duplicate.\n' +
      '- Find the id via `memory_search` or `memory_for_file`.\n' +
      '- After materially using a memory, submit feedback alone: { verdict, observedRevision, evidence }.\n' +
      '- useful means it helped this task; outdated/incorrect require current evidence; irrelevant is task-specific; uncertain means insufficient evidence. No verdict proves truth.\n' +
      '- Feedback does not alter confidence, freshness, relations or lifecycle. Outdated/incorrect feedback also files a non-destructive review proposal.\n' +
      '- Check current files/tests before trusting old or unverified claims. Correct text with sources and expectedRevision; do not refresh a timestamp just because you read it.\n' +
      '- If a correction changes the decision, preserve supersedes/contradicts relationships. Never delete merely because a memory was unused.\n' +
      '- Set `status` to "stale"/"archived" to retire a memory without deleting it.',
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    timeoutMs: 2_000,
    capabilities: ['memory.write'],
    icon: 'settings',
    inputSchema: objectSchema(
      {
        id: { type: 'string', minLength: 1, description: 'The memory id to update.' },
        expectedRevision: {
          type: 'integer',
          minimum: 1,
          description: 'Revision read before correcting the memory; rejects concurrent changes.',
        },
        sources: sourcesSchema(),
        validity: {
          anyOf: [validitySchema(), { type: 'null' }],
          description:
            'Replace applicability assumptions; null clears them. Use expectedRevision after checking current evidence.',
        },
        feedback: objectSchema(
          {
            verdict: enumSchema(
              ['useful', 'outdated', 'incorrect', 'irrelevant', 'uncertain'],
              'Your evidence-based judgment after using/checking this memory.',
            ),
            observedRevision: {
              type: 'integer',
              minimum: 1,
              description: 'Revision you actually read.',
            },
            evidence: {
              type: 'string',
              minLength: 1,
              maxLength: 2000,
              description:
                'Concrete outcome or current source/test evidence. Do not include secrets or raw logs.',
            },
          },
          ['verdict', 'observedRevision', 'evidence'],
        ),
        text: { type: 'string', minLength: 1, description: 'Replacement text.' },
        tags: stringArraySchema('Replacement tags (omit the #).'),
        kind: enumSchema(KIND_VALUES, 'New kind.'),
        anchors: anchorsSchema(),
        audience: audienceSchema(),
        importance: numberSchema(0, 1),
        confidence: numberSchema(0, 1),
        freshness: numberSchema(0, 1),
        persistence: enumSchema(
          ['permanent', 'long_lived', 'short_lived'],
          'Retention class. Prefer long_lived; permanent is only for explicit invariants.',
        ),
        status: enumSchema(STATUS_VALUES, 'New lifecycle status.'),
        supersedes: stringArraySchema('Memory ids this replaces.'),
        contradicts: stringArraySchema('Memory ids this contradicts.'),
        force: {
          type: 'boolean',
          description:
            'Required to set status to "deleted" — authorizes all deletions, not just permanent memories. The override is audit-logged.',
        },
      },
      ['id'],
    ),
    validate(input) {
      const { id, expectedRevision: _expectedRevision, ...patch } = input;
      if (!id) return ['id is required'];
      if (Object.values(patch).every((v) => v === undefined)) {
        return ['at least one field to update is required'];
      }
      return [];
    },
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      const { id, ...patch } = input;
      await assertSessionMayMutate(memory, id, ctx);
      const updated = await memory.updateSage(id, {
        ...patch,
        ...(patch.sources && {
          sources: patch.sources.map((source) => ({ ...source, sessionId: callerSessionId(ctx) })),
        }),
        ...(patch.feedback && { feedback: { ...patch.feedback, sessionId: callerSessionId(ctx) } }),
      });
      if (
        patch.validity !== undefined &&
        validityKey(updated.validity) !== validityKey(patch.validity ?? undefined)
      )
        throw new Error(
          'SAGE backend did not preserve validity conditions. Re-read the record and rebuild/restart the backend before relying on this update.',
        );
      if (
        patch.feedback &&
        !updated.feedback?.some(
          (item) =>
            item.observedRevision === patch.feedback!.observedRevision &&
            item.verdict === patch.feedback!.verdict &&
            item.evidence === patch.feedback!.evidence.trim() &&
            item.sessionId === callerSessionId(ctx),
        )
      ) {
        throw new Error(
          'SAGE did not persist memory feedback. The running daemon may be older than this client. Update/rebuild SAGE and use /connections restart, then retry; no review proposal was filed.',
        );
      }
      if (
        patch.feedback &&
        (patch.feedback.verdict === 'outdated' || patch.feedback.verdict === 'incorrect')
      ) {
        await memory.createCandidate({
          text: `Review memory ${id} revision ${patch.feedback.observedRevision}: ${patch.feedback.verdict}. Evidence: ${patch.feedback.evidence}`,
          kind: 'memory_review',
          scope: updated.scope,
          ownerSessionId: updated.ownerSessionId,
          audience: updated.audience,
          targetMemoryId: id,
          targetRevision: patch.feedback.observedRevision,
          reviewReason: `model_feedback:${patch.feedback.verdict}`,
          suggestedAction: 'investigate',
          sources: [{ type: 'session', sessionId: callerSessionId(ctx) }],
        });
      }
      return updated;
    },
  };
}

export function memoryDeleteTool(
  memory: SageServiceLike,
): Tool<
  { id: string; reason?: string; force?: boolean; neverInject?: boolean },
  { deleted: true; id: string }
> {
  return {
    name: 'memory_delete',
    category: 'Session',
    description:
      'Delete one SAGE entry by id (soft-delete with graph/relationship cascade cleanup). Requires force: true — all deletions are audited and need explicit authorization.',
    usageHint:
      'Exact, single-entry removal by id — safer than substring `forget`.\n' +
      '- Find the id via `memory_search`. Provide a short `reason` for the audit log.\n' +
      '- **`force: true` is required for ALL deletions** — this prevents autonomous agents from removing memories without explicit authorization. The override is recorded in the audit log.\n' +
      '- Normal deletion keeps historical evidence eligible for relevant LLM context. Set `neverInject: true` only for an explicit privacy/safety ban.\n' +
      '- For non-destructive review, use `memory_candidates({ action: "propose" })` instead — the user can then resolve via `memory_candidates({ action: "resolve" })`.',
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    timeoutMs: 2_000,
    capabilities: ['memory.delete'],
    icon: 'settings',
    inputSchema: objectSchema(
      {
        id: { type: 'string', minLength: 1, description: 'The memory id to delete.' },
        reason: stringSchema('Reason recorded in the audit log.'),
        force: {
          type: 'boolean',
          description:
            'Required for ALL deletions — authorizes the removal and is recorded in the audit log.',
        },
        neverInject: {
          type: 'boolean',
          description:
            'Absolute privacy/safety ban: this memory must never enter LLM context. Normal deletion remains context-eligible historical evidence.',
        },
      },
      ['id', 'force'],
    ),
    validate(input) {
      if (!input.id) return ['id is required'];
      if (input.force !== true) {
        return [
          'force: true is required to delete any memory. This prevents accidental or autonomous deletions. Pass force: true to authorize; the override is audit-logged. For non-destructive review, use memory_candidates({ action: "propose" }) instead.',
        ];
      }
      return [];
    },
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      await assertSessionMayMutate(memory, input.id, ctx);
      await memory.deleteSage(input.id, input.reason, {
        force: true,
        ...(input.neverInject === true ? { neverInject: true } : {}),
      });
      return { deleted: true, id: input.id };
    },
  };
}
