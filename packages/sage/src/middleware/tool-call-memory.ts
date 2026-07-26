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
  repeatCooldownMs?: number | undefined;
  verifyOnMutation?: boolean | undefined;
  /** Enrich retrieval with live todo/Kanban task state. Default: true. */
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
  }): Promise<Sage[]>;
  searchSage(
    query: string,
    opts?: { limit?: number; includeAudienceScoped?: boolean },
  ): Promise<Sage[]>;
  findRelatedSage?(
    memoryIds: string[],
    opts?: {
      limit?: number;
      maxDepth?: number;
      includeStatuses?: Sage['status'][];
      includeAudienceScoped?: boolean;
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
  | 'bash'
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
const DEFAULT_REPEAT_COOLDOWN_MS = 30 * 60_000;
const MIN_RELATION_STRENGTH = 0.62;

export function createSageToolCallMiddleware(
  opts: SageToolCallMiddlewareOptions,
): Middleware<ToolCallPipelinePayload> {
  const seen = new Map<string, number>();
  const pruneState = { lastPruneAt: 0 };
  const injector = new MemoryInjectorAgent();
  return {
    name: 'sage.tool-result-injection',
    owner: 'sage',
    async handler(payload, next) {
      const nextPayload = await next(payload);
      if (opts.enabled === false) return nextPayload;
      let attemptedTrigger: ExtractedTriggerContext | undefined;
      let attemptedPlan: ReturnType<MemoryInjectorAgent['plan']> | undefined;
      try {
        if (nextPayload.result.is_error && nextPayload.toolUse.name !== 'bash') return nextPayload;

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

        if (trigger.trigger === 'bash' && nextPayload.result.content) {
          trigger.queryText = `${trigger.queryText} ${nextPayload.result.content.slice(-2_000)}`;
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
        const memories = await retrieveTriggeredMemories(opts.memory, trigger, maxHints);
        const minScore = opts.minScore ?? 0.65;
        const alreadyVisible = visibleContextText(nextPayload);
        const deduped = dedupeRetrievedByText(memories);
        const scoreEligible = deduped.filter(
          ({ memory, relationStrength }) =>
            relationStrength >= MIN_RELATION_STRENGTH &&
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
        const sessionId = (nextPayload.ctx.session as { id?: string } | undefined)?.id;
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
          });
          return nextPayload;
        }

        const content = `${nextPayload.result.content.replace(/\s+$/, '')}\n\n${rendered.text}`;
        nextPayload.result.content = content;
        // The agent loop intentionally observes mutations on the original
        // ToolResultBlock and ignores a pipeline replacement return value.
        // Preserve injection even if a downstream plugin cloned the payload.
        payload.result.content = content;
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
    queryPreview: boundedText(input.plan.queryText, 240),
    paths: input.trigger.paths.slice(0, 8),
    taskSignals: input.plan.taskSignals.slice(0, 6).map((signal) => boundedText(signal, 160)),
    contextPressure: Number(input.plan.contextPressure.toFixed(3)),
    budget: { maxHints: input.plan.maxHints, maxChars: input.plan.maxChars },
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
  return {
    id: item.memory.id,
    kind: item.memory.kind,
    text: boundedText(item.memory.text, 180),
    score: Number(contextualInjectionScore(item.memory, item.relationStrength).toFixed(3)),
    relationStrength: Number(item.relationStrength.toFixed(3)),
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
      })
      .then((matches) =>
        matches.map((item) => ({
          memory: item,
          relationStrength: 0.95,
          retrievalReasons: ['anchor:path-match'],
        })),
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
      item.relationStrength >= 0.7 &&
      item.retrievalReasons.some(
        (reason) => reason === 'anchor:path-match' || reason.startsWith('query:exact-'),
      ),
  );
  if (memory.findRelatedSage && graphSeeds.length > 0) {
    const related = await memory.findRelatedSage(
      graphSeeds.map((item) => item.memory.id),
      {
        limit: candidateLimit,
        maxDepth: 3,
        includeStatuses: isMutationTrigger(trigger.trigger) ? ['active', 'stale'] : ['active'],
        includeAudienceScoped: false,
      },
    );
    for (const item of related) {
      const relevance = memoryStructuralRelevance(
        item,
        graphSeeds.map((seed) => seed.memory),
      );
      if (!byId.has(item.id) && relevance.strength >= MIN_RELATION_STRENGTH) {
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

function applyCooldown(
  memories: Sage[],
  seen: Map<string, number>,
  cooldownMs: number,
  sessionId?: string,
): Sage[] {
  const now = Date.now();
  return memories.filter((memory) => {
    const last = seen.get(cooldownKey(memory.id, sessionId));
    if (!last) return true;
    return now - last >= cooldownMs;
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
  const oldestUseful = now - Math.max(cooldownMs, 60 * 60_000);
  for (const [key, at] of seen) {
    if (at < oldestUseful) seen.delete(key);
  }
}

function scoreForInjection(memory: Sage): number {
  return memory.importance * 3 + memory.confidence * 2 + memory.freshness;
}

function normalizedInjectionScore(memory: Sage): number {
  return scoreForInjection(memory) / 6;
}

function contextualInjectionScore(memory: Sage, relationStrength: number): number {
  const metadata = normalizedInjectionScore(memory);
  const persistence = memory.persistence ?? DEFAULT_PERSISTENCE;
  const persistenceBoost =
    persistence === 'permanent' ? 0.08 : persistence === 'long_lived' ? 0.04 : -0.08;
  const durableKindBoost = durableMemoryKind(memory.kind) ? 0.04 : 0;
  const injections = memory.injectionCount ?? 0;
  const unusedPenalty =
    injections >= 3 && (memory.useCount ?? 0) === 0 ? Math.min(0.16, 0.04 + injections * 0.01) : 0;
  return Math.max(
    0,
    Math.min(
      1,
      metadata * 0.52 +
        relationStrength * 0.48 +
        persistenceBoost +
        durableKindBoost -
        unusedPenalty,
    ),
  );
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
    kind === 'command_note'
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
        queryText: stringValues(input.path).join(' '),
      };
    case 'tree':
      return {
        trigger: 'tree',
        paths: stringValues(input.path ?? '.'),
        queryText: stringValues(input.path ?? '.').join(' '),
      };
    case 'grep':
      return {
        trigger: 'grep',
        paths: stringValues(input.path ?? '.'),
        queryText: [input.pattern, input.glob, input.path].filter(isString).join(' '),
      };
    case 'glob':
      return {
        trigger: 'glob',
        paths: stringValues(input.path ?? '.'),
        queryText: [input.pattern, input.glob, input.path].filter(isString).join(' '),
      };
    case 'codebase_search':
    case 'codebase-search':
      return {
        trigger: 'codebase_search',
        paths: stringValues(input.path),
        queryText: [input.query, input.q, input.path].filter(isString).join(' '),
      };
    case 'bash':
    case 'exec':
      return {
        trigger: 'bash',
        paths: [],
        queryText: stringValues(input.command ?? input.cmd).join(' '),
      };
    case 'write':
      return {
        trigger: 'write',
        paths: stringValues(input.path),
        queryText: stringValues(input.path).join(' '),
      };
    case 'edit':
      return {
        trigger: 'edit',
        paths: stringValues(input.path),
        queryText: stringValues(input.path).join(' '),
      };
    case 'replace': {
      const files = stringValues(input.files).flatMap(splitFileList);
      return {
        trigger: 'edit',
        paths: files,
        queryText: [...files, ...stringValues(input.pattern), ...stringValues(input.glob)].join(
          ' ',
        ),
      };
    }
    case 'patch':
      return {
        trigger: 'patch',
        paths: extractPatchPaths(input),
        queryText: [input.directory, ...extractPatchPaths(input)].filter(isString).join(' '),
      };
    default:
      return undefined;
  }
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
    const hasPath = reasons.some((reason) => reason.startsWith('anchor:path-match'));
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
    const hasPath = reasons.some((reason) => reason.startsWith('anchor:path-match'));
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
  durableMemoryKind,
  isMutationTrigger,
  didMutate,
  extractTrigger,
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
