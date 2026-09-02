/**
 * Live log of Brain council panels.
 *
 * The council is the most expensive Brain tier — one provider call PER SEAT,
 * with a ~90s ceiling. `brain.council_vote` / `brain.council_resolved` already
 * reached the browser over `brain.event`, but nothing consumed them, so a slow,
 * costly multi-model decision was indistinguishable from a free policy one.
 *
 * Seat votes arrive BEFORE the resolution (both are emitted from inside
 * `council.decide()`), so a panel is assembled incrementally: it appears as
 * soon as its first seat votes and flips to `resolved` when the tally lands.
 * That ordering is also why a panel can legitimately sit in `voting` forever —
 * a council that throws mid-flight never resolves — hence the ring buffer.
 *
 * The question text is NOT on either council event; it lives on the
 * `brain.decision_*` events for the same request id. `noteQuestion` folds it in
 * whenever it becomes known, in either order.
 */
import { createSessionScopedStore } from './session-scoped-store';
import type { CouncilSeatVote } from './types';

export interface CouncilPanelEntry {
  requestId: string;
  /** `voting` until the resolution lands; a failed council can stay here. */
  phase: 'voting' | 'resolved';
  startedAt: number;
  resolvedAt?: number | undefined;
  seats: CouncilSeatVote[];
  /** Folded in from the matching `brain.decision_*` event, when it arrives. */
  question?: string | undefined;
  status?: string | undefined;
  resolution?: string | undefined;
  optionId?: string | undefined;
  reason?: string | undefined;
  configuredSeatCount?: number | undefined;
  validVoteCount?: number | undefined;
  /** Distinct provider/model targets that served the valid votes. */
  distinctTargetCount?: number | undefined;
  judgeUsed?: boolean | undefined;
  totalTokens?: number | undefined;
  durationMs?: number | undefined;
  /** Structural warnings — most importantly a CORRELATED (non-diverse) panel. */
  warnings?: string[] | undefined;
}

/** Newest-first ring buffer bound. */
export const MAX_COUNCIL_PANELS = 50;

interface CouncilLogState {
  /** Newest first. */
  panels: CouncilPanelEntry[];
  recordVote: (payload: Record<string, unknown>) => void;
  recordResolution: (payload: Record<string, unknown>) => void;
  noteQuestion: (requestId: string, question: string) => void;
  clear: () => void;
}

// ── Pure mappers (exported for tests) ────────────────────────────────────

export function toCouncilSeatVote(payload: Record<string, unknown>, now: number): CouncilSeatVote {
  return {
    seatId: str(payload.seatId) ?? 'seat',
    persona: str(payload.persona) ?? 'voter',
    status: str(payload.status) ?? 'valid',
    optionId: str(payload.optionId),
    stance: str(payload.stance),
    rationale: str(payload.rationale),
    providerId: str(payload.providerId),
    model: str(payload.model),
    veto: bool(payload.veto),
    weight: num(payload.weight),
    durationMs: num(payload.durationMs),
    error: str(payload.error),
    at: num(payload.at) ?? now,
  };
}

/**
 * One-line panel summary.
 *
 * `distinctTargetCount` sits next to the seat count deliberately: a panel whose
 * seats all resolved to the SAME model produces a perfectly normal-looking
 * unanimous verdict while adding cost without adding independence, and nothing
 * else on the row reveals it.
 */
export function summarizeCouncilPanel(entry: CouncilPanelEntry): string {
  if (entry.phase === 'voting') {
    return `voting · ${entry.seats.length} seat${entry.seats.length === 1 ? '' : 's'} in`;
  }
  const seatCount = entry.configuredSeatCount ?? entry.seats.length;
  const parts = [
    entry.resolution ?? entry.status ?? 'resolved',
    `${entry.validVoteCount ?? entry.seats.length}/${seatCount} seats`,
    `${entry.distinctTargetCount ?? 0} distinct target${entry.distinctTargetCount === 1 ? '' : 's'}`,
  ];
  if (entry.judgeUsed) parts.push('judge used');
  if (entry.durationMs !== undefined) {
    parts.push(`${Math.round(entry.durationMs / 100) / 10}s`);
  }
  if (entry.totalTokens) parts.push(`${entry.totalTokens} tok`);
  return parts.join(' · ');
}

