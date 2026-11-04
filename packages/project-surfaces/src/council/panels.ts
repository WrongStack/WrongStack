/**
 * Brain council panels, folded from `brain.council_vote` / `brain.council_resolved`.
 *
 * Seat votes arrive BEFORE the resolution (both are emitted from inside
 * `council.decide()`), so a panel is assembled incrementally: it appears as
 * soon as its first seat votes and flips to `resolved` when the tally lands.
 * A council that throws mid-flight never resolves, hence the ring buffer.
 *
 * The question text is NOT on either council event; it lives on the
 * `brain.decision_*` events for the same request id. `noteCouncilQuestion` folds
 * it in whenever it becomes known, in either order. These are pure functions so the
 * WebUI store and the desktop reducer fold the same frames the same way.
 */
import type { CouncilDecisionData, CouncilSeatVote } from './types';

export interface CouncilPanelEntry {
  requestId: string;
  /** `voting` until the resolution lands; a failed council can stay here. */
  phase: 'voting' | 'resolved';
  startedAt: number;
  resolvedAt?: number | undefined;
  seats: CouncilSeatVote[];
  /** Final ballots supersede the live stream, including later failed rounds. */
  hasFinalVotes?: boolean | undefined;
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
  judgeLabel?: string | undefined;
  /** The tie-breaker had already cast one of the votes it is breaking. */
  judgeIsVoter?: boolean | undefined;
  /** Deliberation rounds run (1 = none) and seats that moved in the last one. */
  rounds?: number | undefined;
  deliberationChanges?: number | undefined;
  totalTokens?: number | undefined;
  durationMs?: number | undefined;
  /** Structural warnings — most importantly a CORRELATED (non-diverse) panel. */
  warnings?: string[] | undefined;
}

/** Newest-first ring buffer bound. */
export const MAX_COUNCIL_PANELS = 50;

/** Panels newest first, plus questions seen before their panel's first ballot. */
export interface CouncilLog {
  panels: CouncilPanelEntry[];
  questions: Map<string, string>;
}

export const EMPTY_COUNCIL_LOG: CouncilLog = { panels: [], questions: new Map() };

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
    round: num(payload.round),
    changed: bool(payload.changed),
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
    // Name the round while voting: a deliberating panel re-polls every seat,
    // so the seat count resets and would otherwise look like it went backwards.
    const round = entry.seats.reduce((max, seat) => Math.max(max, seat.round ?? 1), 1);
    const count = entry.seats.filter((seat) => (seat.round ?? 1) === round).length;
    return (
      `voting${round > 1 ? ` r${round}` : ''} · ` + `${count} seat${count === 1 ? '' : 's'} in`
    );
  }
  const seatCount = entry.configuredSeatCount ?? entry.seats.length;
  const parts = [
    entry.resolution ?? entry.status ?? 'resolved',
    `${entry.validVoteCount ?? entry.seats.length}/${seatCount} seats`,
    `${entry.distinctTargetCount ?? 0} distinct target${entry.distinctTargetCount === 1 ? '' : 's'}`,
  ];
  // Deliberation multiplies the panel's cost, and the change count is what
  // says whether the extra rounds bought anything at all.
  if (entry.rounds !== undefined && entry.rounds > 1) {
    const changed = entry.deliberationChanges ?? 0;
    parts.push(`${entry.rounds} rounds${changed > 0 ? `, ${changed} changed` : ', none changed'}`);
  }
  if (entry.judgeUsed) {
    parts.push(
      `judge${entry.judgeLabel ? ` ${entry.judgeLabel}` : ''}` +
        (entry.judgeIsVoter ? ' (also a voter)' : ''),
    );
  }
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
    entry.judgeIsVoter === true ||
    (entry.warnings?.length ?? 0) > 0
  );
}

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
    const updated = apply(existing);
    if (updated === existing) return panels;
    const next = [...panels];
    next[index] = updated;
    return next;
  }
  const created = apply({ requestId, phase: 'voting', startedAt: now, seats: [] });
  return [created, ...panels].slice(0, MAX_COUNCIL_PANELS);
}

