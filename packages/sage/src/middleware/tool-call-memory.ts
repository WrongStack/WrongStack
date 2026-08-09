import * as path from 'node:path';
import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';
import type { EventBus, Middleware } from '@wrongstack/core/kernel';
import { formatMemoryHintsDetailed } from '../retrieval/format.js';
import { memoryQueryRelevance, memoryStructuralRelevance } from '../retrieval/relevance.js';
import { normalizeTextKey } from '../store-helpers.js';
import type { Sage } from '../types.js';
import { DEFAULT_PERSISTENCE } from '../types.js';
import type { InjectionTracker } from './injection-tracker.js';
import { MemoryInjectorAgent } from './memory-injector-agent.js';

export interface SageToolCallMiddlewareOptions {
  memory: SageRetrieverLike;
  enabled?: boolean | undefined;
  maxHintsPerTool?: number | undefined;
  maxCharsPerTool?: number | undefined;
  minScore?: number | undefined;
  getSessionId?: (() => string | undefined) | undefined;
  /**
   * Hard importance gate. A memory below it is never auto-injected no matter
   * how exactly its anchor matches — importance used to be a purely additive
   * term, so a trivial note with a file anchor outranked an important
   * unanchored one. Still fully searchable; this gates automatic injection only.
   */
  minImportance?: number | undefined;
  /**
   * Minimum relation strength for automatic injection. Memories whose
   * relationStrength falls below this bar are rejected before the composite
   * score is consulted. Defaults to {@link MIN_RELATION_STRENGTH}.
   */
  relationFloor?: number | undefined;
  /**
   * Milliseconds before an already-injected memory may be injected again in
   * the same session. `0` or a non-finite value means "once per session" —
   * the default. Repeating a memory the model has already been shown spends
   * context to say nothing new.
   *
   * Note: prior versions defaulted to a 30-minute time-boxed cooldown. The
   * default changed to once-per-session; operators upgrading without setting
   * this option will see memories re-injected every turn instead of every
   * 30 minutes. Set a positive millisecond value to restore the old behaviour.
   *
   * Sessionless payloads are keyed under the synthetic `<no-session>` token,
   * so two distinct sessions sharing one process will collide on that ledger.
   * Callers that route sessionless work through multiple logical sessions
   * should pass a unique `ctx.session.id` per session.
   */
  repeatCooldownMs?: number | undefined;
  verifyOnMutation?: boolean | undefined;
  /**
   * Fold live todo/Kanban text into the retrieval query. Default: false —
   * it searches for the operator's task rather than the file the tool
   * touched, which is the single largest source of unrelated matches.
   */
  taskAware?: boolean | undefined;
  triggers?: Partial<Record<MemoryToolTrigger, boolean>> | undefined;
  /**
   * Shared registry of recently injected memories, used by the turn
   * middleware to detect assistant references and credit `recordUse`.
   * No default: a private tracker here would register injections the turn
   * middleware could never match, silently dropping use signals.
   */
  tracker?: InjectionTracker | undefined;
  /** Shared application bus used by TUI/WebUI observability. */
  events?: EventBus | undefined;
}

export interface SageRetrieverLike {
  retrieveForPath(opts: {
    path: string;
    limit?: number;
    includeAncestors?: boolean;
    includeStatuses?: Sage['status'][];
    includeAudienceScoped?: boolean;
    sessionId?: string | undefined;
    includeAllSessions?: boolean | undefined;
  }): Promise<Sage[]>;
  searchSage(
    query: string,
    opts?: {
      limit?: number;
      includeAudienceScoped?: boolean;
      requireAllTerms?: boolean;
      sessionId?: string | undefined;
      includeAllSessions?: boolean | undefined;
    },
  ): Promise<Sage[]>;
  findRelatedSage?(
    memoryIds: string[],
    opts?: {
      limit?: number;
      maxDepth?: number;
      includeStatuses?: Sage['status'][];
      includeAudienceScoped?: boolean;
      sessionId?: string | undefined;
      includeAllSessions?: boolean | undefined;
    },
  ): Promise<Sage[]>;
  verifyForPaths?(paths: string[], signal?: AbortSignal): Promise<unknown>;
  recordInjection?(memoryIds: string[], trigger: string, sessionId?: string): void | Promise<void>;
  recordUse?(memoryIds: string[], source: string, sessionId?: string): void | Promise<void>;
}

export type SageSearchLike = Pick<
  SageRetrieverLike,
  'searchSage' | 'recordInjection' | 'recordUse'
>;

export type MemoryToolTrigger =
  | 'read'
  | 'tree'
  | 'grep'
  | 'glob'
  | 'codebase_search'
  | 'write'
  | 'edit'
  | 'patch';

interface ExtractedTriggerContext {
  trigger: MemoryToolTrigger;
  paths: string[];
  queryText: string;
}

interface RetrievedMemory {
  memory: Sage;
  /** 0..1 strength of the concrete tool/path/query/graph relationship. */
  relationStrength: number;
  /** Human-readable retrieval paths retained for activation observability. */
  retrievalReasons: string[];
}

