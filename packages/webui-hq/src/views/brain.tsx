/**
 * Brain — the decision trail.
 *
 * Requests, answers, human escalations and interventions as a governed ledger
 * rather than a flat event stream: newest first, each entry carrying its
 * source, its risk and the decision that came out of it. Seeded from the
 * persisted log so a fresh browser sees history immediately.
 */
import type { HqBrainEventPayload } from '@wrongstack/core/hq';
import {
  BrainCircuit,
  CircleCheck,
  CircleHelp,
  CircleSlash,
  Hand,
  UserRound,
  Zap,
} from 'lucide-react';
import type * as React from 'react';
import { useMemo } from 'react';
import { EmptyState, Mono, toneText } from '../components/hq/primitives.js';
import { HeroMetric, Section, ViewHero, ViewShell } from '../components/hq/view-chrome.js';
import { Badge, type BadgeTone } from '../components/ui/badge.js';
import { Card } from '../components/ui/card.js';
import type { HqTone } from '../domain/status-tone.js';
import { useBackfilledEvents } from '../domain/use-backfilled-events.js';
import { formatClock } from '../lib/format.js';

/** How many entries the trail renders. Older ones stay in the log, not the DOM. */
const TRAIL_LIMIT = 200;

const KIND_META: Record<
  string,
  { label: string; icon: typeof BrainCircuit; tone: HqTone; badge: BadgeTone }
> = {
  decision_requested: { label: 'Requested', icon: CircleHelp, tone: 'info', badge: 'info' },
  decision_answered: { label: 'Answered', icon: CircleCheck, tone: 'active', badge: 'active' },
  decision_ask_human: { label: 'Ask human', icon: Hand, tone: 'warn', badge: 'warn' },
  decision_denied: { label: 'Denied', icon: CircleSlash, tone: 'error', badge: 'error' },
  human_answered: { label: 'Human', icon: UserRound, tone: 'info', badge: 'info' },
  intervention: { label: 'Intervention', icon: Zap, tone: 'warn', badge: 'warn' },
};

export function BrainView(): React.ReactElement {
  const { events: all, loading } = useBackfilledEvents('brain.event', TRAIL_LIMIT);
  const events = useMemo(() => all.slice(-TRAIL_LIMIT).reverse(), [all]);

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
      <ViewShell>
        <EmptyState
          icon={BrainCircuit}
          title={loading ? 'Loading brain history…' : 'No brain decisions yet'}
          hint={
            loading
              ? undefined
              : 'Entries appear when autonomous consumers route decisions through the Brain.'
          }
        />
      </ViewShell>
    );
  }

  return (
    <ViewShell>
      <ViewHero
        eyebrow="Decision ledger"
        headline="Brain arbitration"
        description="Requests, answers, escalations and interventions as a governed trail."
        tone={summary.highRisk > 0 ? 'error' : summary.human > 0 ? 'warn' : 'active'}
        metrics={
          <>
            <HeroMetric label="requested" value={summary.requested} />
            <HeroMetric label="answered" value={summary.answered} tone="active" />
            <HeroMetric
              label="human"
              value={summary.human}
              tone={summary.human > 0 ? 'warn' : 'idle'}
            />
            <HeroMetric
              label="high risk"
              value={summary.highRisk}
              tone={summary.highRisk > 0 ? 'error' : 'active'}
            />
          </>
        }
      />

      <Section
        eyebrow={`Latest ${events.length}`}
        title="Decision trail"
        action={
          summary.interventions > 0 && (
            <Badge tone="warn">{summary.interventions} interventions</Badge>
          )
        }
      >
        <div className="space-y-2">
          {events.map((event) => {
            const payload = event.payload as HqBrainEventPayload;
            const meta = KIND_META[payload.kind] ?? {
              label: payload.kind,
              icon: BrainCircuit,
              tone: 'info' as HqTone,
              badge: 'info' as BadgeTone,
            };
            const Icon = meta.icon;
            const highRisk = payload.risk === 'high' || payload.risk === 'critical';
            return (
              <Card
                key={event.id}
                data-testid="brain-entry"
                data-kind={payload.kind}
                className="flex-row items-stretch"
              >
                <div className="flex w-9 shrink-0 items-start justify-center border-r border-border pt-3">
                  <Icon className={`size-4 ${toneText(meta.tone)}`} />
                </div>
                <div className="min-w-0 flex-1 space-y-1.5 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium">{meta.label}</span>
                    {payload.source !== undefined && <Badge tone="info">{payload.source}</Badge>}
                    {payload.risk !== undefined && (
                      <Badge tone={highRisk ? 'error' : 'warn'}>{payload.risk} risk</Badge>
                    )}
                    <Mono className="tabular ml-auto">{formatClock(payload.at)}</Mono>
                  </div>

                  {payload.question !== undefined && (
                    <p className="font-mono text-[11px] leading-relaxed">{payload.question}</p>
                  )}
                  {payload.decision !== undefined && (
                    <Badge tone="active">→ {payload.decision}</Badge>
                  )}
                  {payload.detail !== undefined && <Mono>{payload.detail}</Mono>}
                  {payload.kind === 'intervention' && (
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone="warn">{payload.interventionKind}</Badge>
                      <Badge tone={payload.intervened ? 'running' : 'idle'}>
                        {payload.intervened ? 'steered' : 'observed'}
                      </Badge>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      </Section>
    </ViewShell>
  );
}
