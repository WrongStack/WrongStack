/**
 * Brain view — decision requests, answers, denials, interventions timeline.
 * Seeded from the persisted event log (`/api/events?type=brain.event`) so a
 * fresh browser sees history immediately, then fed live by `brain.event`
 * envelopes.
 */
import type { HqBrainEventPayload } from '@wrongstack/core';
import { Brain, CheckCircle2, CircleHelp, CircleSlash, Hand, UserRound, Zap } from 'lucide-react';
import type React from 'react';
import { useBackfilledEvents } from '../lib/use-backfilled-events.js';

const KIND_META: Record<string, { label: string; Icon: typeof Brain; cls: string }> = {
  decision_requested: { label: 'Requested', Icon: CircleHelp, cls: 'info' },
  decision_answered: { label: 'Answered', Icon: CheckCircle2, cls: 'active' },
  decision_ask_human: { label: 'Ask Human', Icon: Hand, cls: 'warn' },
  decision_denied: { label: 'Denied', Icon: CircleSlash, cls: 'error' },
  human_answered: { label: 'Human', Icon: UserRound, cls: 'info' },
  intervention: { label: 'Intervention', Icon: Zap, cls: 'warn' },
};

export function BrainView(): React.ReactElement {
  const { events: all, loading } = useBackfilledEvents('brain.event', 200);
  const events = all.slice(-200).reverse();

  if (events.length === 0) {
    return (
      <div className="hq-empty">
        {loading
          ? 'Loading brain history…'
          : 'No brain decisions yet. Brain events appear when autonomous consumers (Director, AutoPhase, Eternal) route decisions through the Brain.'}
      </div>
    );
  }

  return (
    <div>
      <div className="hq-card-title">Brain Decisions (last {events.length})</div>
      {events.map((e) => {
        const p = e.payload as HqBrainEventPayload;
        const meta = KIND_META[p.kind] ?? { label: p.kind, Icon: Brain, cls: 'info' };
        return (
          <div key={e.id} className="hq-card">
            <div className="hq-row">
              <meta.Icon size={15} className={`hq-kind-icon ${meta.cls}`} />
              <span className="hq-text-bright">{meta.label}</span>
              {p.source !== undefined && <span className="hq-pill info">{p.source}</span>}
              {p.risk !== undefined && (
                <span
                  className={`hq-pill ${p.risk === 'high' || p.risk === 'critical' ? 'error' : 'warn'}`}
                >
                  {p.risk} risk
                </span>
              )}
              <span className="hq-mono hq-row-time">{new Date(p.at).toLocaleTimeString()}</span>
            </div>
            {p.question !== undefined && <div className="hq-mono hq-row-detail">{p.question}</div>}
            {p.decision !== undefined && (
              <div className="hq-row hq-row-detail">
                <span className="hq-pill active">→ {p.decision}</span>
              </div>
            )}
            {p.detail !== undefined && <div className="hq-mono hq-row-subtle">{p.detail}</div>}
            {p.kind === 'intervention' && (
              <div className="hq-row hq-row-detail">
                <span className="hq-pill warn">{p.interventionKind}</span>
                <span className="hq-pill">{p.intervened ? 'steered' : 'observed'}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
