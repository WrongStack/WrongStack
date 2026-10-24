import type { EventBus } from '@wrongstack/contracts/kernel';
import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';
import type { Sage } from '../types.js';
import { DEFAULT_PERSISTENCE } from '../types.js';
import type { MemoryInjectorAgent } from './memory-injector-agent.js';
import type { RetrievedMemory } from './tool-call-memory-retrieval.js';
import {
  computeInjectionProof,
  type InjectionScoreTerm,
  type RejectedDetailEntry,
} from './tool-call-memory-scoring.js';
import type { ExtractedTriggerContext } from './tool-call-memory-triggers.js';

export type { RetrievedMemory } from './tool-call-memory-retrieval.js';

interface InjectorTraceMemory {
  revision?: number | undefined;
  validity?: Sage['validity'];
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
  metadataScore: number;
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
  rejectedDetail: RejectedDetailEntry[];
  rejectedDetailTotal?: number | undefined;
  activated: InjectorTraceMemory[];
  injected: InjectorTraceMemory[];
  injectedChars: number;
  thresholds: { minScore: number; minImportance: number; relationFloor: number };
  error?: string | undefined;
}

interface CooldownPruneState {
  lastPruneAt: number;
}

const MAX_TRACKED_INJECTIONS = 20_000;
const PRUNE_COOLDOWNS_INTERVAL_MS = 60_000;
let injectorTraceSequence = 0;

export function emitInjectorTrace(events: EventBus | undefined, input: InjectorTraceInput): void {
  if (!events) return;
  const sessionId = (input.nextPayload.ctx.session as { id?: string } | undefined)?.id;
  const emit = events.emit as unknown as (event: string, payload: unknown) => void;
  emit.call(events, 'memory.injector_run', {
    runId: `meminj_${Date.now()}_${++injectorTraceSequence}`,
    at: new Date().toISOString(),
    outcome: input.outcome,
    trigger: input.trigger.trigger,
    toolName: input.nextPayload.toolUse.name,
    queryPreview: boundedText(input.plan.queryText, 600),
    paths: input.trigger.paths.slice(0, 8),
    taskSignals: input.plan.taskSignals.slice(0, 6).map((signal) => boundedText(signal, 160)),
    contextPressure: Number(input.plan.contextPressure.toFixed(3)),
    budget: { maxHints: input.plan.maxHints, maxChars: input.plan.maxChars },
    thresholds: input.thresholds,
    candidates: input.candidates,
    eligible: input.eligible,
    rejected: input.rejected,
    rejectedDetail: input.rejectedDetail,
    ...(input.rejectedDetailTotal !== undefined
      ? { rejectedDetailTotal: input.rejectedDetailTotal }
      : {}),
    activated: input.activated,
    injected: input.injected,
    injectedChars: input.injectedChars,
    error: input.error ? boundedText(input.error, 300) : undefined,
    sessionId,
  });
}

export function toTraceMemory(
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
    revision: item.memory.revision,
    validity: item.memory.validity,
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

export function formatTraceAnchor(anchor: Sage['anchors'][number]): string {
  if (anchor.symbol) return `${anchor.type}:${anchor.symbol}`;
  if (anchor.path) return `${anchor.type}:${anchor.path}`;
  if (anchor.command) return `${anchor.type}:${boundedText(anchor.command, 100)}`;
  if (anchor.role) return `${anchor.type}:${anchor.role}`;
  return anchor.type;
}

export function boundedText(value: string, maxChars: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
}

export function applyCooldown(
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

export function cooldownKey(memoryId: string, sessionId?: string): string {
  return `${sessionId ?? '<no-session>'}:${memoryId}`;
}

export function pruneCooldowns(
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
  if (seen.size <= MAX_TRACKED_INJECTIONS) return;
  const ordered = [...seen.entries()].sort((a, b) => a[1] - b[1]);
  for (const [key] of ordered.slice(0, seen.size - MAX_TRACKED_INJECTIONS)) seen.delete(key);
}

/** Evidence source the tool-result injector owns on `Context.memoryEvidence`. */
export const TOOL_MEMORY_EVIDENCE_SOURCE = 'sage.tool-memory';

/**
 * Upper bound of the rolling tool-memory evidence window. Matches the core
 * `setMemoryEvidence` default and stays well under the provider-side memory
 * evidence budget, so the turn-context block always fits beside it.
 */
export const TOOL_MEMORY_EVIDENCE_WINDOW_CHARS = 6_000;

/**
 * A rendered memory line, anchored at the start so a path or tag in the
 * `(anchor) [tags=…]` trailer — neither is fence-escaped — can never be
 * mistaken for a line's id.
 */
const MEMORY_LINE_ID = /^- \[[^\]]+\](?:\[[^\]]+\])* <memory id="([^"]+)">/;

interface MemoryEvidenceHost {
  memoryEvidence?: Array<{ source: string; text: string }>;
  setMemoryEvidence?: (source: string, text: string, maxChars?: number) => void;
}

/** Current tool-memory evidence text on `ctx`, or `''`. */
export function readToolMemoryEvidence(ctx: ToolCallPipelinePayload['ctx']): string {
  const entries = (ctx as ToolCallPipelinePayload['ctx'] & MemoryEvidenceHost).memoryEvidence;
  if (!Array.isArray(entries)) return '';
  return entries.find((entry) => entry?.source === TOOL_MEMORY_EVIDENCE_SOURCE)?.text ?? '';
}