const DEFAULT_MAX_HINTS = 8;
const DEFAULT_MAX_CHARS = 2800;
/** `0` = once per session. See `applyCooldown`. */
const DEFAULT_REPEAT_COOLDOWN_MS = 0;
/**
 * Evidence floor for automatic injection.
 *
 * Measured 2026-07-30: at the old 0.62 floor the `minScore` gate was dead —
 * the weakest relation that could reach the scorer already produced 0.672
 * against a 0.65 bar, so nothing was ever rejected on score. The floor is the
 * gate that actually decides, so it carries the bar. At 0.85 the gate admits
 * exact file/symbol/command anchors (0.95+), multi-tag strong matches
 * (≥0.89), and two-plus anchor-term matches (~0.88+) — and rejects
 * single/double tag-term matches (0.78/0.84), immediate-parent directory
 * anchors (0.84), lexical overlaps, and shared-tag graph neighbours,
 * which is where the noise came from. Configurable via the
 * `Sage.inject.relationFloor` config key or the TUI `/settings` picker.
 */
export const MIN_RELATION_STRENGTH = 0.85;
export const DEFAULT_MIN_SCORE = 0.72;
export const DEFAULT_MIN_IMPORTANCE = 0.5;
/**
 * Cap on the once-per-session ledger. It is keyed by session+memory and never
 * expires by age, so it only needs a backstop against an unbounded process
 * lifetime; at this size eviction is unreachable in a real session.
 */
const MAX_TRACKED_INJECTIONS = 20_000;

export function createSageToolCallMiddleware(
  opts: SageToolCallMiddlewareOptions,
): Middleware<ToolCallPipelinePayload> {
  const seen = new Map<string, number>();
  const pruneState = { lastPruneAt: 0 };
  const injector = new MemoryInjectorAgent();
  // Hoisted out of the handler so the catch-path trace can report the same
  // gates the try-path used — a proof emitted without its threshold is noise.
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const minImportance = opts.minImportance ?? DEFAULT_MIN_IMPORTANCE;
  const relationFloor = opts.relationFloor ?? MIN_RELATION_STRENGTH;
  const thresholds = { minScore, minImportance, relationFloor };
  return {
    name: 'sage.tool-result-injection',
    owner: 'sage',
    async handler(payload, next) {
      const nextPayload = await next(payload);
      if (opts.enabled === false) return nextPayload;
      let attemptedTrigger: ExtractedTriggerContext | undefined;
      let attemptedPlan: ReturnType<MemoryInjectorAgent['plan']> | undefined;
      try {
        if (nextPayload.result.is_error) return nextPayload;

        const trigger = extractTrigger(nextPayload.toolUse.name, nextPayload.toolUse.input);
        if (!trigger) return nextPayload;
        if (opts.triggers?.[trigger.trigger] === false) return nextPayload;
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
          baseMaxChars: opts.maxCharsPerTool ?? DEFAULT_MAX_CHARS,
          taskAware: opts.taskAware,
        });
        attemptedPlan = plan;
        trigger.queryText = plan.queryText;
        const maxHints = plan.maxHints;
        const memories = await retrieveTriggeredMemories(
          opts.memory,
          trigger,
          maxHints,
          nextPayload.ctx.projectRoot,
          relationFloor,
          opts.getSessionId?.(),
        );
        const alreadyVisible = visibleContextText(nextPayload);
        const deduped = dedupeRetrievedByText(memories);
        const scoreEligible = deduped.filter(
          ({ memory, relationStrength }) =>
            memory.importance >= minImportance &&
            relationStrength >= relationFloor &&
            contextualInjectionScore(memory, relationStrength) >= minScore,
        );
        const eligibleItems = scoreEligible
          .filter(({ memory }) => !containsMemoryText(alreadyVisible, memory.text))
          .sort(
            (a, b) =>
              contextualInjectionScore(b.memory, b.relationStrength) -
              contextualInjectionScore(a.memory, a.relationStrength),
          );
        const eligible = eligibleItems.map((item) => item.memory);
        // Unify the session source: retrieval uses opts.getSessionId?.() (line
        // above), so the cooldown ledger must key on the same value. When no
        // getSessionId is provided, fall back to ctx.session.id so the ledger
        // is still scoped per-session rather than process-global.
        const sessionId =
          opts.getSessionId?.() ?? (nextPayload.ctx.session as { id?: string } | undefined)?.id;
        const fresh = applyCooldown(
          eligible,
          seen,
          opts.repeatCooldownMs ?? DEFAULT_REPEAT_COOLDOWN_MS,
          sessionId,
        );
        const rejectedBase = {
          duplicate: memories.length - deduped.length,
          belowScore: deduped.length - scoreEligible.length,
          alreadyVisible: scoreEligible.length - eligible.length,
          cooldown: eligible.length - fresh.length,
          budget: 0,
        };
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
            activated: [],
            injected: [],
            injectedChars: 0,
            thresholds,
          });
          return nextPayload;
        }

        const maxChars = availableHintChars(nextPayload, plan.maxChars);
        const selected = selectDiverseMemories(
          fresh,
          maxHints,
          new Map(eligibleItems.map((item) => [item.memory.id, item.retrievalReasons])),
        );
        const rendered = formatMemoryHintsDetailed(selected, {
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

        // Keep retrieval evidence out of the tool protocol payload. Appending
        // it to `tool_result.content` duplicates SAGE text inside durable tool
        // history and makes file-read lifecycle cleanup unable to distinguish
        // source bytes from advisory memory. Context owns one bounded slot;
        // request construction renders it as an ephemeral system suffix.
        storeProviderMemoryEvidence(nextPayload.ctx, rendered.text, plan.maxChars);
        const now = Date.now();
        for (const memoryId of rendered.memoryIds) seen.set(cooldownKey(memoryId, sessionId), now);
        pruneCooldowns(seen, pruneState, now, opts.repeatCooldownMs ?? DEFAULT_REPEAT_COOLDOWN_MS);
        if (opts.tracker) {
          const injectedById = new Map(selected.map((memory) => [memory.id, memory]));
          for (const memoryId of rendered.memoryIds) {
            const memory = injectedById.get(memoryId)!;
            opts.tracker.record(memoryId, memory.text, now, sessionId, rendered.text);
          }
        }
        let auditError: string | undefined;
        try {
          await opts.memory.recordInjection?.(rendered.memoryIds, trigger.trigger, sessionId);
        } catch (error) {
          // The context mutation already happened. Preserve an accurate UI
          // trace even if persisting the secondary injection audit failed.
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
          activated: selected.flatMap((memory) => {
            return [toTraceMemory(selectedById.get(memory.id)!, plan)];
          }),
          injected: rendered.memoryIds.flatMap((id) => {
            return [toTraceMemory(selectedById.get(id)!, plan)];
          }),
          injectedChars: rendered.text.length,
          thresholds,
          error: auditError,
        });
        return nextPayload;
      } catch (error) {
        if (attemptedTrigger) {
          const fallbackPlan =
            attemptedPlan ??
            injector.plan({
              ctx: nextPayload.ctx,
              trigger: attemptedTrigger.trigger,
              toolQuery: attemptedTrigger.queryText,
              baseMaxHints: opts.maxHintsPerTool ?? DEFAULT_MAX_HINTS,
              baseMaxChars: opts.maxCharsPerTool ?? DEFAULT_MAX_CHARS,
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
            activated: [],
            injected: [],
            injectedChars: 0,
            thresholds,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Memory is advisory. Storage/retrieval failure must never turn a
        // successful filesystem or command tool call into an agent failure.
        return nextPayload;
      }
    },
  };
}

