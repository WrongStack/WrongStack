'use client';

import type { HqProjectRecord, HqSessionSnapshotPayload } from '@wrongstack/hq';
import { ArrowRight, CircleDollarSign, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { plural } from '@/features/overview/model';
import { useScopedSnapshot } from '@/lib/use-scope';
import { BreakdownTable } from './breakdown-table';
import {
  breakdown,
  CONCENTRATION_SHARE,
  count,
  percent,
  projectSpend,
  sessionSpend,
  TREND_RANGES,
  trendTotals,
  trendWindow,
  usd,
} from './model';
import { useTrends } from './use-trends';

const EMPTY_PROJECTS: readonly HqProjectRecord[] = [];
const EMPTY_SESSIONS: readonly HqSessionSnapshotPayload[] = [];
const DAY = TREND_RANGES.find((range) => range.id === '24h');

export function CostView(): ReactNode {
  const snapshot = useScopedSnapshot();
  const projects = snapshot?.projects ?? EMPTY_PROJECTS;
  const live = snapshot?.liveSessions ?? EMPTY_SESSIONS;
  const trends = useTrends();

  const ranked = useMemo(() => projectSpend(projects), [projects]);
  const sessions = useMemo(() => sessionSpend(live), [live]);
  const day = useMemo(
    () => (DAY === undefined ? [] : trendWindow(trends.samples, DAY, trends.fetchedAt).samples),
    [trends.samples, trends.fetchedAt],
  );
  const dayTotals = useMemo(() => trendTotals(day), [day]);
  const dayModels = useMemo(() => breakdown(day, 'byModel'), [day]);
  const total = snapshot?.totals.totalCostUsd ?? ranked.reduce((sum, row) => sum + row.costUsd, 0);
  const leader = ranked[0];
  const concentrated =
    leader !== undefined && ranked.length > 1 && leader.share > CONCENTRATION_SHARE;

  if (projects.length === 0) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-3 px-6 py-16">
        <CircleDollarSign className="size-6 text-muted-foreground" />
        <h2 className="font-display text-2xl font-semibold">No spend reported yet</h2>
        <p className="text-base text-muted-foreground">
          Cost appears once a connected client starts spending tokens.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          Reported spend across {plural(projects.length, 'project')}
        </p>
        <h2 className="tabular font-display text-4xl font-semibold tracking-tight">{usd(total)}</h2>
        <p className="text-base text-muted-foreground">
          {trends.loading
            ? 'Loading the last 24 hours…'
            : dayTotals.costUsd > 0
              ? `${usd(dayTotals.costUsd)} in the last 24 hours, ${count(dayTotals.inputTokens + dayTotals.outputTokens)} tokens${
                  dayModels[0] !== undefined ? ` — most of it on ${dayModels[0].key}` : ''
                }.`
              : 'Nothing spent in the last 24 hours.'}{' '}
          <Link
            href="/telemetry/trends/"
            className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
          >
            Over time <ArrowRight className="size-3.5" />
          </Link>
        </p>
      </header>

      {concentrated && leader !== undefined && (
        <p className="flex items-start gap-2 border border-warning/50 bg-warning/10 px-4 py-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            <strong className="font-semibold">{leader.name}</strong> accounts for{' '}
            {percent(leader.share)} of all spend. A single project this far ahead is often a run
            stuck in a loop — worth a look in Fleet.
          </span>
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">By project</h3>
        <ol className="flex flex-col">
          {ranked.map((row) => (
            <li key={row.projectId} className="flex flex-col gap-2 border-t border-border py-3">
              <span className="flex flex-wrap items-baseline gap-x-3">
                <span className="text-base font-medium">{row.name}</span>
                <span className="text-sm text-muted-foreground">
                  {row.sessions > 0 ? `${plural(row.sessions, 'session')} open` : 'no session open'}
                </span>
                <span className="tabular ml-auto text-base font-semibold">{usd(row.costUsd)}</span>
                <span className="tabular w-12 text-right text-sm text-muted-foreground">
                  {percent(row.share)}
                </span>
              </span>
              <span className="h-1.5 bg-muted" aria-hidden="true">
                <span
                  className="block h-full bg-primary"
                  style={{ width: `${Math.max(row.share * 100, row.share > 0 ? 0.5 : 0)}%` }}
                />
              </span>
            </li>
          ))}
        </ol>
      </section>

      {dayModels.length > 0 && (
        <BreakdownTable title="By model, last 24 hours" rows={dayModels} showTokens />
      )}

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Open sessions</h3>
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open session has spent anything yet.</p>
        ) : (
          <ul className="flex flex-col">
            {sessions.map((row) => (
              <li key={row.sessionId} className="border-t border-border">
                <Link
                  href={`/fleet/console/?session=${encodeURIComponent(row.sessionId)}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3 hover:bg-muted/50"
                >
                  <span className="font-medium">{row.projectName}</span>
                  <span className="text-sm text-muted-foreground">
                    {row.machine} · {plural(row.agents, 'agent')}
                    {row.models.length > 0 && ` · ${row.models.join(', ')}`}
                  </span>
                  <span className="tabular ml-auto text-sm text-muted-foreground">
                    {count(row.tokens)} tokens
                  </span>
                  <span className="tabular w-24 text-right font-semibold">{usd(row.costUsd)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