/** True when the panel resolved to a refusal, denial or non-verdict. */
export function isCouncilPanelAdverse(entry: CouncilPanelEntry): boolean {
  if (entry.phase !== 'resolved') return false;
  return (
    entry.status === 'denied' ||
    entry.status === 'abstained' ||
    entry.status === 'failed' ||
    entry.status === 'cancelled' ||
    (entry.warnings?.length ?? 0) > 0
  );
}

// ── Store ────────────────────────────────────────────────────────────────

/**
 * Find or create the panel for a request id.
 *
 * Returns a NEW array — zustand subscribers compare by reference, and mutating
 * in place would leave the tab badge and list stale.
 */
function upsertPanel(
  panels: CouncilPanelEntry[],
  requestId: string,
  now: number,
  apply: (entry: CouncilPanelEntry) => CouncilPanelEntry,
): CouncilPanelEntry[] {
  const index = panels.findIndex((panel) => panel.requestId === requestId);
  if (index >= 0) {
    const existing = panels[index] as CouncilPanelEntry;
    const next = [...panels];
    next[index] = apply(existing);
    return next;
  }
  const created = apply({ requestId, phase: 'voting', startedAt: now, seats: [] });
  return [created, ...panels].slice(0, MAX_COUNCIL_PANELS);
}

/**
 * One log per conversation: a council convened for tab 3's decision is tab 3's
 * record, and must not appear in — or be lost because of — tab 1's panel.
 */
export const useCouncilLogStore = createSessionScopedStore<CouncilLogState>((set) => ({
  panels: [],

  recordVote: (payload) => {
    const requestId = str(payload.requestId);
    if (!requestId) return;
    const now = Date.now();
    set((state) => ({
      panels: upsertPanel(state.panels, requestId, now, (entry) => {
        const seatId = str(payload.seatId) ?? 'seat';
        const vote = toCouncilSeatVote(payload, now);
        // A re-delivered vote for a seat the panel already has is a reconnect
        // replay of the SAME run — update the seat in place and keep the
        // resolution fields untouched.
        if (entry.seats.some((seat) => seat.seatId === seatId)) {
          return {
            ...entry,
            seats: entry.seats.map((seat) => (seat.seatId === seatId ? vote : seat)),
          };
        }
        // A vote for a NEW seat on an already-resolved panel means a FRESH run
        // started under the same request id (a retried decision reusing the
        // id): clear the stale verdict and the previous run's seats so the
        // summary panel cannot keep showing the old verdict while the new run
        // votes. The question survives — it is the same decision re-run.
        if (entry.phase === 'resolved') {
          return {
            requestId: entry.requestId,
            phase: 'voting',
            startedAt: now,
            seats: [vote],
            question: entry.question,
          };
        }
        return { ...entry, seats: [...entry.seats, vote] };
      }),
    }));
  },

  recordResolution: (payload) => {
    const requestId = str(payload.requestId);
    if (!requestId) return;
    const now = Date.now();
    const usage = payload.usage as { totalTokens?: number; durationMs?: number } | undefined;
    set((state) => ({
      panels: upsertPanel(state.panels, requestId, now, (entry) => ({
        ...entry,
        phase: 'resolved',
        resolvedAt: num(payload.at) ?? now,
        status: str(payload.status),
        resolution: str(payload.resolution),
        optionId: str(payload.optionId),
        reason: str(payload.reason),
        configuredSeatCount: num(payload.configuredSeatCount),
        validVoteCount: num(payload.validVoteCount),
        distinctTargetCount: num(payload.distinctTargetCount),
        judgeUsed: bool(payload.judgeUsed),
        totalTokens: num(usage?.totalTokens),
        durationMs: num(usage?.durationMs),
        warnings: Array.isArray(payload.warnings)
          ? payload.warnings.filter((w): w is string => typeof w === 'string')
          : undefined,
      })),
    }));
  },

  noteQuestion: (requestId, question) => {
    const text = question.trim();
    if (!requestId || !text) return;
    set((state) => {
      const index = state.panels.findIndex((panel) => panel.requestId === requestId);
      // Only ENRICH an existing panel. Creating one here would spawn an empty
      // row for every policy/LLM-tier decision, which never convenes a council.
      if (index < 0) return state;
      const existing = state.panels[index] as CouncilPanelEntry;
      if (existing.question === text) return state;
      const next = [...state.panels];
      next[index] = { ...existing, question: text };
      return { panels: next };
    });
  },

  clear: () => set({ panels: [] }),
}));

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