/** Fold one `brain.council_vote` ballot into its panel. */
export function applyCouncilVote(state: CouncilLog, payload: Record<string, unknown>): CouncilLog {
  const requestId = str(payload.requestId);
  if (!requestId) return state;
  const eventAt = num(payload.at);
  const now = eventAt ?? Date.now();
  return {
    ...state,
    panels: upsertPanel(state.panels, requestId, now, (entry) => {
      const seatId = str(payload.seatId) ?? 'seat';
      const vote = toCouncilSeatVote(payload, now);
      const previous = entry.seats.find((seat) => seat.seatId === seatId);
      const question = entry.question ?? state.questions.get(requestId);
      // Timestamped frames identify a fresh run even when it reuses seats.
      // Retain the legacy new-seat heuristic only for untimestamped hosts.
      if (
        entry.phase === 'resolved' &&
        (eventAt !== undefined ? eventAt > (entry.resolvedAt ?? entry.startedAt) : !previous)
      ) {
        return { requestId, phase: 'voting', startedAt: now, seats: [vote], question };
      }
      if (entry.phase === 'resolved' && entry.hasFinalVotes) return entry;
      if (previous) {
        if (
          (vote.round ?? 1) < (previous.round ?? 1) ||
          ((vote.round ?? 1) === (previous.round ?? 1) && vote.at < previous.at)
        )
          return entry;
        return {
          ...entry,
          question,
          seats: entry.seats.map((seat) => (seat.seatId === seatId ? vote : seat)),
        };
      }
      return { ...entry, question, seats: [...entry.seats, vote] };
    }),
  };
}

/** Fold a `brain.council_resolved` tally into its panel. */
export function applyCouncilResolution(
  state: CouncilLog,
  payload: Record<string, unknown>,
): CouncilLog {
  const requestId = str(payload.requestId);
  if (!requestId) return state;
  const eventAt = num(payload.at);
  const now = eventAt ?? Date.now();
  const usage = payload.usage as { totalTokens?: number; durationMs?: number } | undefined;
  return {
    ...state,
    panels: upsertPanel(state.panels, requestId, now, (entry) => {
      if (
        eventAt !== undefined &&
        (eventAt < entry.startedAt ||
          (entry.resolvedAt !== undefined && eventAt <= entry.resolvedAt))
      )
        return entry;
      return {
        ...entry,
        question: entry.question ?? state.questions.get(requestId),
        phase: 'resolved',
        hasFinalVotes: Array.isArray(payload.votes),
        seats: Array.isArray(payload.votes)
          ? payload.votes
              .filter((vote) => vote && typeof vote === 'object' && !Array.isArray(vote))
              .map((vote) => toCouncilSeatVote(vote, now))
          : entry.seats,
        resolvedAt: num(payload.at) ?? now,
        status: str(payload.status),
        resolution: str(payload.resolution),
        optionId: str(payload.optionId),
        reason: str(payload.reason),
        configuredSeatCount: num(payload.configuredSeatCount),
        validVoteCount: num(payload.validVoteCount),
        distinctTargetCount: num(payload.distinctTargetCount),
        judgeUsed: bool(payload.judgeUsed),
        judgeLabel: str(payload.judgeLabel),
        judgeIsVoter: bool(payload.judgeIsVoter),
        rounds: num(payload.rounds),
        deliberationChanges: num(payload.deliberationChanges),
        totalTokens: num(usage?.totalTokens),
        durationMs: num(usage?.durationMs),
        warnings: Array.isArray(payload.warnings)
          ? payload.warnings.filter((w): w is string => typeof w === 'string')
          : undefined,
      };
    }),
  };
}

