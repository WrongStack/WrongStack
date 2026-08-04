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

    const addBrainEntry = (
      status: Exclude<Extract<HistoryEntry, { kind: 'brain' }>['status'], 'thinking'>,
      payload: unknown,
    ) => {
      const p = payload as {
        request: { id: string; source: string; risk: Extract<HistoryEntry, { kind: 'brain' }>['risk']; question: string; context?: string | undefined; options?: NonNullable<State['brainPrompt']>['options'] | undefined };
        decision: BrainDecision;
      };
      const decision = decisionSummary(p.decision);
      dispatch({ type: 'brainStatus', state: status, source: p.request.source, risk: p.request.risk, summary: decision });
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
      const rationale = p.decision.type === 'deny' ? undefined : p.decision.rationale;
      dispatch({ type: 'addEntry', entry: { kind: 'brain', status, source: p.request.source, risk: p.request.risk, question: p.request.question, decision, rationale } });
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
      dispatch({ type: 'brainStatus', state: 'deciding', source: request.source, risk: request.risk, summary: requestSummary(request) });
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
      if (isCurrentSession(payload.sessionId)) addBrainEntry('ask_human', payload);
    });
    const offDenied = events.on('brain.decision_denied', (payload) => {
      if (isCurrentSession(payload.sessionId)) addBrainEntry('denied', payload);
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
      const rationale =
        payload.decision.type === 'answer' ? payload.decision.rationale : undefined;
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
      offIntervention();
      for (const timer of pendingMonitorAnswers.values()) clearTimeout(timer);
      pendingMonitorAnswers.clear();
    };
  }, [events, dispatch, getSessionId]);
}