function storeProviderMemoryEvidence(
  ctx: ToolCallPipelinePayload['ctx'],
  text: string,
  maxChars: number,
): void {
  const host = ctx as ToolCallPipelinePayload['ctx'] & {
    memoryEvidence?: Array<{ source: string; text: string }>;
    setMemoryEvidence?: (source: string, text: string, maxChars?: number) => void;
  };
  if (typeof host.setMemoryEvidence === 'function') {
    host.setMemoryEvidence('sage.tool-memory', text, maxChars);
    return;
  }
  const retained = (host.memoryEvidence ?? []).filter(
    (entry) => entry.source !== 'sage.tool-memory',
  );
  retained.push({ source: 'sage.tool-memory', text: text.slice(0, Math.max(0, maxChars)) });
  host.memoryEvidence = retained.slice(-8);
}

interface InjectorTraceMemory {
  id: string;
  kind: string;
  text: string;
  score: number;
  relationStrength: number;
  anchor?: string | undefined;
  anchors: string[];
  tags: string[];
  activationReasons: string[];
  importance: number;
  confidence: number;
  freshness: number;
  persistence: string;
  /** Metadata floor before weighting — lets the UI show the score's operands. */
  metadataScore: number;
  /** Signed score contributions; they sum to the pre-clamp `score`. */
  scoreTerms: InjectionScoreTerm[];
}

interface InjectorTraceInput {
  nextPayload: ToolCallPipelinePayload;
  trigger: ExtractedTriggerContext;
  plan: ReturnType<MemoryInjectorAgent['plan']>;
  outcome: 'injected' | 'empty' | 'error';
  candidates: number;
  eligible: number;
  rejected: {
    duplicate: number;
    belowScore: number;
    alreadyVisible: number;
    cooldown: number;
    budget: number;
  };
  activated: InjectorTraceMemory[];
  injected: InjectorTraceMemory[];
  injectedChars: number;
  /**
   * The gates in force for this run. Without them a displayed score is
   * unreadable — 0.67 means nothing until you know the bar was 0.65.
   */
  thresholds: { minScore: number; minImportance: number; relationFloor: number };
  error?: string | undefined;
}

let injectorTraceSequence = 0;

function emitInjectorTrace(events: EventBus | undefined, input: InjectorTraceInput): void {
  if (!events) return;
  const sessionId = (input.nextPayload.ctx.session as { id?: string } | undefined)?.id;
  // SAGE is compiled against the published core declaration surface,
  // which may lag the workspace's newly-added typed event by one build. Keep
  // the runtime EventBus path (named + wildcard subscribers) while allowing
  // independent package typechecks during that build boundary.
  const emit = events.emit as unknown as (event: string, payload: unknown) => void;
  emit.call(events, 'memory.injector_run', {
    runId: `meminj_${Date.now()}_${++injectorTraceSequence}`,
    at: new Date().toISOString(),
    outcome: input.outcome,
    trigger: input.trigger.trigger,
    toolName: input.nextPayload.toolUse.name,
    // The query is the single most diagnostic field here: task-aware planning
    // splices todo/Kanban text onto the tool path, so a memory that looks
    // unrelated to the conversation is often a legitimate match against text
    // the operator never typed. Truncating at 240 hid exactly that tail.
    queryPreview: boundedText(input.plan.queryText, 600),
    paths: input.trigger.paths.slice(0, 8),
    taskSignals: input.plan.taskSignals.slice(0, 6).map((signal) => boundedText(signal, 160)),
    contextPressure: Number(input.plan.contextPressure.toFixed(3)),
    budget: { maxHints: input.plan.maxHints, maxChars: input.plan.maxChars },
    thresholds: input.thresholds,
    candidates: input.candidates,
    eligible: input.eligible,
    rejected: input.rejected,
    activated: input.activated,
    injected: input.injected,
    injectedChars: input.injectedChars,
    error: input.error ? boundedText(input.error, 300) : undefined,
    sessionId,
  });
}

