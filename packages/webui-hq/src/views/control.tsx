/**
 * Control view — enqueue commands to connected clients (steer/abort/spawn/broadcast).
 * Only clients advertising `control.receive` are targetable.
 */
import type React from 'react';
import { useState } from 'react';
import { useHqStore, selectClient, postCommand } from '../store.js';

type CmdType = 'steer' | 'abort' | 'spawn' | 'broadcast';

export function ControlView(): React.ReactElement {
  const state = useHqStore();
  const clients = (state.snapshot?.clients ?? []).filter((c) => c.capabilities.includes('control.receive'));
  const selected = state.selectedClientId ?? clients[0]?.clientId ?? null;

  const [cmdType, setCmdType] = useState<CmdType>('steer');
  const [steerTo, setSteerTo] = useState('leader');
  const [steerSubject, setSteerSubject] = useState('');
  const [steerBody, setSteerBody] = useState('');
  const [spawnRole, setSpawnRole] = useState('bug-hunter');
  const [abortTarget, setAbortTarget] = useState('leader');
  const [broadcastSubject, setBroadcastSubject] = useState('');
  const [broadcastBody, setBroadcastBody] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(payload: Record<string, unknown>, type: string): Promise<void> {
    if (selected === null) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await postCommand(selected, type, payload);
      setStatus(`✓ Queued (command ${res.commandId})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (clients.length === 0) {
    return (
      <div className="hq-empty">
        No controllable clients connected. Clients must advertise the <code>control.receive</code> capability
        (CLI/TUI/WebUI surfaces do this automatically when connected to HQ).
      </div>
    );
  }

  return (
    <div>
      <div className="hq-card-title">Target Client</div>
      <select
        className="hq-select"
        value={selected ?? ''}
        onChange={(e) => selectClient(e.target.value)}
      >
        {clients.map((c) => (
          <option key={c.clientId} value={c.clientId}>
            {c.kind} — {c.hostname ?? c.clientId} ({c.projectId})
          </option>
        ))}
      </select>

      <div className="hq-card-title" style={{ marginTop: 16 }}>Command Type</div>
      <div className="hq-row">
        {(['steer', 'abort', 'spawn', 'broadcast'] as CmdType[]).map((t) => (
          <button
            key={t}
            className={'hq-btn secondary' + (cmdType === t ? '' : ' faded')}
            style={{ opacity: cmdType === t ? 1 : 0.5 }}
            onClick={() => setCmdType(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        {cmdType === 'steer' && (
          <div className="hq-card">
            <label className="hq-label">To (agent address — e.g. <code>leader</code>, <code>leader@sessionTag</code>, or a subagent id)</label>
            <input className="hq-input" value={steerTo} onChange={(e) => setSteerTo(e.target.value)} placeholder="leader" />
            <label className="hq-label" style={{ marginTop: 8 }}>Subject</label>
            <input className="hq-input" value={steerSubject} onChange={(e) => setSteerSubject(e.target.value)} />
            <label className="hq-label" style={{ marginTop: 8 }}>Body</label>
            <textarea className="hq-textarea" value={steerBody} onChange={(e) => setSteerBody(e.target.value)} />
            <button
              className="hq-btn"
              style={{ marginTop: 8 }}
              disabled={busy || steerBody.length === 0}
              onClick={() => send({ to: steerTo || 'leader', subject: steerSubject || 'HQ steer', body: steerBody, priority: 'high' }, 'steer')}
            >
              {busy ? 'Sending…' : 'Send Steer'}
            </button>
          </div>
        )}

        {cmdType === 'abort' && (
          <div className="hq-card">
            <label className="hq-label">Target</label>
            <select className="hq-select" value={abortTarget} onChange={(e) => setAbortTarget(e.target.value)}>
              <option value="leader">leader (session leader)</option>
              <option value="fleet">fleet (all subagents)</option>
            </select>
            <button
              className="hq-btn danger"
              style={{ marginTop: 8 }}
              disabled={busy}
              onClick={() => send({ target: abortTarget }, 'abort')}
            >
              {busy ? 'Sending…' : 'Abort'}
            </button>
          </div>
        )}

        {cmdType === 'spawn' && (
          <div className="hq-card">
            <label className="hq-label">Role</label>
            <select className="hq-select" value={spawnRole} onChange={(e) => setSpawnRole(e.target.value)}>
              <option value="bug-hunter">bug-hunter</option>
              <option value="refactor-planner">refactor-planner</option>
              <option value="critic">critic</option>
            </select>
            <label className="hq-label" style={{ marginTop: 8 }}>Task (optional)</label>
            <textarea className="hq-textarea" value={steerBody} onChange={(e) => setSteerBody(e.target.value)} placeholder="Describe the task…" />
            <button
              className="hq-btn"
              style={{ marginTop: 8 }}
              disabled={busy}
              onClick={() => send({ role: spawnRole, ...(steerBody ? { task: steerBody } : {}) }, 'spawn')}
            >
              {busy ? 'Sending…' : 'Spawn Agent'}
            </button>
          </div>
        )}

        {cmdType === 'broadcast' && (
          <div className="hq-card">
            <label className="hq-label">Subject</label>
            <input className="hq-input" value={broadcastSubject} onChange={(e) => setBroadcastSubject(e.target.value)} />
            <label className="hq-label" style={{ marginTop: 8 }}>Body</label>
            <textarea className="hq-textarea" value={broadcastBody} onChange={(e) => setBroadcastBody(e.target.value)} />
            <button
              className="hq-btn"
              style={{ marginTop: 8 }}
              disabled={busy || broadcastBody.length === 0}
              onClick={() => send({ subject: broadcastSubject || 'HQ broadcast', body: broadcastBody, priority: 'normal' }, 'broadcast')}
            >
              {busy ? 'Sending…' : 'Broadcast'}
            </button>
          </div>
        )}
      </div>

      {status && <div className="hq-pill active" style={{ marginTop: 12 }}>{status}</div>}
      {error && <div className="hq-pill error" style={{ marginTop: 12 }}>{error}</div>}
    </div>
  );
}
