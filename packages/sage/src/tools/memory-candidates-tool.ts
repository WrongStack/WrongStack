import type { Tool } from '@wrongstack/contracts/types';
import type { SageServiceLike } from '../service-contract.js';
import type {
  CandidateDecision,
  MemoryCandidate,
  MemoryCandidateResolution,
  Sage,
  SageKind,
  SageScope,
} from '../types.js';
import { assertSessionMayMutate, callerSessionId } from './memory-tool-session.js';
import {
  enumSchema,
  KIND_VALUES,
  numberSchema,
  objectSchema,
  SCOPE_VALUES,
  stringArraySchema,
  stringSchema,
} from './tool-schema-helpers.js';

function notPending(candidateId: string): Error {
  return new Error(
    `Memory candidate "${candidateId}" not found or no longer pending. Use memory_candidates({ action: "list" }) to see pending candidates.`,
  );
}

async function assertSessionMayMutateCandidate(
  memory: SageServiceLike,
  candidate: MemoryCandidate | undefined,
  ctx: unknown,
): Promise<void> {
  if (!candidate) return;
  const caller = callerSessionId(ctx);
  if (
    candidate.scope === 'session' &&
    (!candidate.ownerSessionId || candidate.ownerSessionId !== caller)
  ) {
    throw new Error(
      `SAGE candidate "${candidate.id}" is a session-scoped candidate owned by another session and cannot be modified from here.`,
    );
  }
  if (candidate.targetMemoryId) {
    await assertSessionMayMutate(memory, candidate.targetMemoryId, ctx);
  }
  for (const memberId of candidate.supersedesMemoryIds ?? []) {
    await assertSessionMayMutate(memory, memberId, ctx);
  }
}

export function memoryCandidatesTool(memory: SageServiceLike): Tool<
  {
    action?: 'list' | 'accept' | 'reject' | 'propose' | 'resolve';
    candidate_id?: string;
    reason?: string;
    include_resolved?: boolean;
    text?: string;
    kind?: SageKind;
    scope?: SageScope;
    tags?: string[];
    importance?: number;
    confidence?: number;
    suggested_action?: 'delete' | 'archive' | 'investigate';
    memory_id?: string;
    decision?: CandidateDecision;
  },
  MemoryCandidate[] | MemoryCandidate | MemoryCandidateResolution | Sage | { rejected: true }