function toTraceMemory(
  item: RetrievedMemory,
  plan: ReturnType<MemoryInjectorAgent['plan']>,
): InjectorTraceMemory {
  const anchor = item.memory.anchors[0];
  const query = plan.queryText.toLowerCase();
  const taskText = plan.taskSignals.join(' ').toLowerCase();
  const matchedTags = item.memory.tags
    .filter((tag) => query.includes(tag.toLowerCase()))
    .slice(0, 6);
  const taskTags = item.memory.tags
    .filter((tag) => taskText.includes(tag.toLowerCase()))
    .slice(0, 4);
  const activationReasons = [
    ...item.retrievalReasons,
    ...matchedTags.map((tag) => `tag:#${tag}`),
    ...taskTags.map((tag) => `task:#${tag}`),
  ];
  const proof = computeInjectionProof(item.memory, item.relationStrength);
  return {
    id: item.memory.id,
    kind: item.memory.kind,
    text: boundedText(item.memory.text, 180),
    score: Number(proof.score.toFixed(3)),
    relationStrength: Number(item.relationStrength.toFixed(3)),
    metadataScore: Number(proof.metadataScore.toFixed(3)),
    scoreTerms: proof.terms.map((term) => ({
      label: term.label,
      value: Number(term.value.toFixed(3)),
    })),
    anchor: anchor ? formatTraceAnchor(anchor) : undefined,
    anchors: item.memory.anchors.slice(0, 5).map(formatTraceAnchor),
    tags: item.memory.tags.slice(0, 8),
    activationReasons: [...new Set(activationReasons)]
      .slice(0, 8)
      .map((reason) => boundedText(reason, 140)),
    importance: Number(item.memory.importance.toFixed(3)),
    confidence: Number(item.memory.confidence.toFixed(3)),
    freshness: Number(item.memory.freshness.toFixed(3)),
    persistence: item.memory.persistence ?? DEFAULT_PERSISTENCE,
  };
}

function formatTraceAnchor(anchor: Sage['anchors'][number]): string {
  if (anchor.symbol) return `${anchor.type}:${anchor.symbol}`;
  if (anchor.path) return `${anchor.type}:${anchor.path}`;
  if (anchor.command) return `${anchor.type}:${boundedText(anchor.command, 100)}`;
  if (anchor.role) return `${anchor.type}:${anchor.role}`;
  return anchor.type;
}

function boundedText(value: string, maxChars: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
}

async function retrieveTriggeredMemories(
  memory: SageRetrieverLike,
  trigger: ExtractedTriggerContext,
  limit: number,
  projectRoot?: string | undefined,
  relationFloor?: number | undefined,
  sessionId?: string | undefined,
): Promise<RetrievedMemory[]> {
  // Path lookups and the lexical query lookup are independent reads — run
  // them concurrently instead of serially awaiting each path in turn.
  // Promise.all preserves the previous failure mode: any rejection rejects
  // the whole retrieve, which the handler's outer try/catch turns into
  // "no injection" (memory is advisory).
  const candidateLimit = Math.max(limit * 2, limit);
  const pending: Array<Promise<RetrievedMemory[]>> = trigger.paths.map((p) =>
    memory
      .retrieveForPath({
        path: p,
        limit: candidateLimit,
        includeAncestors: true,
        // Stale records may warn immediately after a mutation/verification pass,
        // but deleted records are tombstones and never belong in model context.
        includeStatuses: isMutationTrigger(trigger.trigger) ? ['active', 'stale'] : ['active'],
        includeAudienceScoped: false,
        sessionId,
      })
      .then((matches) =>
        // The store matches ancestors, so this answer also contains memories
        // anchored to a directory far above the file. Measure each one against
        // the path that was actually touched instead of paying every hit the
        // flat 0.95 an exact anchor earns — that flat rate is what put
        // project-wide notes on every single read.
        matches.flatMap((item) => {
          const relation = pathAnchorRelation(item, relativeProjectPath(projectRoot, p));
          if (!relation) return [];
          return [
            {
              memory: item,
              relationStrength: relation.strength,
              retrievalReasons: [relation.reason],
            },
          ];
        }),
      ),
  );
  if (trigger.queryText.trim()) {
    pending.push(
      memory
        .searchSage(trigger.queryText, {
          // The store's broad lexical API is also used for explicit user search.
          // Pull a wider pool here, then apply the inject-only evidence gate below.
          limit: Math.max(candidateLimit * 4, 64),
          includeAudienceScoped: false,
          // Never widen an automatic query to OR. The store's any-term retry
          // exists for the operator typing into `/memory search`; here it
          // turns a zero-result query into a corpus scan whose hits share one
          // incidental word with the tool path.
          requireAllTerms: true,
          sessionId,
        })
        .then((matches) =>
          matches.map((item) => {
            const relevance = memoryQueryRelevance(item, trigger.queryText);
            return {
              memory: item,
              relationStrength: relevance.strength,
              retrievalReasons:
                relevance.evidence.length > 0
                  ? relevance.evidence
                  : ['query:insufficient-evidence'],
            };
          }),
        ),
    );
  }
  const byId = new Map<string, RetrievedMemory>();
  for (const matches of await Promise.all(pending)) {
    for (const item of matches) {
      const existing = byId.get(item.memory.id);
      if (!existing) {
        byId.set(item.memory.id, item);
      } else {
        byId.set(item.memory.id, {
          memory: item.relationStrength > existing.relationStrength ? item.memory : existing.memory,
          relationStrength: Math.max(item.relationStrength, existing.relationStrength),
          retrievalReasons: [...new Set([...existing.retrievalReasons, ...item.retrievalReasons])],
        });
      }
    }
  }

  // Expand only from strong direct seeds. A lexical candidate that merely
  // shares one weak term must not open a three-hop walk across the project.
  const graphSeeds = [...byId.values()].filter(
    (item) =>
      item.relationStrength >= 0.9 &&
      item.retrievalReasons.some(
        (reason) => reason.startsWith('anchor:') || reason.startsWith('query:exact-'),
      ),
  );
  if (memory.findRelatedSage && graphSeeds.length > 0) {
    const related = await memory.findRelatedSage(
      graphSeeds.map((item) => item.memory.id),
      {
        limit: candidateLimit,
        // Two hops from an exact anchor is already a memory nobody asked for.
        maxDepth: 2,
        includeStatuses: isMutationTrigger(trigger.trigger) ? ['active', 'stale'] : ['active'],
        includeAudienceScoped: false,
        // Session isolation: graph expansion must never surface another
        // session's session-scoped memories into this session's context.
        sessionId,
      },
    );
    for (const item of related) {
      const relevance = memoryStructuralRelevance(
        item,
        graphSeeds.map((seed) => seed.memory),
      );
      if (!byId.has(item.id) && relevance.strength >= (relationFloor ?? MIN_RELATION_STRENGTH)) {
        byId.set(item.id, {
          memory: item,
          relationStrength: relevance.strength,
          retrievalReasons: relevance.evidence,
        });
      }
    }
  }

  return [...byId.values()]
    .filter(
      ({ memory: item }) =>
        (item.status === 'active' || item.status === 'stale') &&
        item.contextPolicy !== 'never' &&
        item.kind !== 'memory_review',
    )
    .sort(
      (a, b) =>
        contextualInjectionScore(b.memory, b.relationStrength) -
        contextualInjectionScore(a.memory, a.relationStrength),
    );
}

