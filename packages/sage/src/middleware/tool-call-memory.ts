import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';
import type { EventBus, Middleware } from '@wrongstack/core/kernel';
import { activeLimits, positiveLimit } from '@wrongstack/core/types';
import { formatMemoryHintsDetailed } from '../retrieval/format.js';
import { checkInjectionValidity } from '../retrieval/validity-checks.js';
import type { InjectionTracker } from './injection-tracker.js';
import { MemoryInjectorAgent } from './memory-injector-agent.js';
import { StoreFaultBreaker } from './tool-call-memory-breaker.js';
import {
  dedupeRetrievedByText,
  retrieveTriggeredMemories,
  selectDiverseMemories,
} from './tool-call-memory-retrieval.js';
import {
  computeInjectionProof,
  containsMemoryText,
  contextualInjectionScore,
  DEFAULT_MIN_IMPORTANCE,
  DEFAULT_MIN_SCORE,
  durableMemoryKind,
  MIN_RELATION_STRENGTH,
  normalizedInjectionScore,
  observeBurstRejections,
  type RejectedDetailEntry,
  scoreForInjection,
} from './tool-call-memory-scoring.js';
import {
  applyCooldown,
  boundedText,
  cooldownKey,
  emitInjectorTrace,
  formatTraceAnchor,
  memoryIdsInEvidence,
  pruneCooldowns,
  readToolMemoryEvidence,
  releaseDepartedCooldowns,
  storeProviderMemoryEvidence,
  TOOL_MEMORY_EVIDENCE_WINDOW_CHARS,
  toTraceMemory,
  visibleContextText,
} from './tool-call-memory-trace.js';
import {
  didMutate,
  type ExtractedTriggerContext,
  enrichPathQuery,
  extractPatchPaths,
  extractResultPaths,
  extractTrigger,
  isMutationTrigger,
  isString,
  type MemoryToolTrigger,
  resolveTriggerPaths,
  splitFileList,
  stringValues,
} from './tool-call-memory-triggers.js';

export type { RetrievedMemory } from './tool-call-memory-retrieval.js';
export {
  computeInjectionProof,
  containsMemoryText,
  contextualInjectionScore,
  DEFAULT_MIN_IMPORTANCE,
  DEFAULT_MIN_SCORE,
  MIN_RELATION_STRENGTH,
} from './tool-call-memory-scoring.js';
export type {
  ExtractedTriggerContext,
  MemoryToolTrigger,
} from './tool-call-memory-triggers.js';

export interface SageToolCallMiddlewareOptions {
  memory: SageRetrieverLike;
  /** Read current rows for retained evidence, including after non-retrieval tools. */
  getMemory?: GetEvidenceMemory | undefined;
  enabled?: boolean | undefined;
  maxHintsPerTool?: number | undefined;
  maxCharsPerTool?: number | undefined;
  minScore?: number | undefined;
  getSessionId?: (() => string | undefined) | undefined;
  minImportance?: number | undefined;
  relationFloor?: number | undefined;
  repeatCooldownMs?: number | undefined;
  verifyOnMutation?: boolean | undefined;
  /**
   * Wall-clock budget for the automatic retrieval fan-out, in milliseconds.
   * `0` (or a non-finite value) disables the budget. Defaults to
   * {@link DEFAULT_RETRIEVAL_TIMEOUT_MS}.
   */
  retrievalTimeoutMs?: number | undefined;
  taskAware?: boolean | undefined;
  triggers?: Partial<Record<MemoryToolTrigger, boolean>> | undefined;
  tracker?: InjectionTracker | undefined;
  events?: EventBus | undefined;
}

import type { SageRetrieverLike } from './tool-call-memory-types.js';

export type { SageRetrieverLike, SageSearchLike } from './tool-call-memory-types.js';

const DEFAULT_MAX_HINTS = 8;
const DEFAULT_MAX_CHARS = 2800;
const DEFAULT_REPEAT_COOLDOWN_MS = 0;
const MAX_REJECTED_DETAIL = 20;
/**
 * Default budget for the retrieval fan-out. Deliberately far below the SAGE
 * client's 30s per-call timeout: injection is best-effort decoration on a tool
 * result that has already succeeded, so a slow store should cost the pipeline
 * a few seconds, not half a minute. The daemon serializes requests on one
 * event loop, so a single slow query queues every other client behind it —
 * without this budget that queue is paid in full by the tool call.
 */
const DEFAULT_RETRIEVAL_TIMEOUT_MS = 5_000;