> {
  return {
    name: 'memory_candidates',
    category: 'Session',
    description:
      "List, accept, reject, propose, or resolve memory candidates. Proposing files a non-destructive review suggestion into the ReviewQueue; resolving applies the review decision (delete/archive/keep) to the proposal's TARGET memory — the preferred decision path over raw memory_delete calls.",
    inputSchema: objectSchema({
      action: { type: 'string', enum: ['list', 'accept', 'reject', 'propose', 'resolve'] },
      candidate_id: stringSchema('Required for accept, reject, or resolve.'),
      reason: stringSchema(
        'Reason for rejection, the review reason for propose, or the resolution note for resolve.',
      ),
      include_resolved: {
        type: 'boolean',
        description: 'list: also show accepted/rejected candidates (default: pending only).',
      },
      text: stringSchema('Candidate text (required for propose).'),
      kind: enumSchema(KIND_VALUES, 'Memory kind for propose.'),
      scope: enumSchema(SCOPE_VALUES, 'Scope for propose.'),
      tags: stringArraySchema('Extra tags for propose.'),
      importance: {
        ...numberSchema(0, 1),
        description: 'How much this matters when ranking what to inject: 0 trivia … 1 must-know.',
      },
      confidence: {
        ...numberSchema(0, 1),
        description: 'How sure the fact is: below 0.5 becomes an archive candidate after 30 days.',
      },
      suggested_action: {
        type: 'string',
        enum: ['delete', 'archive', 'investigate'],
        description: 'Review action suggested for propose.',
      },
      memory_id: stringSchema('Id of the memory this proposal targets (propose).'),
      decision: {
        type: 'string',
        enum: ['delete', 'archive', 'keep'],
        description: 'Review decision to apply to the target memory (required for resolve).',
      },
    }),
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    capabilities: ['memory.read', 'memory.write'],
    icon: 'settings',
    validate(input) {
      if ((input.action === 'accept' || input.action === 'reject') && !input.candidate_id) {
        return ['candidate_id is required for accept or reject'];
      }
      if (input.action === 'resolve') {
        if (!input.candidate_id) return ['candidate_id is required for resolve'];
        if (!input.decision) return ['decision is required for resolve (delete|archive|keep)'];
      }
      if (input.action === 'propose' && !input.text?.trim()) {
        return ['text is required for propose'];
      }
      return [];
    },
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      // An unknown / non-pending candidate THROWS: `undefined` and
      // `{ rejected: false }` were recorded as successful calls.
      if (input.action === 'accept') {
        const candidate = (await memory.listCandidates(true)).find(
          (entry) => entry.id === input.candidate_id,
        );
        await assertSessionMayMutateCandidate(memory, candidate, ctx);
        const accepted = await memory.acceptCandidate(input.candidate_id!);
        if (!accepted) throw notPending(input.candidate_id!);
        return accepted;
      }
      if (input.action === 'reject') {
        const candidate = (await memory.listCandidates(true)).find(
          (entry) => entry.id === input.candidate_id,
        );
        await assertSessionMayMutateCandidate(memory, candidate, ctx);
        const rejected = await memory.rejectCandidate(
          input.candidate_id!,
          input.reason ?? 'Rejected by user or agent.',
        );
        if (!rejected) throw notPending(input.candidate_id!);
        return { rejected: true };
      }
      if (input.action === 'resolve') {
        const candidate = (await memory.listCandidates(true)).find(
          (entry) => entry.id === input.candidate_id,
        );
        await assertSessionMayMutateCandidate(memory, candidate, ctx);
        const resolution = await memory.resolveCandidate(
          input.candidate_id!,
          input.decision!,
          input.reason,
        );
        if (!resolution) {
          throw new Error(`Memory candidate "${input.candidate_id}" not found.`);
        }
        return resolution;
      }
      if (input.action === 'propose') {
        let targetMemory: Sage | null = null;
        if (input.memory_id) {
          await assertSessionMayMutate(memory, input.memory_id, ctx);
          targetMemory = await memory.getSage(input.memory_id);
        }
        // Proposal metadata lives in typed fields (targetMemoryId /
        // reviewReason / suggestedAction) — E1: the legacy `review:` /
        // `suggested:` / `source:` tag prefixes are no longer written.
        const scope = input.scope ?? (targetMemory?.scope === 'session' ? 'session' : 'project');
        const ownerSessionId =
          scope === 'session' ? (targetMemory?.ownerSessionId ?? callerSessionId(ctx)) : undefined;
        return memory.createCandidate({
          text: input.text!,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.scope || scope === 'session' ? { scope } : {}),
          ...(ownerSessionId ? { ownerSessionId } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
          ...(input.importance !== undefined ? { importance: input.importance } : {}),
          ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          ...(input.memory_id ? { targetMemoryId: input.memory_id } : {}),
          ...(input.reason ? { reviewReason: input.reason } : {}),
          ...(input.suggested_action ? { suggestedAction: input.suggested_action } : {}),
        });
      }
      const caller = callerSessionId(ctx);
      const candidates = await memory.listCandidates(input.include_resolved ?? false);
      const visible: MemoryCandidate[] = [];
      for (const candidate of candidates) {
        if (
          candidate.scope === 'session' &&
          (!candidate.ownerSessionId || candidate.ownerSessionId !== caller)
        ) {
          continue;
        }
        if (candidate.targetMemoryId) {
          const target = await memory.getSage(candidate.targetMemoryId);
          if (
            target?.scope === 'session' &&
            target.ownerSessionId &&
            target.ownerSessionId !== caller
          ) {
            continue;
          }
        }
        visible.push(candidate);
      }
      return visible;
    },
  };
}
