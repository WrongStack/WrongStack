'use client';

/**
 * Brain — the decisions autonomous runs took, and how.
 *
 * Each card is one decision: the question, what came of it (answered, denied,
 * handed to a human), which tier settled it and whether that cost a model call.
 * Interventions — the Brain stepping into a run on its own — sit in the same
 * timeline. Seeded from the persisted log, then followed live.
 */
import { useHqStore } from '@hq/data/store/index';
import { useBackfilledEvents } from '@hq/domain/use-backfilled-events';
import type { HqProjectRecord } from '@wrongstack/hq';
import { BrainCircuit } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { relativeTime } from '@/features/attention/model';
import { plural } from '@/features/overview/model';
import { cn } from '@/lib/cn';
import { useScopedEvents } from '@/lib/use-scope';
import {
  buildTrail,
  type Decision,
  filterTrail,
  type Intervention,
  isHighRisk,
  isModelBacked,
  OUTCOME_LABEL,
  type Outcome,
  summarize,
  type TrailFilter,
} from './model';

const TRAIL_LIMIT = 300;
const EMPTY_PROJECTS: readonly HqProjectRecord[] = [];

const OUTCOME_TONE: Record<Outcome, string> = {
  open: 'text-muted-foreground',
  answered: 'text-success',
  denied: 'text-destructive',
  waiting: 'text-warning',
  escalated: 'text-warning',
  human: 'text-info',
};

