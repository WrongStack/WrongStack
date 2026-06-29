import type { EventBus } from '@wrongstack/core';
import { useEffect } from 'react';
import type { Action, State } from '../app-reducer.js';
import type { HistoryEntry } from '../components/history.js';

/**
 * Brain decision events → chat history / status bar.
 */
export function useBrainEvents(
  events: EventBus,
  dispatch: React.Dispatch<Action>,
  getSessionId?: (() => string | undefined) | undefined,
): void {
  useEffect(() => {
    const isCurrentSession = (sessionId?: string | undefined): boolean => {
      const current = getSessionId?.();
      return !sessionId || !current || sessionId === current;
    };
    const requestSummary = (request: { source: string; question: string }) =>
      `${request.source}: ${request.question}`.slice(0, 80);

    const addBrainEntry = (
      status: Exclude<
        Extract<HistoryEntry, { kind: 'brain' }>['status'],
        'thinking' | 'intervention'
      >,
      payload: unknown,
    ) => {
      const p = payload as {
        request: { id: string; source: string; risk: Extract<HistoryEntry, { kind: 'brain' }>['risk']; question: string; context?: string | undefined; options?: NonNullable<State['brainPrompt']>['options'] | undefined };
        decision: { type: string; optionId?: string | undefined; text?: string | undefined; prompt?: string | undefined; reason?: string | undefined; rationale?: string | undefined };
      };
      const decision = p.decision.optionId ?? p.decision.text ?? p.decision.reason ?? p.decision.prompt ?? p.decision.type;
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
      dispatch({ type: 'addEntry', entry: { kind: 'brain', status, source: p.request.source, risk: p.request.risk, question: p.request.question, decision, rationale: p.decision.rationale } });
    };

    const offRequested = events.on('brain.decision_requested', ({ sessionId, request }) => {
      if (!isCurrentSession(sessionId)) return;
      dispatch({ type: 'brainStatus', state: 'deciding', source: request.source, risk: request.risk, summary: requestSummary(request) });
    });
    const offAnswered = events.on('brain.decision_answered', (payload) => {
      if (isCurrentSession(payload.sessionId)) addBrainEntry('answered', payload);
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
      const decision = payload.intervened
        ? `steered the agent (${payload.kind.replace(/_/g, ' ')})`
        : 'observed — no action needed';
      const rationale =
        payload.decision.type === 'answer' ? payload.decision.rationale : undefined;
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'brain',
          status: 'intervention',
          source: 'monitor',
          risk: payload.request.risk,
          question: payload.request.question,
          decision,
          rationale,
        },
      });
    });

    return () => { offRequested(); offAnswered(); offAskHuman(); offDenied(); offIntervention(); };
  }, [events, dispatch, getSessionId]);
}
