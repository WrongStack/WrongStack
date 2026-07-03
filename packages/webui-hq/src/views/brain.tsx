/**
 * Brain view — decision requests, answers, denials, interventions timeline.
 * Fed by `brain.event` envelopes from Phase 1.
 */
import type React from 'react';
import { useHqStore } from '../store.js';
import type { HqBrainEventPayload } from '@wrongstack/core';

const KIND_LABEL: Record<string, string> = {
  decision_requested: '❓ Requested',
  decision_answered: '✅ Answered',
  decision_ask_human: '🙋 Ask Human',
  decision_denied: '🚫 Denied',
  human_answered: '👤 Human',
  intervention: '⚡ Intervention',
};

export function BrainView(): React.ReactElement {
  const state = useHqStore();
  const events = state.events.filter((e) => e.type === 'brain.event').slice(-100).reverse();

  if (events.length === 0) {
    return <div className="hq-empty">No brain decisions yet. Brain events appear when autonomous consumers (Director, AutoPhase, Eternal) route decisions through the Brain.</div>;
  }

  return (
    <div>
      <div className="hq-card-title">Brain Decisions (last {events.length})</div>
      {events.map((e) => {
        const p = e.payload as HqBrainEventPayload;
        return (
          <div key={e.id} className="hq-card">
            <div className="hq-row">
              <span style={{ fontWeight: 700 }}>{KIND_LABEL[p.kind] ?? p.kind}</span>
              {p.source && <span className="hq-pill info">{p.source}</span>}
              {p.risk && <span className={'hq-pill ' + (p.risk === 'high' || p.risk === 'critical' ? 'error' : 'warn')}>{p.risk} risk</span>}
              <span className="hq-mono" style={{ marginLeft: 'auto', color: 'var(--dim)' }}>{new Date(p.at).toLocaleTimeString()}</span>
            </div>
            {p.question && <div className="hq-mono" style={{ marginTop: 4 }}>{p.question}</div>}
            {p.decision && <div className="hq-row" style={{ marginTop: 4 }}><span className="hq-pill active">→ {p.decision}</span></div>}
            {p.detail && <div className="hq-mono" style={{ color: 'var(--muted)', marginTop: 4 }}>{p.detail}</div>}
            {p.kind === 'intervention' && (
              <div className="hq-row" style={{ marginTop: 4 }}>
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