const STEP_LABEL: Record<string, string> = {
  decision_requested: 'Asked',
  decision_answered: 'Answered',
  decision_denied: 'Denied',
  decision_ask_human: 'Handed to a human',
  human_answered: 'Human answered',
  council_resolved: 'Council voted',
};

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function duration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function BrainView(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const backfilled = useBackfilledEvents('brain.event', TRAIL_LIMIT);
  const events = useScopedEvents(backfilled.events);
  const loading = backfilled.loading;
  const projects = useHqStore((state) => state.snapshot?.projects ?? EMPTY_PROJECTS);
  const now = useNow();

  const trail = useMemo(() => buildTrail(events), [events]);
  const summary = useMemo(() => summarize(trail), [trail]);
  const filters: { id: TrailFilter; label: string; count: number }[] = [
    { id: 'all', label: 'Everything', count: trail.length },
    { id: 'waiting', label: 'Waiting on a human', count: summary.waiting },
    { id: 'high-risk', label: 'High risk', count: summary.highRisk },
    { id: 'model', label: 'Model calls', count: summary.modelBacked },
    { id: 'interventions', label: 'Interventions', count: summary.interventions },
  ];
  const filter = filters.find((candidate) => candidate.id === params.get('show'))?.id ?? 'all';
  const shown = useMemo(() => filterTrail(trail, filter), [trail, filter]);
  const names = useMemo(
    () => new Map(projects.map((project) => [project.projectId, project.projectName])),
    [projects],
  );
  const nameOf = (id: string): string => names.get(id) ?? id;

  if (trail.length === 0) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-3 px-6 py-16">
        <BrainCircuit className="size-6 text-muted-foreground" />
        <h2 className="font-display text-2xl font-semibold">
          {loading ? 'Loading the decision history…' : 'No Brain decision yet'}
        </h2>
        {!loading && (
          <p className="text-base text-muted-foreground">
            Decisions appear here when an autonomous run asks the Brain instead of a person.
          </p>
        )}
      </div>
    );
  }

  const pick = (id: TrailFilter): void => {
    router.replace(id === 'all' ? pathname : `${pathname}?show=${id}`, { scroll: false });
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <header className="flex flex-col gap-2">
        <h2 className="font-display text-2xl font-semibold">
          {summary.waiting > 0
            ? `${plural(summary.waiting, 'decision')} waiting on a human`
            : `${plural(summary.decisions, 'decision')}, none waiting`}
        </h2>
        <p className="text-base text-muted-foreground">
          {summary.answered} answered, {summary.denied} denied, {summary.humans} handed to a person.{' '}
          {summary.modelBacked > 0
            ? `${plural(summary.modelBacked, 'decision')} needed a model call; ${summary.free} settled by rules or cache.`
            : 'All settled without a model call.'}
          {summary.interventions > 0 &&
            ` The Brain stepped into ${plural(summary.interventions, 'run')} and steered ${summary.steered}.`}
          {summary.councilTokens > 0 &&
            ` Councils used ${summary.councilTokens.toLocaleString()} tokens.`}
        </p>
        {summary.degradedPanels > 0 && (
          <p className="text-sm text-destructive">
            {plural(summary.degradedPanels, 'council')} voted with a weakened panel — see the marked
            cards.
          </p>
        )}
      </header>

      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Show</legend>
        {filters.map((candidate) => (
          <label
            key={candidate.id}
            className={cn(
              'flex h-9 cursor-pointer items-center gap-2 border px-3 text-sm focus-within:ring-2 focus-within:ring-ring',
              candidate.id === filter
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            <input
              type="radio"
              name="brain-filter"
              value={candidate.id}
              checked={candidate.id === filter}
              onChange={() => pick(candidate.id)}
              className="sr-only"
            />
            {candidate.label}
            <span className="tabular">{candidate.count}</span>
          </label>
        ))}
      </fieldset>

      {shown.length === 0 ? (
        <p className="text-base text-muted-foreground">Nothing here in the loaded history.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {shown.map((item) =>
            item.kind === 'decision' ? (
              <DecisionCard
                key={item.key}
                decision={item}
                project={nameOf(item.projectId)}
                now={now}
              />
            ) : (
              <InterventionCard
                key={item.key}
                item={item}
                project={nameOf(item.projectId)}
                now={now}
              />
            ),
          )}
        </ol>
      )}
      {events.length >= TRAIL_LIMIT && (
        <p className="text-sm text-muted-foreground">
          Showing decisions from the newest {TRAIL_LIMIT} Brain events. Older ones are in the Event
          log.
        </p>
      )}
    </div>
  );
}

function SessionLink({ sessionId }: { sessionId: string | undefined }): ReactNode {
  if (sessionId === undefined) return null;
  return (
    <Link
      href={`/fleet/console/?session=${encodeURIComponent(sessionId)}`}
      className="underline-offset-4 hover:text-foreground hover:underline"
    >
      Open the run
    </Link>
  );
}

function DecisionCard({
  decision,
  project,
  now,
}: {
  decision: Decision;
  project: string;
  now: number;
}): ReactNode {
  const resolved = decision.outcome !== 'open' && decision.outcome !== 'waiting';
  const council = decision.council;
  return (
    <li
      data-decision={decision.requestId ?? decision.key}
      className={cn(
        'flex flex-col gap-3 border bg-card p-4',
        decision.outcome === 'waiting' ? 'border-warning/60' : 'border-border',
      )}
    >
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className={cn('font-semibold', OUTCOME_TONE[decision.outcome])}>
          {OUTCOME_LABEL[decision.outcome]}
        </span>
        {decision.risk !== undefined && (
          <span
            className={cn(
              isHighRisk(decision.risk) ? 'font-medium text-destructive' : 'text-muted-foreground',
            )}
          >
            {decision.risk} risk
          </span>
        )}
        {decision.tier !== undefined && (
          <span className="text-muted-foreground">
            {resolved ? 'settled' : 'routed'} by {decision.tier}
            {isModelBacked(decision.tier) ? ' — a model call' : ' — no model call'}
          </span>
        )}
        <span
          className="ml-auto text-muted-foreground"
          title={new Date(decision.lastAt).toLocaleString()}
        >
          {relativeTime(decision.lastAt, now)}
        </span>
      </p>
      {decision.question !== undefined && (
        <p className="text-base leading-relaxed">{decision.question}</p>
      )}
      {(decision.decision !== undefined || decision.detail !== undefined) && (
        <p className="border-l-2 border-border pl-3 text-sm leading-relaxed">
          {decision.decision !== undefined && (
            <span className="font-medium">{decision.decision}</span>
          )}
          {decision.decision !== undefined && decision.detail !== undefined && ' — '}
          {decision.detail}
        </p>
      )}
      {decision.humanDetail !== undefined && (
        <p className="border-l-2 border-info/60 pl-3 text-sm leading-relaxed">
          <span className="font-medium">Person:</span> {decision.humanDetail}
        </p>
      )}
      {council !== undefined && (
        <div
          className={cn(
            'flex flex-col gap-1 border px-3 py-2 text-sm',
            council.degraded ? 'border-destructive/50 bg-destructive/5' : 'border-border',
          )}
        >
          <span>
            Council: {council.votes} of {council.seats} seats voted
            {council.resolution !== undefined && `, resolved by ${council.resolution}`}
            {council.rounds !== undefined &&
              council.rounds > 1 &&
              ` after ${council.rounds} rounds`}
            {council.tokens > 0 && ` · ${council.tokens.toLocaleString()} tokens`}
          </span>
          {council.votes > 0 && council.distinctModels < council.votes && (
            <span className="text-destructive">
              Only {plural(council.distinctModels, 'distinct model')} behind {council.votes} votes —
              the panel asked the same model more than once.
            </span>
          )}
          {council.judgeIsVoter && (
            <span className="text-destructive">
              The tie-breaker {council.judge ?? ''} had already voted.
            </span>
          )}
          {council.warnings.map((warning) => (
            <span key={warning} className="text-destructive">
              {warning}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{project}</span>
        {decision.source !== undefined && <span>asked by {decision.source}</span>}
        {resolved && decision.steps.length > 1 && decision.lastAt > decision.startedAt && (
          <span>took {duration(decision.lastAt - decision.startedAt)}</span>
        )}
        <SessionLink sessionId={decision.sessionId} />
        {decision.steps.length > 1 && (
          <details className="basis-full">
            <summary className="cursor-pointer hover:text-foreground">
              {plural(decision.steps.length, 'step')}
            </summary>
            <ol className="mt-1 flex flex-col gap-0.5">
              {decision.steps.map((step, index) => (
                <li key={`${step.kind}-${step.at}-${index}`} className="tabular">
                  {new Date(step.at).toLocaleTimeString()} · {STEP_LABEL[step.kind] ?? step.kind}
                  {step.tier !== undefined && ` · ${step.tier}`}
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </li>
  );
}

function InterventionCard({
  item,
  project,
  now,
}: {
  item: Intervention;
  project: string;
  now: number;
}): ReactNode {
  return (
    <li
      data-intervention={item.key}
      className="flex flex-col gap-2 border border-dashed border-border p-4"
    >
      <p className="flex flex-wrap items-baseline gap-x-3 text-sm">
        <span className="font-semibold">
          {item.steered ? 'Stepped in and steered the run' : 'Noticed, did not steer'}
        </span>
        {item.signal !== undefined && (
          <span className="text-muted-foreground">on {item.signal.replaceAll('_', ' ')}</span>
        )}
        <span
          className="ml-auto text-muted-foreground"
          title={new Date(item.lastAt).toLocaleString()}
        >
          {relativeTime(item.lastAt, now)}
        </span>
      </p>
      {item.detail !== undefined && <p className="text-sm leading-relaxed">{item.detail}</p>}
      <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>{project}</span>
        <SessionLink sessionId={item.sessionId} />
      </p>
    </li>
  );
}