/** Note a request's question, from a `brain.decision_*` event, on its panel or for later. */
export function noteCouncilQuestion(
  state: CouncilLog,
  requestId: string,
  question: string,
): CouncilLog {
  const text = question.trim();
  if (!requestId || !text) return state;
  const index = state.panels.findIndex((panel) => panel.requestId === requestId);
  if (index < 0) {
    if (state.questions.get(requestId) === text) return state;
    const questions = new Map(state.questions);
    questions.delete(requestId);
    questions.set(requestId, text);
    while (questions.size > MAX_COUNCIL_PANELS) questions.delete(questions.keys().next().value!);
    return { ...state, questions };
  }
  const existing = state.panels[index] as CouncilPanelEntry;
  if (existing.question === text) return state;
  const next = [...state.panels];
  next[index] = { ...existing, question: text };
  return { ...state, panels: next };
}

/**
 * The card's data for a resolved panel. The resolution frame wins where it has a value;
 * the panel fills the rest (seats, question, judge, deliberation).
 */
export function councilDecisionData(
  panel: CouncilPanelEntry | undefined,
  payload: Record<string, unknown>,
): CouncilDecisionData {
  const seats = panel?.seats ?? [];
  const usage = payload.usage as { totalTokens?: unknown; durationMs?: unknown } | undefined;
  const request = payload.request as { question?: unknown } | undefined;
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((w): w is string => typeof w === 'string')
    : undefined;
  return {
    requestId: str(payload.requestId) ?? panel?.requestId ?? 'unknown',
    phase: panel?.phase,
    startedAt: panel?.startedAt,
    resolvedAt: panel?.resolvedAt,
    status: str(payload.status) ?? panel?.status ?? 'decided',
    resolution: str(payload.resolution) ?? panel?.resolution ?? 'decided',
    optionId: str(payload.optionId) ?? panel?.optionId,
    question: panel?.question ?? str(request?.question),
    reason: str(payload.reason) ?? panel?.reason,
    configuredSeatCount:
      num(payload.configuredSeatCount) ?? panel?.configuredSeatCount ?? seats.length,
    validVoteCount: num(payload.validVoteCount) ?? panel?.validVoteCount ?? seats.length,
    distinctTargetCount:
      num(payload.distinctTargetCount) ??
      panel?.distinctTargetCount ??
      new Set(seats.map((seat) => seat.model || seat.persona)).size,
    judgeUsed: Boolean(bool(payload.judgeUsed) ?? panel?.judgeUsed),
    judgeModel: panel?.judgeLabel,
    judgeIsVoter: panel?.judgeIsVoter,
    rounds: panel?.rounds,
    deliberationChanges: panel?.deliberationChanges,
    totalTokens: num(usage?.totalTokens) ?? panel?.totalTokens,
    durationMs: num(usage?.durationMs) ?? panel?.durationMs,
    warnings: warnings ?? panel?.warnings,
    seats,
  };
}

/**
 * The markdown a council decision leaves in the transcript: a headline, one line per seat
 * and the warnings. `distinctTargetCount` sits next to the seat count on purpose: a panel
 * whose seats resolved to the SAME model looks like a normal unanimous verdict while adding
 * cost without adding independence.
 */
export function councilDecisionText(decision: CouncilDecisionData): string {
  const seats = decision.seats;
  const headline = [
    `⚖️ **Council ${decision.resolution ?? 'resolved'}**`,
    `${decision.validVoteCount ?? seats.length}/${decision.configuredSeatCount ?? seats.length} seats`,
    `${decision.distinctTargetCount ?? 0} distinct target${decision.distinctTargetCount === 1 ? '' : 's'}`,
    decision.judgeUsed ? 'judge used' : undefined,
    decision.totalTokens ? `${decision.totalTokens} tok` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const seatLines = seats.map(
    (seat) =>
      `- **${seat.persona}**${seat.veto ? ' (veto)' : ''} → ${seat.status === 'valid' ? (seat.optionId ?? 'stance') : seat.status}${seat.model ? ` · \`${seat.model}\`` : ''}`,
  );
  return [headline, ...seatLines, ...(decision.warnings ?? []).map((w) => `> ⚠ ${w}`)]
    .filter(Boolean)
    .join('\n');
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