/**
 * Least broad directory anchor allowed to carry a match, in path segments.
 * `.` (0) and `packages` (1) sit above half the repository; a memory anchored
 * there is a project-wide note, and treating it as evidence for one file is
 * how every tool call ended up with a memory attached.
 */
const MIN_ANCESTOR_ANCHOR_SEGMENTS = 2;
/** Relation lost per directory level between the anchor and the touched file. */
const ANCESTOR_DECAY_PER_SEGMENT = 0.11;

/**
 * Strength of the tie between one memory's own anchors and the path a tool
 * touched. `undefined` means the memory carries no anchor evidence for this
 * path — the store's ancestor/LIKE matching returned it, but nothing in the
 * record actually points here, so the path branch contributes nothing and the
 * memory must earn its place through the lexical query instead.
 */
function pathAnchorRelation(
  memory: Sage,
  relPath: string,
): { strength: number; reason: string } | undefined {
  if (!relPath || relPath === '.') return undefined;
  const targetDepth = relPath.split('/').filter(Boolean).length;
  let best: { strength: number; reason: string } | undefined;
  const keep = (candidate: { strength: number; reason: string }): void => {
    if (!best || candidate.strength > best.strength) best = candidate;
  };
  for (const anchor of memory.anchors) {
    const anchorPath = normalizeAnchorPath(anchor.path);
    if (!anchorPath) continue;
    if (anchorPath === relPath) {
      keep({
        strength: anchor.symbol || anchor.command ? 0.98 : 0.95,
        reason: `anchor:${anchor.type}-exact`,
      });
      continue;
    }
    if (!relPath.startsWith(`${anchorPath}/`)) continue;
    const anchorDepth = anchorPath.split('/').filter(Boolean).length;
    if (anchorDepth < MIN_ANCESTOR_ANCHOR_SEGMENTS) continue;
    const distance = targetDepth - anchorDepth;
    keep({
      strength: Math.max(0, 0.95 - distance * ANCESTOR_DECAY_PER_SEGMENT),
      reason: `anchor:ancestor-${distance}`,
    });
  }
  return best;
}

function normalizeAnchorPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '')
    .toLowerCase();
  return normalized && normalized !== '.' ? normalized : undefined;
}

/**
 * Tool path → the project-relative, forward-slashed form anchors are stored
 * in. Total by construction: an already-relative path passes through, and a
 * path outside the root resolves to `''`, which carries no anchor evidence.
 */
