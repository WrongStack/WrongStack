/**
 * Worktree view — git worktree lifecycle swim-lanes (AutoPhase build phases).
 * Seeded from the persisted event log (`/api/events?type=worktree.event`),
 * then fed live. Events are grouped per owner so one worktree's lifecycle
 * reads as a single lane instead of interleaved noise.
 */
import type { HqEventEnvelope, HqWorktreeEventPayload } from '@wrongstack/core';
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
    <div className="hq-row">
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

  // Group into per-owner lanes, newest lane first.
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

  if (lanes.length === 0) {
    return (
      <div className="hq-empty">
        {loading
          ? 'Loading worktree history…'
          : 'No worktree events yet. These appear when AutoPhase allocates/merges git worktrees for parallel phases.'}
      </div>
    );
  }

  return (
    <div>
      <div className="hq-card-title">
        Worktree Lifecycle ({lanes.length} worktree{lanes.length === 1 ? '' : 's'})
      </div>
      {lanes.map(([owner, events]) => {
        const last = events[events.length - 1]!.payload as HqWorktreeEventPayload;
        const lastMeta = KIND_META[last.kind] ?? { Icon: Package, cls: 'info' };
        return (
          <div key={owner} className="hq-card">
            <div className="hq-row hq-lane-head">
              <span className="hq-mono hq-text-bright">
                {owner}
              </span>
              <span className={`hq-pill ${lastMeta.cls}`}>{last.kind}</span>
              <span className="hq-mono hq-row-time">{events.length} events</span>
            </div>
            {events.map((e) => (
              <EventLine key={e.id} e={e} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