/** Memory ids whose rendered line is present in an evidence block. */
export function memoryIdsInEvidence(text: string): Set<string> {
  const ids = new Set<string>();
  if (!text) return ids;
  for (const line of text.split('\n')) {
    const id = MEMORY_LINE_ID.exec(line)?.[1];
    if (id) ids.add(id);
  }
  return ids;
}

export interface MergedMemoryEvidence {
  /** Evidence text now stored for the provider. */
  text: string;
  /** Every memory id present in `text`, newest first. */
  memoryIds: string[];
  /** Previously present ids pushed out of the window by this merge. */
  evictedIds: string[];
}

/**
 * Merge a freshly rendered memory block into the existing evidence window.
 *
 * `Context.setMemoryEvidence` REPLACES the entry for a source. The injector
 * runs once per tool call and tool calls in one assistant step execute
 * back-to-back before the next provider request, so a plain replace kept only
 * the LAST call's memories: every earlier call's memories were marked seen,
 * counted as injected and handed to the usefulness tracker, then silently
 * overwritten before the model ever saw them. With the default once-per-session
 * cooldown they were also never offered again.
 *
 * The incoming lines are always kept (they were just budgeted by the caller).
 * Carried lines follow newest-first and stop at the first one that does not
 * fit, so the window rolls oldest-out and never slices a line.
 */
export function mergeMemoryEvidence(
  previous: string,
  rendered: string,
  maxChars: number,
): MergedMemoryEvidence {
  const renderedLines = rendered.split('\n');
  const header = renderedLines[0] ?? '';
  const incoming: Array<{ id: string; line: string }> = [];
  for (const line of renderedLines.slice(1)) {
    const id = MEMORY_LINE_ID.exec(line)?.[1];
    if (id) incoming.push({ id, line });
  }
  const incomingIds = new Set(incoming.map((entry) => entry.id));
  const lines = [header];
  const memoryIds: string[] = [];
  let used = header.length;
  for (const entry of incoming) {
    lines.push(entry.line);
    memoryIds.push(entry.id);
    used += 1 + entry.line.length;
  }
  const evictedIds: string[] = [];
  let full = false;
  for (const line of previous ? previous.split('\n') : []) {
    const id = MEMORY_LINE_ID.exec(line)?.[1];
    if (!id || incomingIds.has(id)) continue;
    if (full || used + 1 + line.length > maxChars) {
      full = true;
      evictedIds.push(id);
      continue;
    }
    lines.push(line);
    memoryIds.push(id);
    used += 1 + line.length;
  }
  return { text: lines.join('\n'), memoryIds, evictedIds };
}

/**
 * Store a rendered block as provider memory evidence, merged into the rolling
 * window (see {@link mergeMemoryEvidence}).
 */
export function storeProviderMemoryEvidence(
  ctx: ToolCallPipelinePayload['ctx'],
  text: string,
  maxChars: number,
): MergedMemoryEvidence {
  const window = Math.max(0, Math.floor(maxChars));
  const merged = mergeMemoryEvidence(readToolMemoryEvidence(ctx), text, window);
  replaceProviderMemoryEvidence(ctx, merged.text, window);
  return merged;
}

/** Replace the window after refreshing it; removed rows must not be merged back. */
export function replaceProviderMemoryEvidence(
  ctx: ToolCallPipelinePayload['ctx'],
  text: string,
  maxChars: number,
): void {
  const host = ctx as ToolCallPipelinePayload['ctx'] & MemoryEvidenceHost;
  // The merge already fits the window; never let the store's own cap slice a
  // memory line (incoming lines are kept even when they alone exceed it).
  const storeCap = Math.max(maxChars, text.length);
  if (typeof host.setMemoryEvidence === 'function') {
    host.setMemoryEvidence(TOOL_MEMORY_EVIDENCE_SOURCE, text, storeCap);
    return;
  }
  const retained = (host.memoryEvidence ?? []).filter(
    (entry) => entry.source !== TOOL_MEMORY_EVIDENCE_SOURCE,
  );
  if (text) retained.push({ source: TOOL_MEMORY_EVIDENCE_SOURCE, text });
  host.memoryEvidence = retained.slice(-8);
}

/**
 * Release the cooldown of every memory this injector placed in the evidence
 * window that is no longer there.
 *
 * Evidence never enters chat or tool history, so a memory missing from the
 * window is missing from the model's context: `/clear`, a topic shift, a
 * project switch or window eviction removed it. The once-per-session cooldown
 * exists to stop re-sending what the model can already see — holding it after
 * the memory has left context would bar that memory from the rest of the
 * session.
 */
export function releaseDepartedCooldowns(
  seen: Map<string, number>,
  placed: Map<string, Set<string>>,
  sessionId: string | undefined,
  present: ReadonlySet<string>,
): string[] {
  const ids = placed.get(sessionId ?? '<no-session>');
  if (!ids) return [];
  const released: string[] = [];
  for (const id of ids) {
    if (present.has(id)) continue;
    ids.delete(id);
    seen.delete(cooldownKey(id, sessionId));
    released.push(id);
  }
  return released;
}

export function visibleContextText(payload: ToolCallPipelinePayload): string {
  const prompt = (payload.ctx as unknown as { systemPrompt?: Array<{ text?: string }> })
    .systemPrompt;
  return [payload.result.content, ...(prompt ?? []).map((block) => block.text ?? '')]
    .join('\n')
    .toLowerCase();
}