function relativeProjectPath(projectRoot: string | undefined, toolPath: string): string {
  const normalized = toolPath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  if (!projectRoot || !path.isAbsolute(toolPath)) return normalized;
  const relative = path.relative(path.resolve(projectRoot), toolPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return relative.replace(/\\/g, '/').toLowerCase();
}

/**
 * Drop memories this session has already been shown.
 *
 * A repeat costs context and carries no new information — the model saw the
 * text the first time. With `cooldownMs <= 0` (the default) the ledger is
 * permanent for the session; a positive value restores the old time-boxed
 * behaviour for operators who want it.
 */
function applyCooldown(
  memories: Sage[],
  seen: Map<string, number>,
  cooldownMs: number,
  sessionId?: string,
): Sage[] {
  const now = Date.now();
  const permanent = !Number.isFinite(cooldownMs) || cooldownMs <= 0;
  return memories.filter((memory) => {
    const last = seen.get(cooldownKey(memory.id, sessionId));
    if (last === undefined) return true;
    return permanent ? false : now - last >= cooldownMs;
  });
}

function cooldownKey(memoryId: string, sessionId?: string): string {
  return `${sessionId ?? '<no-session>'}:${memoryId}`;
}

interface CooldownPruneState {
  lastPruneAt: number;
}

const PRUNE_COOLDOWNS_INTERVAL_MS = 60_000;

function pruneCooldowns(
  seen: Map<string, number>,
  state: CooldownPruneState,
  now: number,
  cooldownMs: number,
): void {
  if (now - state.lastPruneAt < PRUNE_COOLDOWNS_INTERVAL_MS) return;
  state.lastPruneAt = now;
  if (Number.isFinite(cooldownMs) && cooldownMs > 0) {
    const oldestUseful = now - Math.max(cooldownMs, 60 * 60_000);
    for (const [key, at] of seen) {
      if (at < oldestUseful) seen.delete(key);
    }
    return;
  }
  // Once-per-session mode: age says nothing about whether an entry is still
  // needed, so evicting by time would silently re-enable repeat injection.
  // Bound the map by size instead, oldest first.
  if (seen.size <= MAX_TRACKED_INJECTIONS) return;
  const ordered = [...seen.entries()].sort((a, b) => a[1] - b[1]);
  for (const [key] of ordered.slice(0, seen.size - MAX_TRACKED_INJECTIONS)) seen.delete(key);
}

function scoreForInjection(memory: Sage): number {
  return memory.importance * 3 + memory.confidence * 2 + memory.freshness;
}

function normalizedInjectionScore(memory: Sage): number {
  return scoreForInjection(memory) / 6;
}

/**
 * One signed contribution to the injection score. `label` is UI-facing and
 * carries the raw operand (e.g. `metadata 0.72×0.48`) so an operator can see
 * *which* term carried a memory over the threshold rather than only the sum.
 */
export interface InjectionScoreTerm {
  label: string;
  value: number;
}

export interface InjectionProof {
  score: number;
  /** The metadata floor before weighting — (importance*3 + confidence*2 + freshness) / 6. */
  metadataScore: number;
  relationStrength: number;
  /** Signed contributions; they sum to the pre-clamp score. */
  terms: InjectionScoreTerm[];
}

/**
 * Decompose the injection score into its contributing terms.
 *
 * This is the authority for the score — `contextualInjectionScore` is a thin
 * wrapper over it — so the number an operator is shown can never drift from
 * the number the gate used. The term sum is the pre-clamp score by
 * construction; do not add a contribution here without pushing it onto
 * `terms`, or the displayed proof stops adding up to the verdict.
 */
function computeInjectionProof(memory: Sage, relationStrength: number): InjectionProof {
  const metadataScore = normalizedInjectionScore(memory);
  const persistence = memory.persistence ?? DEFAULT_PERSISTENCE;
  const persistenceBoost =
    persistence === 'permanent' ? 0.08 : persistence === 'long_lived' ? 0.04 : -0.08;
  const durableKindBoost = durableMemoryKind(memory.kind) ? 0.04 : 0;
  // Proven usefulness: memories the assistant actually referenced should win
  // budget slots over never-used noise that only has high importance defaults.
  const uses = memory.useCount ?? 0;
  const useBoost = uses > 0 ? Math.min(0.14, 0.05 + uses * 0.02) : 0;
  // Anchored knowledge is the inject path's primary retrieval key — unanchored
  // facts rely on weak lexical overlap and should not crowd path-matched slots.
  const anchorBoost = memory.anchors.length > 0 ? 0.04 : -0.05;
  const injections = memory.injectionCount ?? 0;
  const unusedPenalty =
    injections >= 3 && uses === 0 ? Math.min(0.18, 0.05 + injections * 0.012) : 0;

  const terms: InjectionScoreTerm[] = [
    { label: `metadata ${metadataScore.toFixed(2)}×0.48`, value: metadataScore * 0.48 },
    { label: `relation ${relationStrength.toFixed(2)}×0.48`, value: relationStrength * 0.48 },
    { label: persistence, value: persistenceBoost },
  ];
  if (durableKindBoost !== 0) {
    terms.push({ label: `durable(${memory.kind})`, value: durableKindBoost });
  }
  if (useBoost !== 0) terms.push({ label: `used×${uses}`, value: useBoost });
  terms.push({
    label: memory.anchors.length > 0 ? `anchored×${memory.anchors.length}` : 'unanchored',
    value: anchorBoost,
  });
  if (unusedPenalty !== 0) {
    terms.push({ label: `unused after ${injections} injections`, value: -unusedPenalty });
  }

  let raw = 0;
  for (const term of terms) raw += term.value;
  return { score: Math.max(0, Math.min(1, raw)), metadataScore, relationStrength, terms };
}

function contextualInjectionScore(memory: Sage, relationStrength: number): number {
  return computeInjectionProof(memory, relationStrength).score;
}

function durableMemoryKind(kind: Sage['kind']): boolean {
  return (
    kind === 'fact' ||
    kind === 'decision' ||
    kind === 'convention' ||
    kind === 'warning' ||
    kind === 'anti_pattern' ||
    kind === 'workflow' ||
    kind === 'bug_root_cause' ||
    kind === 'file_note' ||
    kind === 'symbol_note' ||
    kind === 'command_note' ||
    kind === 'tool_outcome' ||
    kind === 'error_pattern' ||
    kind === 'role_operational' ||
    kind === 'task_outcome' ||
    kind === 'security_signal' ||
    kind === 'fleet_convention'
  );
}

function isMutationTrigger(trigger: MemoryToolTrigger): boolean {
  return trigger === 'write' || trigger === 'edit' || trigger === 'patch';
}

function didMutate(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === 'replace') return input['dry_run'] === false;
  if (toolName === 'patch') return input['dry_run'] !== true;
  return true;
}

