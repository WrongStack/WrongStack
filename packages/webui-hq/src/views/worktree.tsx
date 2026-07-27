/**
 * Worktree view — git worktree lifecycle swim-lanes (Goal build phases).
 * Seeded from the persisted event log (`/api/events?type=worktree.event`),
 * then fed live. Events are grouped per owner so one worktree's lifecycle
 * reads as a single lane instead of interleaved noise.
 */
import type { HqEventEnvelope, HqWorktreeEventPayload } from '@wrongstack/core/hq';
import { AlertTriangle, Check, GitMerge, Package, Trash2, XCircle } from 'lucide-react';
import type React from 'react';
import { useMemo } from 'react';
import { useBackfilledEvents } from '../lib/use-backfilled-events.js';

const KIND_META: Record<string, { Icon: typeof Check; cls: string }> = {
  allocated: { Icon: Package, cls: 'info' },
  committed: { Icon: Check, cls: 'active' },
  merged: { Icon: GitMerge, cls: 'active' },
  conflict: { Icon: AlertTriangle, cls: 'warn' },
  released: { Icon: Trash2, cls: 'idle' },
  failed: { Icon: XCircle, cls: 'error' },
};

function EventLine({ e }: { e: HqEventEnvelope }): React.ReactElement {
  const p = e.payload as HqWorktreeEventPayload;
  const meta = KIND_META[p.kind] ?? { Icon: Package, cls: 'info' };
  return (
    <div className="hq-row hq-worktree-event-line">
      <meta.Icon size={14} className={`hq-kind-icon ${meta.cls}`} />
      <span className="hq-text-bright">{p.kind}</span>
      {p.branch !== undefined && <span className="hq-pill info">{p.branch}</span>}
      {p.kind === 'committed' && (
        <span className="hq-mono hq-diffstat">
          <span className="hq-diff-add-count">+{p.insertions ?? 0}</span>{' '}
          <span className="hq-diff-del-count">−{p.deletions ?? 0}</span> in {p.files ?? 0} file(s){' '}
          {p.sha !== undefined ? `(${p.sha.slice(0, 7)})` : ''}
        </span>
      )}
      {p.kind === 'conflict' && p.conflictFiles !== undefined && (
        <span className="hq-mono hq-row-error">conflicts: {p.conflictFiles.join(', ')}</span>
      )}
      {p.kind === 'failed' && <span className="hq-mono hq-row-error">{p.error}</span>}
      <span className="hq-mono hq-row-time">{new Date(e.timestamp).toLocaleTimeString()}</span>
    </div>
  );
}

export function WorktreeView(): React.ReactElement {
  const { events: all, loading } = useBackfilledEvents('worktree.event', 300);

  const lanes = useMemo(() => {
    const byOwner = new Map<string, HqEventEnvelope[]>();
    for (const e of all) {
      const p = e.payload as HqWorktreeEventPayload;
      const key = p.ownerId ?? '(unknown)';
      const arr = byOwner.get(key) ?? [];
      arr.push(e);
      byOwner.set(key, arr);
    }
    return Array.from(byOwner.entries()).reverse();
  }, [all]);

  const summary = useMemo(() => {
    let open = 0;
    let merged = 0;
    let conflicts = 0;
    let failed = 0;
    for (const [, events] of lanes) {
      const last = events.at(-1)?.payload as HqWorktreeEventPayload | undefined;
      if (last?.kind === 'merged' || last?.kind === 'released') merged += 1;
      else open += 1;
      if (events.some((event) => (event.payload as HqWorktreeEventPayload).kind === 'conflict')) {
        conflicts += 1;
      }
      if (events.some((event) => (event.payload as HqWorktreeEventPayload).kind === 'failed')) {
        failed += 1;
      }
    }
    return { open, merged, conflicts, failed };
  }, [lanes]);

  if (lanes.length === 0) {
    return (
      <div className="hq-empty hq-empty-ornate">
        {loading
          ? 'Loading worktree history…'
          : 'No worktree events yet. These appear when Goal allocates or merges git worktrees for parallel phases.'}
      </div>
    );
  }

  return (
    <div className="hq-screen hq-worktree-screen">
      <section className="hq-screen-hero hq-worktree-hero" aria-label="Worktree lifecycle summary">
        <div>
          <span className="hq-section-kicker">Workspace lanes</span>
          <h2>Parallel branch lifecycle</h2>
          <p>
            Each owner gets a lane so allocation, commits, conflicts, merges and release events read
            as an ordered build path.
          </p>
        </div>
        <div className="hq-hero-metrics">
          <Metric label="lanes" value={lanes.length} />
          <Metric label="open" value={summary.open} tone={summary.open > 0 ? 'warn' : 'ok'} />
          <Metric label="merged/released" value={summary.merged} tone="ok" />
          <Metric label="conflicts" value={summary.conflicts + summary.failed} tone={summary.conflicts + summary.failed > 0 ? 'error' : 'ok'} />
        </div>
      </section>

      <div className="hq-worktree-lanes">
        {lanes.map(([owner, events]) => {
          const last = events[events.length - 1]!.payload as HqWorktreeEventPayload;
          const lastMeta = KIND_META[last.kind] ?? { Icon: Package, cls: 'info' };
          return (
            <article key={owner} className="hq-card hq-worktree-lane">
              <div className="hq-row hq-lane-head">
                <span className="hq-mono hq-text-bright">{owner}</span>
                <span className={`hq-pill ${lastMeta.cls}`}>{last.kind}</span>
                <span className="hq-mono hq-row-time">{events.length} events</span>
              </div>
              <div className="hq-worktree-event-list">
                {events.map((e) => (
                  <EventLine key={e.id} e={e} />
                ))}
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
