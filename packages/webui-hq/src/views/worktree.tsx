/**
 * Worktree view — git worktree lifecycle swim-lanes (AutoPhase build phases).
 * Fed by `worktree.event` envelopes from Phase 1.
 */
import type React from 'react';
import { useHqStore } from '../store.js';
import type { HqWorktreeEventPayload } from '@wrongstack/core';

const KIND_ICON: Record<string, string> = {
  allocated: '📦',
  committed: '✓',
  merged: '🔀',
  conflict: '⚠',
  released: '🗑',
  failed: '✗',
};

export function WorktreeView(): React.ReactElement {
  const state = useHqStore();
  const events = state.events.filter((e) => e.type === 'worktree.event').slice(-100).reverse();

  if (events.length === 0) {
    return <div className="hq-empty">No worktree events yet. These appear when AutoPhase allocates/merges git worktrees for parallel phases.</div>;
  }

  return (
    <div>
      <div className="hq-card-title">Worktree Lifecycle (last {events.length})</div>
      {events.map((e) => {
        const p = e.payload as HqWorktreeEventPayload;
        return (
          <div key={e.id} className="hq-card">
            <div className="hq-row">
              <span style={{ fontSize: 18 }}>{KIND_ICON[p.kind] ?? '•'}</span>
              <span style={{ fontWeight: 700 }}>{p.kind}</span>
              <span className="hq-mono" style={{ color: 'var(--dim)' }}>{p.ownerId}</span>
              {p.branch && <span className="hq-pill info">{p.branch}</span>}
              <span className="hq-mono" style={{ marginLeft: 'auto', color: 'var(--dim)' }}>{new Date(e.timestamp).toLocaleTimeString()}</span>
            </div>
            {p.kind === 'committed' && (
              <div className="hq-mono" style={{ color: 'var(--green)', marginTop: 4 }}>
                +{p.insertions ?? 0} −{p.deletions ?? 0} in {p.files ?? 0} file(s) {p.sha ? `(${p.sha.slice(0, 7)})` : ''}
              </div>
            )}
            {p.kind === 'conflict' && p.conflictFiles && (
              <div className="hq-mono" style={{ color: 'var(--red)', marginTop: 4 }}>
                Conflicts: {p.conflictFiles.join(', ')}
              </div>
            )}
            {p.kind === 'failed' && (
              <div className="hq-mono" style={{ color: 'var(--red)', marginTop: 4 }}>{p.error}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