/**
 * Race `work` against `timeoutMs`, rejecting with a named error on expiry.
 *
 * The loser keeps running — there is no cancellation channel on
 * {@link SageRetrieverLike} — so both settlement paths stay attached and a
 * late rejection is absorbed here instead of surfacing as an unhandled
 * rejection. The caller's catch turns the expiry into a fail-open
 * `outcome: 'error'` trace, which is what a retrieval failure already does.
 */
function withRetrievalBudget<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`SAGE retrieval exceeded its ${timeoutMs}ms budget`));
    }, timeoutMs);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

import { nowIso } from '@wrongstack/primitives';
import { type GetEvidenceMemory, refreshMemoryEvidence } from './evidence-refresh.js';
import { replaceProviderMemoryEvidence } from './tool-call-memory-trace.js';

export function createSageToolCallMiddleware(
  opts: SageToolCallMiddlewareOptions,
): Middleware<ToolCallPipelinePayload> {
  const seen = new Map<string, number>();
  const pruneState = { lastPruneAt: 0 };
  // Per context object, per session: the ids this injector last placed in the
  // tool-memory evidence window. Compared with the live window before each
  // cooldown check so a memory that left context (clear, topic shift,
  // eviction) can return. Keyed by the context object on purpose: a host that
  // hands every call a fresh synthetic context (no evidence persistence) has no
  // placement record there, so its once-per-session cooldown still holds
  // instead of every call looking like "the memory left context".
  const placedInEvidence = new WeakMap<object, Map<string, Set<string>>>();
  const injector = new MemoryInjectorAgent();
  const storeBreaker = new StoreFaultBreaker();
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const minImportance = opts.minImportance ?? DEFAULT_MIN_IMPORTANCE;
  const relationFloor = opts.relationFloor ?? MIN_RELATION_STRENGTH;
  const thresholds = { minScore, minImportance, relationFloor };

  return {
    name: 'sage.tool-result-injection',
    owner: 'sage',
    async handler(payload, next) {
      const now = Date.now();
      const nextPayload = await next(payload);
      if (opts.enabled === false) return nextPayload;
      let attemptedTrigger: ExtractedTriggerContext | undefined;
      let attemptedPlan: ReturnType<MemoryInjectorAgent['plan']> | undefined;
      try {
        const previousEvidence = readToolMemoryEvidence(nextPayload.ctx);
        if (opts.getMemory && previousEvidence) {
          const refreshed = await withRetrievalBudget(
            refreshMemoryEvidence(
              previousEvidence,
              opts.getMemory,
              opts.getSessionId?.() ?? (nextPayload.ctx.session as { id?: string } | undefined)?.id,
              nextPayload.ctx.projectRoot,
              opts.tracker,
            ),
            opts.retrievalTimeoutMs ?? DEFAULT_RETRIEVAL_TIMEOUT_MS,
          ).catch(() => '');
          // A clear/replacement while the read awaited owns the new window.
          if (readToolMemoryEvidence(nextPayload.ctx) === previousEvidence) {
            replaceProviderMemoryEvidence(
              nextPayload.ctx,
              refreshed,
              TOOL_MEMORY_EVIDENCE_WINDOW_CHARS,
            );
          }
        }
        if (nextPayload.result.is_error) return nextPayload;

        const trigger = extractTrigger(nextPayload.toolUse.name, nextPayload.toolUse.input);
        if (!trigger) return nextPayload;
        if (opts.triggers?.[trigger.trigger] === false) return nextPayload;
        // Store known unreadable: skip quietly instead of re-failing every call.
        if (storeBreaker.isOpen(Date.now())) return nextPayload;
        attemptedTrigger = trigger;
        trigger.paths = resolveTriggerPaths(
          [...trigger.paths, ...extractResultPaths(nextPayload.result.content, trigger.trigger)],
          nextPayload.ctx,
        );

        if (
          opts.verifyOnMutation !== false &&
          isMutationTrigger(trigger.trigger) &&
          trigger.paths.length > 0 &&
          didMutate(nextPayload.toolUse.name, nextPayload.toolUse.input)
        ) {
          await opts.memory.verifyForPaths?.(trigger.paths, nextPayload.ctx.signal);
        }

        const plan = injector.plan({
          ctx: nextPayload.ctx,
          trigger: trigger.trigger,
          toolQuery: trigger.queryText,
          baseMaxHints: opts.maxHintsPerTool ?? DEFAULT_MAX_HINTS,
          baseMaxChars:
            opts.maxCharsPerTool ??
            positiveLimit(activeLimits().memoryInjectChars) ??
            DEFAULT_MAX_CHARS,
          taskAware: opts.taskAware,
        });
        attemptedPlan = plan;
        trigger.queryText = plan.queryText;
        const maxHints = plan.maxHints;
        const memories = await withRetrievalBudget(
          retrieveTriggeredMemories(
            opts.memory,
            trigger,
            maxHints,
            nextPayload.ctx.projectRoot,
            relationFloor,
            opts.getSessionId?.() ?? (nextPayload.ctx.session as { id?: string } | undefined)?.id,
          ),
          opts.retrievalTimeoutMs ?? DEFAULT_RETRIEVAL_TIMEOUT_MS,
        );
        storeBreaker.recordSuccess();
        const alreadyVisible = visibleContextText(nextPayload);
        const rejectedDetail: RejectedDetailEntry[] = [];
        const rejectedDetailRaw: RejectedDetailEntry[] = [];
        const pushRejection = (entry: RejectedDetailEntry) => {
          rejectedDetailRaw.push(entry);
          if (rejectedDetail.length < MAX_REJECTED_DETAIL) {
            rejectedDetail.push(entry);
          }
        };
        const deduped = dedupeRetrievedByText(memories);
        const droppedDuplicates = memories.filter(
          (candidate) =>
            !deduped.some((dedupedCandidate) => dedupedCandidate.memory.id === candidate.memory.id),
        );
        for (const { memory } of droppedDuplicates) {
          pushRejection({
            id: memory.id,
            kind: memory.kind,
            gate: 'duplicate',
            reason: 'normalized-text duplicate of an earlier candidate',
            at: nowIso(),
          });
        }
        const scoreEligible = deduped.filter(({ memory, relationStrength }) => {
          if (memory.importance < minImportance) {
            pushRejection({
              id: memory.id,
              kind: memory.kind,
              gate: 'belowScore',
              reason: `importance ${memory.importance.toFixed(2)} below floor ${minImportance.toFixed(2)}`,
              score: memory.importance,
              at: nowIso(),
            });
            return false;
          }
          if (relationStrength < relationFloor) {
            pushRejection({
              id: memory.id,
              kind: memory.kind,
              gate: 'belowScore',
              reason: `relationStrength ${relationStrength.toFixed(2)} below floor ${relationFloor.toFixed(2)}`,
              relationStrength,
              score: relationStrength,
              at: nowIso(),
            });
            return false;
          }
          const score = contextualInjectionScore(memory, relationStrength);
          if (score < minScore) {
            pushRejection({
              id: memory.id,
              kind: memory.kind,
              gate: 'belowScore',
              reason: `score ${score.toFixed(2)} below floor ${minScore.toFixed(2)}`,
              relationStrength,
              score,
              at: nowIso(),
            });
            return false;
          }
          return true;
        });
        const eligibleItems = scoreEligible
          .filter(({ memory }) => {
            const visible = containsMemoryText(alreadyVisible, memory.text);
            if (visible) {
              pushRejection({
                id: memory.id,
                kind: memory.kind,
                gate: 'alreadyVisible',
                reason: 'memory text already present in context',
                at: nowIso(),
              });
            }
            return !visible;
          })
          .sort(
            (a, b) =>
              contextualInjectionScore(b.memory, b.relationStrength) -
              contextualInjectionScore(a.memory, a.relationStrength),
          );
        const eligible = eligibleItems.map((item) => item.memory);
        const sessionId =
          opts.getSessionId?.() ?? (nextPayload.ctx.session as { id?: string } | undefined)?.id;
        const placedForCtx = placedInEvidence.get(nextPayload.ctx);
        if (placedForCtx) {
          releaseDepartedCooldowns(
            seen,
            placedForCtx,
            sessionId,
            memoryIdsInEvidence(readToolMemoryEvidence(nextPayload.ctx)),
          );
        }
        const fresh = applyCooldown(
          eligible,
          seen,
          opts.repeatCooldownMs ?? DEFAULT_REPEAT_COOLDOWN_MS,
          sessionId,
        );
        const freshIds = new Set(fresh.map((m) => m.id));
        const cooldownDropped = eligible.filter((m) => !freshIds.has(m.id));
        for (const memory of cooldownDropped) {
          pushRejection({
            id: memory.id,
            kind: memory.kind,
            gate: 'cooldown',
            reason: `recently injected within ${opts.repeatCooldownMs ?? DEFAULT_REPEAT_COOLDOWN_MS}ms`,
            at: nowIso(),
          });
        }
        const rejectedBase = {
          duplicate: droppedDuplicates.length,
          belowScore: deduped.length - scoreEligible.length,
          alreadyVisible: scoreEligible.length - eligibleItems.length,
          cooldown: cooldownDropped.length,
          budget: 0,
        };
        observeBurstRejections(rejectedDetailRaw, opts.events, now);
        const rejectedDetailTotal =
          rejectedDetailRaw.length > MAX_REJECTED_DETAIL ? rejectedDetailRaw.length : undefined;
        if (fresh.length === 0) {
          const measurement = {
            candidates: memories.length,
            eligible: eligible.length,
            injected: 0,
            injectedChars: 0,
          };
          injector.record(nextPayload.ctx, plan, measurement);
          emitInjectorTrace(opts.events, {
            nextPayload,
            trigger,
            plan,
            outcome: 'empty',
            candidates: memories.length,
            eligible: eligible.length,
            rejected: rejectedBase,
            rejectedDetail,
            rejectedDetailTotal,
            activated: [],
            injected: [],
            injectedChars: 0,
            thresholds,
          });
          return nextPayload;
        }

        // No longer capped by the tool's `maxOutputBytes`: evidence travels as
        // its own provider block, not inside the tool result, so a large tool
        // output must not starve the memory budget (it used to reduce it to 0
        // for exactly the big files that most need context).
        const maxChars = plan.maxChars;
        const { selected, dropped: budgetDropped } = selectDiverseMemories(
          fresh,
          maxHints,
          new Map(eligibleItems.map((item) => [item.memory.id, item.retrievalReasons])),
        );
        for (const { memory, reason } of budgetDropped) {
          pushRejection({
            id: memory.id,
            kind: memory.kind,
            gate: 'budget',
            reason,
            at: nowIso(),
          });
        }
        const validityReviews = await checkInjectionValidity(selected, nextPayload.ctx.projectRoot);
        const rendered = formatMemoryHintsDetailed(selected, {
          validityReviews,
          maxChars,
          heading:
            plan.taskSignals.length > 0
              ? 'SAGE: task-aware project knowledge (Memory Injector)'
              : 'SAGE: related project knowledge (Memory Injector)',
        });
        if (!rendered.text || rendered.memoryIds.length === 0) {
          const measurement = {
            candidates: memories.length,
            eligible: eligible.length,
            injected: 0,
            injectedChars: 0,
          };
          injector.record(nextPayload.ctx, plan, measurement);
          emitInjectorTrace(opts.events, {
            nextPayload,
            trigger,
            plan,
            outcome: 'empty',
            candidates: memories.length,
            eligible: eligible.length,
            rejected: { ...rejectedBase, budget: fresh.length },
            rejectedDetail,
            rejectedDetailTotal,
            activated: selected.map((memory) =>
              toTraceMemory(
                eligibleItems.find((candidate) => candidate.memory.id === memory.id)!,
                plan,
              ),
            ),
            injected: [],
            injectedChars: 0,
            thresholds,
          });
          return nextPayload;
        }

        // Rolling window: several tool calls of one step each contribute, and
        // a context-pressure budget shrinks the window with the per-call one.
        const windowChars = Math.max(
          plan.maxChars,
          Math.min(TOOL_MEMORY_EVIDENCE_WINDOW_CHARS, plan.maxChars * 3),
        );
        const evidence = storeProviderMemoryEvidence(nextPayload.ctx, rendered.text, windowChars);
        const injectedAt = Date.now();
        for (const memoryId of rendered.memoryIds)
          seen.set(cooldownKey(memoryId, sessionId), injectedAt);
        for (const memoryId of evidence.evictedIds) seen.delete(cooldownKey(memoryId, sessionId));
        let placed = placedInEvidence.get(nextPayload.ctx);
        if (!placed) {
          placed = new Map();
          placedInEvidence.set(nextPayload.ctx, placed);
        }
        const placedKey = sessionId ?? '<no-session>';
        placed.delete(placedKey);
        placed.set(placedKey, new Set(evidence.memoryIds));
        // The placement record is the only handle that can lift a permanent
        // cooldown after the line leaves the window. Drop a session only once
        // its ids are already gone, and lift those cooldowns in the same step.
        if (placed.size > 256) {
          const present = memoryIdsInEvidence(readToolMemoryEvidence(nextPayload.ctx));
          for (const key of [...placed.keys()]) {
            if (placed.size <= 256) break;
            const ids = placed.get(key);
            if (!ids) {
              placed.delete(key);
              continue;
            }
            if ([...ids].some((id) => present.has(id))) continue;
            const keySession = key === '<no-session>' ? undefined : key;
            for (const id of ids) seen.delete(cooldownKey(id, keySession));
            placed.delete(key);
          }
        }
        pruneCooldowns(
          seen,
          pruneState,
          injectedAt,
          opts.repeatCooldownMs ?? DEFAULT_REPEAT_COOLDOWN_MS,
        );
        if (opts.tracker) {
          const injectedById = new Map(selected.map((memory) => [memory.id, memory]));
          for (const memoryId of rendered.memoryIds) {
            const memory = injectedById.get(memoryId)!;
            opts.tracker.record(memoryId, memory.text, injectedAt, sessionId, rendered.text);
          }
        }
        let auditError: string | undefined;
        try {
          await opts.memory.recordInjection?.(rendered.memoryIds, trigger.trigger, sessionId);
        } catch (error) {
          auditError = error instanceof Error ? error.message : String(error);
        }
        const measurement = {
          candidates: memories.length,
          eligible: eligible.length,
          injected: rendered.memoryIds.length,
          injectedChars: rendered.text.length,
        };
        injector.record(nextPayload.ctx, plan, measurement);
        const selectedById = new Map(eligibleItems.map((item) => [item.memory.id, item]));
        emitInjectorTrace(opts.events, {
          nextPayload,
          trigger,
          plan,
          outcome: 'injected',
          candidates: memories.length,
          eligible: eligible.length,
          rejected: {
            ...rejectedBase,
            budget: Math.max(0, fresh.length - rendered.memoryIds.length),
          },
          rejectedDetail,
          rejectedDetailTotal,
          activated: selected.flatMap((memory) => {
            return [
              {
                ...toTraceMemory(selectedById.get(memory.id)!, plan),
                validityReview: validityReviews.get(memory.id),
              },
            ];
          }),
          injected: rendered.memoryIds.flatMap((id) => {
            return [
              {
                ...toTraceMemory(selectedById.get(id)!, plan),
                validityReview: validityReviews.get(id),
              },
            ];
          }),
          injectedChars: rendered.text.length,
          thresholds,
          error: auditError,
        });
        return nextPayload;
      } catch (error) {
        const fault = storeBreaker.recordFailure(error, Date.now());
        if (attemptedTrigger) {
          const fallbackPlan =
            attemptedPlan ??
            injector.plan({
              ctx: nextPayload.ctx,
              trigger: attemptedTrigger.trigger,
              toolQuery: attemptedTrigger.queryText,
              baseMaxHints: opts.maxHintsPerTool ?? DEFAULT_MAX_HINTS,
              baseMaxChars:
                opts.maxCharsPerTool ??
                positiveLimit(activeLimits().memoryInjectChars) ??
                DEFAULT_MAX_CHARS,
              taskAware: opts.taskAware,
            });
          emitInjectorTrace(opts.events, {
            nextPayload,
            trigger: attemptedTrigger,
            plan: fallbackPlan,
            outcome: 'error',
            candidates: 0,
            eligible: 0,
            rejected: { duplicate: 0, belowScore: 0, alreadyVisible: 0, cooldown: 0, budget: 0 },
            rejectedDetail: [],
            activated: [],
            injected: [],
            injectedChars: 0,
            thresholds,
            error: fault.message ?? (error instanceof Error ? error.message : String(error)),
          });
        }
        return nextPayload;
      }
    },
  };
}

export const toolCallMemoryCoverage = {
  extractTrigger,
  enrichPathQuery,
  didMutate,
  isMutationTrigger,
  stringValues,
  isString,
  splitFileList,
  extractPatchPaths,
  extractResultPaths,
  resolveTriggerPaths,
  cooldownKey,
  applyCooldown,
  pruneCooldowns,
  visibleContextText,
  emitInjectorTrace,
  retrieveTriggeredMemories,
  dedupeRetrievedByText,
  selectDiverseMemories,
  scoreForInjection,
  normalizedInjectionScore,
  computeInjectionProof,
  contextualInjectionScore,
  durableMemoryKind,
  boundedText,
  formatTraceAnchor,
  toTraceMemory,
  observeBurstRejections,
  containsMemoryText,
};