function extractTrigger(
  toolName: string,
  input: Record<string, unknown>,
): ExtractedTriggerContext | undefined {
  switch (toolName) {
    case 'read':
      return {
        trigger: 'read',
        paths: stringValues(input.path),
        queryText: enrichPathQuery(stringValues(input.path)),
      };
    case 'tree':
      return {
        trigger: 'tree',
        paths: stringValues(input.path ?? '.'),
        queryText: enrichPathQuery(stringValues(input.path ?? '.')),
      };
    case 'grep':
      return {
        trigger: 'grep',
        paths: stringValues(input.path ?? '.'),
        queryText: joinQueryParts(
          input.pattern,
          input.glob,
          enrichPathQuery(stringValues(input.path ?? '.')),
        ),
      };
    case 'glob':
      return {
        trigger: 'glob',
        paths: stringValues(input.path ?? '.'),
        queryText: joinQueryParts(
          input.pattern,
          input.glob,
          enrichPathQuery(stringValues(input.path ?? '.')),
        ),
      };
    case 'codebase_search':
    case 'codebase-search':
      return {
        trigger: 'codebase_search',
        paths: stringValues(input.path),
        queryText: joinQueryParts(input.query, input.q, enrichPathQuery(stringValues(input.path))),
      };
    case 'write':
      return {
        trigger: 'write',
        paths: stringValues(input.path),
        queryText: enrichPathQuery(stringValues(input.path)),
      };
    case 'edit':
      return {
        trigger: 'edit',
        paths: stringValues(input.path),
        queryText: enrichPathQuery(stringValues(input.path)),
      };
    case 'replace': {
      const files = stringValues(input.files).flatMap(splitFileList);
      return {
        trigger: 'edit',
        paths: files,
        queryText: joinQueryParts(
          enrichPathQuery(files),
          ...stringValues(input.pattern),
          ...stringValues(input.glob),
        ),
      };
    }
    case 'patch': {
      const patchPaths = extractPatchPaths(input);
      return {
        trigger: 'patch',
        paths: patchPaths,
        queryText: joinQueryParts(input.directory, enrichPathQuery(patchPaths)),
      };
    }
    default:
      return undefined;
  }
}

function joinQueryParts(...parts: unknown[]): string {
  return parts
    .flatMap((part) => (typeof part === 'string' ? [part.trim()] : []))
    .filter((part) => part.length > 0)
    .join(' ');
}

/**
 * Expand raw tool paths into FTS-friendly lexical seeds: full path, basename
 * without extension, and immediate parent directory. Path-only triggers used
 * to search as one long slash-separated string that rarely matched memory text
 * containing just the symbol or file stem.
 */
function enrichPathQuery(paths: string[]): string {
  const terms: string[] = [];
  for (const raw of paths) {
    const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '').trim();
    if (!normalized || normalized === '.') continue;
    terms.push(normalized);
    const segments = normalized.split('/').filter(Boolean);
    const base = segments[segments.length - 1];
    if (base) {
      terms.push(base);
      const stem = base.replace(/\.[a-z0-9]{1,8}$/i, '');
      if (stem && stem !== base) terms.push(stem);
    }
    if (segments.length >= 2) {
      const parent = segments[segments.length - 2]!;
      if (parent.length >= 3) terms.push(parent);
    }
  }
  return [...new Set(terms)].join(' ');
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value))
    return value
      .filter(isString)
      .map((v) => v.trim())
      .filter(Boolean);
  return [];
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function splitFileList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractPatchPaths(input: Record<string, unknown>): string[] {
  if (typeof input.patch !== 'string') return [];
  const strip = Math.max(1, Math.floor(typeof input.strip === 'number' ? input.strip : 1));
  const directory = typeof input.directory === 'string' ? input.directory.trim() : '';
  const result: string[] = [];
  for (const match of input.patch.matchAll(/^\+\+\+\s+([^\t\r\n]+)/gm)) {
    const raw = match[1]?.trim();
    if (!raw || raw === '/dev/null') continue;
    const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    const stripped = normalized.split('/').filter(Boolean).slice(strip).join('/');
    if (!stripped) continue;
    result.push(directory ? path.join(directory, stripped) : stripped);
  }
  return [...new Set(result)];
}

function extractResultPaths(content: string, trigger: MemoryToolTrigger): string[] {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return [];
  }
  const result: string[] = [];
  const visit = (current: unknown, key?: string): void => {
    if (typeof current === 'string') {
      if (key === 'path' || key === 'file' || key === 'file_path' || key === 'files')
        result.push(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, key);
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [childKey, child] of Object.entries(current as Record<string, unknown>)) {
      if (
        childKey === 'files' ||
        childKey === 'paths' ||
        childKey === 'path' ||
        childKey === 'file' ||
        childKey === 'file_path' ||
        (childKey === 'results' &&
          (trigger === 'glob' || trigger === 'tree' || trigger === 'codebase_search'))
      ) {
        visit(child, childKey === 'paths' || childKey === 'results' ? 'path' : childKey);
      }
    }
  };
  visit(value);
  return result;
}

function resolveTriggerPaths(values: string[], ctx: ToolCallPipelinePayload['ctx']): string[] {
  const root = path.resolve(ctx.projectRoot);
  const base = path.resolve(ctx.workingDir ?? ctx.cwd ?? ctx.projectRoot);
  const result: string[] = [];
  for (const value of values) {
    // Glob patterns are useful lexical query text but cannot be mapped to one
    // concrete anchor safely.
    if (/[*?{}[\]]/.test(value)) continue;
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    result.push(absolute);
  }
  return [...new Set(result)];
}

