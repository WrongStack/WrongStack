import type { EventBus } from '@wrongstack/core/kernel';
import type { Sage } from '../types.js';
import { DEFAULT_PERSISTENCE } from '../types.js';

export interface InjectionScoreTerm {
  label: string;
  value: number;
}

interface InjectionProof {
  score: number;
  metadataScore: number;
  relationStrength: number;
  terms: InjectionScoreTerm[];
}

export interface RejectedDetailEntry {
  id: string;
  kind: string;
  gate: 'duplicate' | 'belowScore' | 'alreadyVisible' | 'cooldown' | 'budget';
  reason: string;
  relationStrength?: number;
  score?: number;
  at: string;
}

export const MIN_RELATION_STRENGTH = 0.85;
export const DEFAULT_MIN_SCORE = 0.72;
export const DEFAULT_MIN_IMPORTANCE = 0.5;
const BURST_THRESHOLD = 3;
const BURST_WINDOW_MS = 5 * 60_000;
export const MAX_REJECTED_DETAIL = 20;
export const MIN_CONTAINS_LENGTH = 24;

const burstRejectionHistory = new Map<string, number[]>();
let burstSweepCounter = 0;

export function observeBurstRejections(
  rejectedDetail: RejectedDetailEntry[],
  events: EventBus | undefined,
  now: number,
): void {
  if (!events) return;
  burstSweepCounter++;
  if (burstSweepCounter % 8 === 0) {
    for (const [id, history] of burstRejectionHistory) {
      const freshest = history[history.length - 1];
      if (freshest === undefined || now - freshest > BURST_WINDOW_MS) {
        burstRejectionHistory.delete(id);
      }
    }
  }
  const cutoff = now - BURST_WINDOW_MS;
  const countsByMemory = new Map<string, { count: number; reason: string }>();
  for (const entry of rejectedDetail) {
    if (entry.gate !== 'belowScore') continue;
    const slot = countsByMemory.get(entry.id);
    if (slot) {
      slot.count++;
      slot.reason = entry.reason;
    } else {
      countsByMemory.set(entry.id, { count: 1, reason: entry.reason });
    }
  }
  for (const [memoryId, slot] of countsByMemory) {
    const history = burstRejectionHistory.get(memoryId) ?? [];
    while (history.length > 0 && (history[0] ?? 0) < cutoff) history.shift();
    history.push(now);
    burstRejectionHistory.set(memoryId, history);
    if (history.length > BURST_THRESHOLD * 2) {
      history.splice(0, history.length - BURST_THRESHOLD * 2);
    }
    if (history.length === BURST_THRESHOLD) {
      (events.emit as unknown as (this: EventBus, event: string, payload: unknown) => void).call(
        events,
        'memory.injector_rejection_burst',
        {
          memoryId,
          gate: 'belowScore',
          windowMs: BURST_WINDOW_MS,
          count: history.length,
          reason: slot.reason,
          at: new Date(now).toISOString(),
        },
      );
    }
  }
}

export function scoreForInjection(memory: Sage): number {
  return memory.importance * 3 + memory.confidence * 2 + memory.freshness;
}

export function normalizedInjectionScore(memory: Sage): number {
  return scoreForInjection(memory) / 6;
}

export function computeInjectionProof(memory: Sage, relationStrength: number): InjectionProof {
  const metadataScore = normalizedInjectionScore(memory);
  const persistence = memory.persistence ?? DEFAULT_PERSISTENCE;
  const persistenceBoost =
    persistence === 'permanent' ? 0.08 : persistence === 'long_lived' ? 0.04 : -0.08;
  const durableKindBoost = durableMemoryKind(memory.kind) ? 0.04 : 0;
  const uses = memory.useCount ?? 0;
  const useBoost = uses > 0 ? Math.min(0.14, 0.05 + uses * 0.02) : 0;
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

export function contextualInjectionScore(memory: Sage, relationStrength: number): number {
  return computeInjectionProof(memory, relationStrength).score;
}

export function durableMemoryKind(kind: Sage['kind']): boolean {
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

export function containsMemoryText(haystack: string, memoryText: string): boolean {
  const needle = memoryText.trim().toLowerCase();
  if (needle.length < MIN_CONTAINS_LENGTH) return false;
  return haystack.toLowerCase().includes(needle);
}
