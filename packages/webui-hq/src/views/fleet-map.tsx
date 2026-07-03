/**
 * FleetMap view — machine → project → terminal → agent tree.
 * The spine of the HQ dashboard. Click a session to open it in Console.
 */
import type React from 'react';
import { useHqStore, selectSession } from '../store.js';
import type { HqSessionSnapshotPayload } from '@wrongstack/core';

export function FleetMapView(): React.ReactElement {
  const state = useHqStore();
  const snap = state.snapshot;

  if (snap === null) {
    return <div className="hq-empty">Waiting for fleet data…</div>;
  }

  const machines = snap.machines ?? [];
  const liveSessions = snap.liveSessions ?? [];

  // Group sessions by machine (hostname key), then by project.
  const byMachine = new Map<string, HqSessionSnapshotPayload[]>();
  for (const s of liveSessions) {
    const key = s.hostname ?? s.machineId;
    const arr = byMachine.get(key) ?? [];
    arr.push(s);
    byMachine.set(key, arr);
  }

  // Include machines with no session yet (connected clients only).
  for (const m of machines) {
    const key = m.hostname ?? m.machineId;
    if (!byMachine.has(key)) byMachine.set(key, []);
  }

  return (
    <div>
      <div className="hq-card-title">Fleet Topology ({machines.length} machines, {liveSessions.length} sessions)</div>
      {Array.from(byMachine.entries()).map(([machineKey, sessions]) => {
        const machine = machines.find((m) => (m.hostname ?? m.machineId) === machineKey);
        return (
          <div key={machineKey} className="hq-card">
            <div className="hq-row">
              <span style={{ fontWeight: 700 }}>🖥 {machine?.hostname ?? machineKey}</span>
              <span className="hq-pill idle">{sessions.length} session(s)</span>
              {machine && <span className="hq-mono" style={{ color: 'var(--dim)' }}>{machine.agentCount} agents</span>}
            </div>
            {sessions.map((s) => {
              const sel = state.selectedSessionId === s.sessionId;
              return (
                <div key={s.sessionId}>
                  <div
                    className={'hq-tree-node' + (sel ? ' sel' : '')}
                    style={{ marginLeft: 20 }}
                    onClick={() => selectSession(s.sessionId)}
                  >
                    <span className="hq-pill" style={{ marginRight: 8 }}>{s.clientKind}</span>
                    <span className="hq-mono">{s.projectName}</span>
                    <span className="hq-mono" style={{ color: 'var(--dim)', marginLeft: 8 }}>{s.gitBranch ?? ''}</span>
                    <span className={'hq-pill ' + (s.status === 'active' ? 'active' : 'idle')} style={{ marginLeft: 8 }}>
                      {s.status}
                    </span>
                  </div>
                  {s.agents.map((a) => (
                    <div key={a.id} className="hq-tree-node" style={{ marginLeft: 44, cursor: 'default' }}>
                      <span style={{ color: 'var(--muted)' }}>●</span>{' '}
                      <span className="hq-mono">{a.name}</span>
                      <span className={'hq-pill ' + a.status} style={{ marginLeft: 8 }}>{a.status}</span>
                      {a.currentTool && <span className="hq-mono" style={{ color: 'var(--cyan)', marginLeft: 6 }}>{a.currentTool}</span>}
                      {typeof a.costUsd === 'number' && a.costUsd > 0 && (
                        <span className="hq-mono" style={{ color: 'var(--green)', marginLeft: 'auto' }}>${a.costUsd.toFixed(3)}</span>
                      )}
                      <span className="hq-mono" style={{ color: 'var(--dim)', marginLeft: 8 }}>ctx {a.ctxPct ?? '?'}%</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
