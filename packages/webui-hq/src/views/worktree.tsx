/**
 * Worktrees — git lifecycle as swim-lanes.
 *
 * Events are grouped per OWNER rather than shown as one stream, because a
 * worktree's story (allocated → committed → conflict → merged → released) is
 * only legible when its own events sit together. Seeded from the persisted
 * event log so a fresh browser sees history, then fed live.
 */
import type { HqEventEnvelope, HqWorktreeEventPayload } from '@wrongstack/core/hq';
import { Check, GitBranch, GitMerge, Package, Trash2, TriangleAlert, XCircle } from 'lucide-react';
import type * as React from 'react';
import { useMemo } from 'react';
import { EmptyState, Mono, toneText } from '../components/hq/primitives.js';
import { HeroMetric, Section, ViewHero, ViewShell } from '../components/hq/view-chrome.js';
import { Badge, type BadgeTone } from '../components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { useBackfilledEvents } from '../domain/use-backfilled-events.js';
import type { HqTone } from '../domain/status-tone.js';
import { formatClock } from '../lib/format.js';

const KIND_META: Record<string, { icon: typeof Check; tone: HqTone; badge: BadgeTone }> = {
  allocated: { icon: Package, tone: 'info', badge: 'info' },
  committed: { icon: Check, tone: 'active', badge: 'active' },
  merged: { icon: GitMerge, tone: 'active', badge: 'active' },
  conflict: { icon: TriangleAlert, tone: 'warn', badge: 'warn' },
  released: { icon: Trash2, tone: 'idle', badge: 'idle' },
  failed: { icon: XCircle, tone: 'error', badge: 'error' },
};

const FALLBACK = { icon: Package, tone: 'info' as HqTone, badge: 'info' as BadgeTone };

function EventLine({ event }: { event: HqEventEnvelope }): React.ReactElement {
  const payload = event.payload as HqWorktreeEventPayload;
  const meta = KIND_META[payload.kind] ?? FALLBACK;
  const Icon = meta.icon;
  return (
    <div
      data-testid="worktree-event"
      data-kind={payload.kind}
      className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs"
    >
      <Icon className={`size-3.5 shrink-0 ${toneText(meta.tone)}`} />
      <span className="font-medium">{payload.kind}</span>
      {payload.branch !== undefined && <Badge tone="info">{payload.branch}</Badge>}

      {payload.kind === 'committed' && (
        <Mono>
          <span className="text-success">+{payload.insertions ?? 0}</span>{' '}
          <span className="text-destructive">−{payload.deletions ?? 0}</span> in{' '}
          {payload.files ?? 0} file(s)
          {payload.sha !== undefined ? ` (${payload.sha.slice(0, 7)})` : ''}
        </Mono>
      )}
      {payload.kind === 'conflict' && payload.conflictFiles !== undefined && (
        <Mono className="text-destructive">conflicts: {payload.conflictFiles.join(', ')}</Mono>
      )}
      {payload.kind === 'failed' && <Mono className="text-destructive">{payload.error}</Mono>}

      <Mono className="tabular ml-auto">{formatClock(event.timestamp)}</Mono>
    </div>
  );
}

export function WorktreeView(): React.ReactElement {
  const { events, loading } = useBackfilledEvents('worktree.event', 300);

  const lanes = useMemo(() => {
    const byOwner = new Map<string, HqEventEnvelope[]>();
    for (const event of events) {
      const key = (event.payload as HqWorktreeEventPayload).ownerId ?? '(unknown)';
      const lane = byOwner.get(key) ?? [];
      lane.push(event);
      byOwner.set(key, lane);
    }
    // Most recently touched lane first.
    return [...byOwner.entries()].reverse();
  }, [events]);

  const summary = useMemo(() => {
    let open = 0;
    let settled = 0;
    let troubled = 0;
    for (const [, lane] of lanes) {
      const last = lane.at(-1)?.payload as HqWorktreeEventPayload | undefined;
      if (last?.kind === 'merged' || last?.kind === 'released') settled += 1;
      else open += 1;
      if (
        lane.some((event) => {
          const kind = (event.payload as HqWorktreeEventPayload).kind;
          return kind === 'conflict' || kind === 'failed';
        })
      ) {
        troubled += 1;
      }
    }
    return { open, settled, troubled };
  }, [lanes]);

  if (lanes.length === 0) {
    return (
      <ViewShell>
        <EmptyState
          icon={GitBranch}
          title={loading ? 'Loading worktree history…' : 'No worktree events yet'}
          hint={
            loading
              ? undefined
              : 'These appear when Goal allocates or merges git worktrees for parallel phases.'
          }
        />
      </ViewShell>
    );
  }

  return (
    <ViewShell>
      <ViewHero
        eyebrow="Workspace lanes"
        headline="Parallel branch lifecycle"
        description="One lane per owner, so allocation, commits, conflicts, merges and release read as an ordered build path."
        tone={summary.troubled > 0 ? 'error' : summary.open > 0 ? 'warn' : 'active'}
        metrics={
          <>
            <HeroMetric label="lanes" value={lanes.length} />
            <HeroMetric
              label="open"
              value={summary.open}
              tone={summary.open > 0 ? 'warn' : 'active'}
            />
            <HeroMetric label="merged / released" value={summary.settled} tone="active" />
            <HeroMetric
              label="conflicted"
              value={summary.troubled}
              tone={summary.troubled > 0 ? 'error' : 'active'}
            />
          </>
        }
      />

      <Section eyebrow={`${lanes.length} owners`} title="Lanes">
        <div className="grid gap-3 2xl:grid-cols-2">
          {lanes.map(([owner, lane]) => {
            const last = lane.at(-1)!.payload as HqWorktreeEventPayload;
            const meta = KIND_META[last.kind] ?? FALLBACK;
            return (
              <Card key={owner} data-testid="worktree-lane">
                <CardHeader>
                  <CardTitle className="truncate font-mono normal-case tracking-normal">
                    {owner}
                  </CardTitle>
                  <Badge tone={meta.badge}>{last.kind}</Badge>
                  <Mono className="tabular ml-auto">{lane.length} events</Mono>
                </CardHeader>
                <CardContent className="divide-y divide-border/60 p-0">
                  {lane.map((event) => (
                    <EventLine key={event.id} event={event} />
                  ))}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </Section>
    </ViewShell>
  );
}