function visibleContextText(payload: ToolCallPipelinePayload): string {
  const prompt = (payload.ctx as unknown as { systemPrompt?: Array<{ text?: string }> })
    .systemPrompt;
  return [payload.result.content, ...(prompt ?? []).map((block) => block.text ?? '')]
    .join('\n')
    .toLowerCase();
}

/**
 * Minimum haystack-substring length required to count a memory as "already
 * visible" in the current prompt. Shorter strings blanket-match the
 * system prompt and cause self-suppression: a memory whose text is "true"
 * or "the file was edited" will appear in virtually every conversation's
 * system prompt and silently be filtered out, so the LLM never sees it
 * again. 24 chars is the threshold where substring match becomes
 * specific enough that false positives are rare in practice — short
 * phrases like "rm -rf /" (8 chars), "pnpm test" (9 chars), or "use pnpm"
 * (8 chars) all fall BELOW it and are preserved (not filtered), while
 * single-word matches like "true" / "false" / "ok" / "yes" / "no" also
 * fall below and are preserved. Length-24+ phrases are specific enough
 * that an exact substring match in the system prompt is unlikely to be
 * a false positive.
 */
const MIN_CONTAINS_LENGTH = 24;

export function containsMemoryText(haystack: string, memoryText: string): boolean {
  // Skip the cheap length check first so short-memory self-suppression
  // doesn't silently consume every injection budget. Trim before
  // measuring so trailing whitespace from `remember(text)` doesn't
  // edge a memory just over the threshold. Lowercase both sides so
  // the substring match is case-insensitive without relying on the
  // caller to pre-lowercase (visibleContextText does so today, but
  // the unit test contract must not).
  const needle = memoryText.trim().toLowerCase();
  if (needle.length < MIN_CONTAINS_LENGTH) return false;
  return haystack.toLowerCase().includes(needle);
}

function dedupeRetrievedByText(memories: RetrievedMemory[]): RetrievedMemory[] {
  const seen = new Set<string>();
  return memories.filter(({ memory }) => {
    const key = normalizeTextKey(memory.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Avoid spending the whole hint budget on one dense category (for example
 * eight file_notes). First take at most three of each kind, then use any spare
 * capacity for the remaining highest-ranked records.
 */
function selectDiverseMemories(
  memories: Sage[],
  limit: number,
  reasonsById: Map<string, string[]> = new Map(),
): Sage[] {
  if (limit <= 0) return [];
  const selected: Sage[] = [];
  const deferred: Sage[] = [];
  const byKind = new Map<Sage['kind'], number>();
  let queryOnly = 0;
  let graphOnly = 0;
  for (const memory of memories) {
    const reasons = reasonsById.get(memory.id) ?? [];
    const hasPath = reasons.some((reason) => reason.startsWith('anchor:'));
    const hasGraph = reasons.some((reason) => reason.startsWith('graph:'));
    const hasQuery = reasons.some((reason) => reason.startsWith('query:'));
    if (!hasPath && hasGraph && graphOnly >= 1) continue;
    if (!hasPath && !hasGraph && hasQuery && queryOnly >= 2) continue;
    const count = byKind.get(memory.kind) ?? 0;
    if (count >= 3) {
      deferred.push(memory);
      continue;
    }
    selected.push(memory);
    if (!hasPath && hasGraph) graphOnly++;
    else if (!hasPath && hasQuery) queryOnly++;
    byKind.set(memory.kind, count + 1);
    if (selected.length >= limit) return selected;
  }
  for (const memory of deferred) {
    const reasons = reasonsById.get(memory.id) ?? [];
    const hasPath = reasons.some((reason) => reason.startsWith('anchor:'));
    const hasGraph = reasons.some((reason) => reason.startsWith('graph:'));
    const hasQuery = reasons.some((reason) => reason.startsWith('query:'));
    if (!hasPath && hasGraph && graphOnly >= 1) continue;
    if (!hasPath && !hasGraph && hasQuery && queryOnly >= 2) continue;
    selected.push(memory);
    if (!hasPath && hasGraph) graphOnly++;
    else if (!hasPath && hasQuery) queryOnly++;
    if (selected.length >= limit) break;
  }
  return selected;
}

function availableHintChars(payload: ToolCallPipelinePayload, configured: number): number {
  const wanted = Math.max(0, Math.floor(configured));
  const cap = payload.tool?.maxOutputBytes;
  if (!cap) return wanted;
  const remainingBytes = cap - Buffer.byteLength(payload.result.content, 'utf8') - 2;
  // A conservative char budget keeps UTF-8 hints inside the tool's byte cap.
  return Math.max(0, Math.min(wanted, Math.floor(remainingBytes / 3)));
}

/** Direct-module test seam; intentionally not re-exported by the package barrel. */
export const toolCallMemoryCoverage = {
  emitInjectorTrace,
  toTraceMemory,
  formatTraceAnchor,
  boundedText,
  retrieveTriggeredMemories,
  applyCooldown,
  cooldownKey,
  pruneCooldowns,
  scoreForInjection,
  normalizedInjectionScore,
  contextualInjectionScore,
  computeInjectionProof,
  durableMemoryKind,
  isMutationTrigger,
  didMutate,
  extractTrigger,
  enrichPathQuery,
  stringValues,
  isString,
  splitFileList,
  extractPatchPaths,
  extractResultPaths,
  resolveTriggerPaths,
  visibleContextText,
  dedupeRetrievedByText,
  selectDiverseMemories,
  availableHintChars,
};
