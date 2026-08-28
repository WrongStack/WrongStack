import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';
import type { EventBus } from '@wrongstack/core/kernel';
import { normalizeTextKey } from '../store-helpers.js';
import type { Sage } from '../types.js';
import { DEFAULT_PERSISTENCE } from '../types.js';
import type { MemoryInjectorAgent } from './memory-injector-agent.js';
import {
  computeInjectionProof,
  type InjectionScoreTerm,
  type RejectedDetailEntry,
} from './tool-call-memory-scoring.js';
import type { ExtractedTriggerContext } from './tool-call-memory-triggers.js';

export interface RetrievedMemory {
  memory: Sage;
  relationStrength: number;
  retrievalReasons: string[];
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

export function storeProviderMemoryEvidence(
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

export function visibleContextText(payload: ToolCallPipelinePayload): string {
  const prompt = (payload.ctx as unknown as { systemPrompt?: Array<{ text?: string }> })
    .systemPrompt;
  return [payload.result.content, ...(prompt ?? []).map((block) => block.text ?? '')]
    .join('\n')
    .toLowerCase();
}

export function dedupeRetrievedByText(memories: RetrievedMemory[]): RetrievedMemory[] {
  const seen = new Set<string>();
  return memories.filter(({ memory }) => {
    const key = normalizeTextKey(memory.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function selectDiverseMemories(
  memories: Sage[],
  limit: number,
  reasonsById: Map<string, string[]> = new Map(),
): { selected: Sage[]; dropped: ReadonlyArray<{ memory: Sage; reason: string }> } {
  const dropped: { memory: Sage; reason: string }[] = [];
  if (limit <= 0) {
    for (const memory of memories) {
      dropped.push({ memory, reason: `diversity cap is 0 (limit=${limit})` });
    }
    return { selected: [], dropped };
  }
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
    if (!hasPath && hasGraph && graphOnly >= 1) {
      dropped.push({ memory, reason: `graph-only diversity cap (1) for kind=${memory.kind}` });
      continue;
    }
    if (!hasPath && !hasGraph && hasQuery && queryOnly >= 2) {
      dropped.push({ memory, reason: `query-only diversity cap (2) for kind=${memory.kind}` });
      continue;
    }
    const count = byKind.get(memory.kind) ?? 0;
    if (count >= 3) {
      deferred.push(memory);
      continue;
    }
    selected.push(memory);
    if (!hasPath && hasGraph) graphOnly++;
    else if (!hasPath && hasQuery) queryOnly++;
    byKind.set(memory.kind, count + 1);
    if (selected.length >= limit) {
      for (let i = memories.indexOf(memory) + 1; i < memories.length; i++) {
        const rest = memories[i]!;
        dropped.push({ memory: rest, reason: `limit=${limit} reached before kind-diversity` });
      }
      for (const pending of deferred) {
        dropped.push({
          memory: pending,
          reason: `limit=${limit} reached before kind-diversity (deferred drain)`,
        });
      }
      return { selected, dropped };
    }
  }
  for (const memory of deferred) {
    if (selected.length >= limit) {
      dropped.push({ memory, reason: `deferred list exhausted; limit=${limit}` });
      continue;
    }
    const reasons = reasonsById.get(memory.id) ?? [];
    const hasPath = reasons.some((reason) => reason.startsWith('anchor:'));
    const hasGraph = reasons.some((reason) => reason.startsWith('graph:'));
    const hasQuery = reasons.some((reason) => reason.startsWith('query:'));
    if (!hasPath && hasGraph && graphOnly >= 1) {
      dropped.push({ memory, reason: `graph-only diversity cap (1) for kind=${memory.kind}` });
      continue;
    }
    if (!hasPath && !hasGraph && hasQuery && queryOnly >= 2) {
      dropped.push({ memory, reason: `query-only diversity cap (2) for kind=${memory.kind}` });
      continue;
    }
    selected.push(memory);
    if (!hasPath && hasGraph) graphOnly++;
    else if (!hasPath && hasQuery) queryOnly++;
  }
  return { selected, dropped };
}

export function availableHintChars(payload: ToolCallPipelinePayload, configured: number): number {
  const wanted = Math.max(0, Math.floor(configured));
  const cap = payload.tool?.maxOutputBytes;
  if (!cap) return wanted;
  const remainingBytes = cap - Buffer.byteLength(payload.result.content, 'utf8') - 2;
  return Math.max(0, Math.min(wanted, Math.floor(remainingBytes / 3)));
}
