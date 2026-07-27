/**
 * Brain view — decision requests, answers, denials, interventions timeline.
 * Seeded from the persisted event log (`/api/events?type=brain.event`) so a
 * fresh browser sees history immediately, then fed live by `brain.event`
 * envelopes.
 */
import type { HqBrainEventPayload } from '@wrongstack/core/hq';
import { Brain, CheckCircle2, CircleHelp, CircleSlash, Hand, UserRound, Zap } from 'lucide-react';
import type React from 'react';
import { useMemo } from 'react';
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
  const summary = useMemo(() => {
    let requested = 0;
    let answered = 0;
    let human = 0;
    let interventions = 0;
    let highRisk = 0;
    for (const event of events) {
      const payload = event.payload as HqBrainEventPayload;
      if (payload.kind === 'decision_requested') requested += 1;
      if (payload.kind === 'decision_answered') answered += 1;
      if (payload.kind === 'decision_ask_human' || payload.kind === 'human_answered') human += 1;
      if (payload.kind === 'intervention') interventions += 1;
      if (payload.risk === 'high' || payload.risk === 'critical') highRisk += 1;
    }
    return { requested, answered, human, interventions, highRisk };
  }, [events]);

  if (events.length === 0) {
    return (
      <div className="hq-empty hq-empty-ornate">
        {loading
          ? 'Loading brain history…'
          : 'No brain decisions yet. Brain events appear when autonomous consumers route decisions through the Brain.'}
      </div>
    );
  }

  return (
    <div className="hq-screen hq-brain-screen">
      <section className="hq-screen-hero hq-brain-hero" aria-label="Brain decision summary">
        <div>
          <span className="hq-section-kicker">Decision ledger</span>
          <h2>Brain arbitration timeline</h2>
          <p>
            Requests, answers, human escalations and interventions are shown as a governed decision
            trail instead of a flat event stream.
          </p>
        </div>
        <div className="hq-hero-metrics">
          <Metric label="requested" value={summary.requested} />
          <Metric label="answered" value={summary.answered} tone="ok" />
          <Metric label="human" value={summary.human} tone={summary.human > 0 ? 'warn' : undefined} />
          <Metric
            label="high risk"
            value={summary.highRisk}
            tone={summary.highRisk > 0 ? 'error' : 'ok'}
          />
        </div>
      </section>

      <div className="hq-section-head">
        <div>
          <span className="hq-section-kicker">Latest {events.length}</span>
          <h3>Decision trail</h3>
        </div>
        {summary.interventions > 0 ? (
          <span className="hq-pill warn">{summary.interventions} interventions</span>
        ) : null}
      </div>

      <div className="hq-decision-timeline">
        {events.map((e) => {
          const p = e.payload as HqBrainEventPayload;
          const meta = KIND_META[p.kind] ?? { label: p.kind, Icon: Brain, cls: 'info' };
          return (
            <article key={e.id} className={`hq-card hq-decision-card ${meta.cls}`}>
              <div className="hq-decision-marker" aria-hidden="true">
                <meta.Icon size={15} className={`hq-kind-icon ${meta.cls}`} />
              </div>
              <div className="hq-decision-body">
                <div className="hq-row">
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
            </article>
          );
        })}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'warn' | 'error';
}): React.ReactElement {
  return (
    <div className="hq-hero-metric" data-tone={tone}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
