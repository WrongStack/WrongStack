import type { BrainDecision } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import { useEffect } from 'react';
import type { Action, State } from '../app-reducer.js';
import type { HistoryEntry } from '../components/history.js';

const MONITOR_INTERVENTION_GRACE_MS = 5_000;

/**
 * Brain decision events → chat history / status bar.
 */
export function useBrainEvents(
  events: EventBus,
  dispatch: React.Dispatch<Action>,
  getSessionId?: (() => string | undefined) | undefined,
): void {
  useEffect(() => {
    // Permissive predicate: events without a sessionId OR with no
    // current session always apply. Distinct from
    // `sidebar-content.tsx`'s exported `isCurrentSession`, which is
    // strict on the rowId argument (returns false when rowId is
    // undefined; falls back to fallbackIsCurrent only when rowId is
    // defined). See commit 295bd53fa.
    const isCurrentSession = (sessionId?: string | undefined): boolean => {
      const current = getSessionId?.();
      return !sessionId || !current || sessionId === current;
    };
    const requestSummary = (request: { source: string; question: string }) =>
      `${request.source}: ${request.question}`.slice(0, 80);
    const decisionSummary = (decision: BrainDecision): string => {
      switch (decision.type) {
        case 'answer':
          return decision.optionId ?? decision.text;
        case 'ask_human':
          return decision.prompt;
        case 'deny':
          return decision.reason;
      }
    };

    // ── Council trace ─────────────────────────────────────────────────
    // Seat votes and the resolution are emitted from inside `council.decide()`,
    // so they always land BEFORE the decision_* event for the same request.
    // Buffer them here and attach the panel summary to the entry that decision
    // produces — a council verdict then shows WHO voted and whether the panel
    // was actually diverse, instead of looking like any other one-line answer.
    const councilTraces = new Map<
      string,
      NonNullable<Extract<HistoryEntry, { kind: 'brain' }>['council']>
    >();
    const councilVotes = new Map<
      string,
      NonNullable<Extract<HistoryEntry, { kind: 'brain' }>['council']>['seats']
    >();
    // The maps are keyed by request id and only drained when that request
    // reaches a decision. A council that fails before resolving, or a request
    // whose decision event never arrives, would otherwise leak one entry per
    // decision for the lifetime of the session.
    const COUNCIL_TRACE_MAX = 100;
    const capCouncilMap = (map: Map<string, unknown>): void => {
      while (map.size > COUNCIL_TRACE_MAX) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    };

    /**
     * @param history false for the escalation PROMPT: a human is being asked
     *   and the same request will resolve into answered/denied. Writing a row
     *   for both turns one decision into two history entries — and, worse,
     *   drains the buffered council panel onto the prompt row so the entry
     *   carrying the actual verdict shows no panel at all.
     */
    const addBrainEntry = (
      status: Exclude<Extract<HistoryEntry, { kind: 'brain' }>['status'], 'thinking'>,
      payload: unknown,
      { history = true }: { history?: boolean } = {},
    ) => {
      const p = payload as {
        request: {
          id: string;
          source: string;
          risk: Extract<HistoryEntry, { kind: 'brain' }>['risk'];
          question: string;
          context?: string | undefined;
          options?: NonNullable<State['brainPrompt']>['options'] | undefined;
        };
        decision: BrainDecision;
        tier?: string | undefined;
      };
      const council = history ? councilTraces.get(p.request.id) : undefined;
      if (history) {
        councilTraces.delete(p.request.id);
        councilVotes.delete(p.request.id);
      }
      const decision = decisionSummary(p.decision);
      dispatch({
        type: 'brainStatus',
        state: status,
        source: p.request.source,
        risk: p.request.risk,
        summary: decision,
      });
      if (status === 'ask_human') {
        const prompt: NonNullable<State['brainPrompt']> = {
          requestId: p.request.id,
          source: p.request.source,
          risk: p.request.risk,
          question: p.request.question,
        };
        if (p.request.context !== undefined) prompt.context = p.request.context;
        if (p.request.options !== undefined) prompt.options = p.request.options;
        dispatch({ type: 'brainPromptSet', prompt });
      } else {
        dispatch({ type: 'brainPromptClear' });
      }
      if (!history) return;
      const rationale = p.decision.type === 'deny' ? undefined : p.decision.rationale;
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'brain',
          status,
          source: p.request.source,
          risk: p.request.risk,
          question: p.request.question,
          decision,
          rationale,
          ...(p.tier ? { tier: p.tier } : {}),
          ...(council ? { council } : {}),
        },
      });
    };

    const pendingMonitorAnswers = new Map<string, ReturnType<typeof setTimeout>>();
    // Dedup set for already-surfaced monitor answers. FIFO-capped: an id is only
    // consulted to suppress the immediate follow-up intervention, so old ids are
    // dead weight — without a cap this grows one entry per intervention forever.
    const SHOWN_MONITOR_ANSWERS_MAX = 500;
    const shownMonitorAnswers = new Set<string>();
    const rememberShownAnswer = (id: string): void => {
      shownMonitorAnswers.add(id);
      if (shownMonitorAnswers.size > SHOWN_MONITOR_ANSWERS_MAX) {
        const oldest = shownMonitorAnswers.values().next().value;
        if (oldest !== undefined) shownMonitorAnswers.delete(oldest);
      }
    };
    const offRequested = events.on('brain.decision_requested', ({ sessionId, request }) => {
      if (!isCurrentSession(sessionId)) return;
      dispatch({
        type: 'brainStatus',
        state: 'deciding',
        source: request.source,
        risk: request.risk,
        summary: requestSummary(request),
      });
    });
    const offAnswered = events.on('brain.decision_answered', (payload) => {
      if (!isCurrentSession(payload.sessionId)) return;
      if (!payload.request.id.startsWith('brainmon-')) {
        addBrainEntry('answered', payload);
        return;
      }
      // The monitor normally follows with a richer intervention event after
      // steer delivery. Do not hide the decision forever if delivery stalls.
      const previous = pendingMonitorAnswers.get(payload.request.id);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        pendingMonitorAnswers.delete(payload.request.id);
        if (isCurrentSession(payload.sessionId)) {
          rememberShownAnswer(payload.request.id);
          addBrainEntry('answered', payload);
        }
      }, MONITOR_INTERVENTION_GRACE_MS);
      timer.unref?.();
      pendingMonitorAnswers.set(payload.request.id, timer);
    });
    const offAskHuman = events.on('brain.decision_ask_human', (payload) => {
      if (!isCurrentSession(payload.sessionId)) return;
      // A pending event is the prompt: it must raise the prompt UI and the
      // status line, but the history row belongs to whatever the human (or
      // the timeout) actually decides.
      addBrainEntry('ask_human', payload, { history: payload.pending !== true });
    });
    const offDenied = events.on('brain.decision_denied', (payload) => {
      if (isCurrentSession(payload.sessionId)) addBrainEntry('denied', payload);
    });
    // ── Council tier ─────────────────────────────────────────────────
    // A council decision costs one provider call PER SEAT and can run for
    // ~90s. Reporting seats as they land is what makes that wait legible
    // rather than a silent stall behind a generic "deciding" status.
    const offCouncilVote = events.on('brain.council_vote', (payload) => {
      if (!isCurrentSession(payload.sessionId)) return;
      const seats = councilVotes.get(payload.requestId) ?? [];
      const ballot = {
        seatId: payload.seatId,
        persona: payload.persona,
        status: payload.status,
        optionId: payload.optionId,
        stance: payload.stance,
        model: payload.model,
        veto: payload.veto,
        durationMs: payload.durationMs,
        error: payload.error,
        round: payload.round,
        changed: payload.changed,
      };
      // Upsert by seat, never append. A deliberating panel emits one ballot
      // per seat PER ROUND, so appending listed every seat twice — with
      // duplicate React keys — and only the final round is the verdict
      // anyway. A reconnect replay of the same seat lands here too.
      const existing = seats.findIndex((seat) => seat.seatId === ballot.seatId);
      if (existing >= 0) seats[existing] = ballot;
      else seats.push(ballot);
      councilVotes.set(payload.requestId, seats);
      capCouncilMap(councilVotes);
      const round = payload.round ?? 1;
      dispatch({
        type: 'brainStatus',
        state: 'deciding',
        source: 'council',
        risk: 'high',
        // Naming the round is what keeps a 2-round panel from looking like a
        // stalled 1-round one: the seat count resets and would otherwise
        // appear to count backwards.
        summary:
          `council${round > 1 ? ` r${round}` : ''} · ` +
          `${seats.length} seat${seats.length === 1 ? '' : 's'} voted`,
      });
    });
    const offCouncilResolved = events.on('brain.council_resolved', (payload) => {
      if (!isCurrentSession(payload.sessionId)) return;
      councilTraces.set(payload.requestId, {
        resolution: payload.resolution,
        configuredSeatCount: payload.configuredSeatCount,
        validVoteCount: payload.validVoteCount,
        distinctTargetCount: payload.distinctTargetCount,
        judgeUsed: payload.judgeUsed,
        judgeLabel: payload.judgeLabel,
        judgeIsVoter: payload.judgeIsVoter,
        rounds: payload.rounds,
        deliberationChanges: payload.deliberationChanges,
        totalTokens: payload.usage?.totalTokens,
        durationMs: payload.usage?.durationMs,
        ...(payload.warnings?.length ? { warnings: [...payload.warnings] } : {}),
        seats: councilVotes.get(payload.requestId) ?? [],
      });
      capCouncilMap(councilTraces);
      councilVotes.delete(payload.requestId);
    });

    // Self-activation: the BrainMonitor engaged on a distress signal
    // (tool-failure streak / error storm). Show whether it steered the
    // agent or just observed — the steer itself arrives as mailbox mail.
    const offIntervention = events.on('brain.intervention', (payload) => {
      if (!isCurrentSession(payload.sessionId)) return;
      if (shownMonitorAnswers.has(payload.request.id)) return;
      const pending = pendingMonitorAnswers.get(payload.request.id);
      if (pending) {
        clearTimeout(pending);
        pendingMonitorAnswers.delete(payload.request.id);
      }
      const outcome = payload.intervened
        ? `steered the agent (${payload.kind.replace(/_/g, ' ')})`
        : 'observed — no action needed';
      const rationale = payload.decision.type === 'answer' ? payload.decision.rationale : undefined;
      const decision = decisionSummary(payload.decision);
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'brain',
          status: 'answered',
          source: 'monitor',
          risk: payload.request.risk,
          question: payload.request.question,
          decision,
          outcome,
          interventionKind: payload.kind,
          rationale,
        },
      });
    });

    return () => {
      offRequested();
      offAnswered();
      offAskHuman();
      offDenied();
      offCouncilVote();
      offCouncilResolved();
      offIntervention();
      for (const timer of pendingMonitorAnswers.values()) clearTimeout(timer);
      pendingMonitorAnswers.clear();
      councilTraces.clear();
      councilVotes.clear();
    };
  }, [events, dispatch, getSessionId]);
}
