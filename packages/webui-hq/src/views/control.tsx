/**
 * Control view — staged remote-command composer for connected HQ clients.
 *
 * Flow: pick a target client → pick a command type → compose → preview the
 * exact payload → dispatch (destructive types additionally demand a typed
 * confirm word). Everything dispatched lands in the audit rail on the right,
 * which live-tracks the queued → delivered → acked lifecycle.
 *
 * Only clients advertising `control.receive` are targetable; `run-command`
 * additionally needs the client started with `--hq-allow-exec` and a token
 * carrying `control.execute`.
 */
import {
  AlertTriangle,
  Bot,
  ListPlus,
  MessageSquareText,
  Megaphone,
  OctagonX,
  SquareTerminal,
  Zap,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { fetchJson, postCommand, useHqStore } from '../store.js';
import { setHqControlPrefs, useHqLocalPrefs } from '../stores/hq-local-prefs.js';

type CmdType = 'steer' | 'btw' | 'queue' | 'abort' | 'spawn' | 'broadcast' | 'run-command';
type Stage = 'compose' | 'preview';

interface DraftCommand {
  type: CmdType;
  payload: Record<string, unknown>;
  disabledReason: string | null;
  risk: 'normal' | 'danger';
  summary: string;
}

interface CommandAuditEntry {
  commandId: string;
  type: string;
  clientId: string;
  enqueuedBy: string;
  enqueuedAt: string;
  status: 'queued' | 'delivered' | 'acked' | string;
  ackStatus?: 'accepted' | 'completed' | 'failed' | 'rejected' | string;
  ackMessage?: string;
  ackedAt?: string;
}

interface CommandsResponse {
  commands: CommandAuditEntry[];
}

/** What each command type does — rendered on the type cards so the tab
 *  explains itself instead of presenting seven bare words. */
const CMD_META: Record<
  CmdType,
  { label: string; icon: React.ReactNode; desc: string; danger?: boolean }
> = {
  steer: {
    label: 'steer',
    icon: <Zap size={13} />,
    desc: 'High-priority course correction — interrupts the agent at the next turn.',
  },
  btw: {
    label: 'btw',
    icon: <MessageSquareText size={13} />,
    desc: 'Non-urgent FYI — rides alongside the run without interrupting it.',
  },
  queue: {
    label: 'queue',
    icon: <ListPlus size={13} />,
    desc: 'Queue a prompt — picked up after the current run finishes.',
  },
  abort: {
    label: 'abort',
    icon: <OctagonX size={13} />,
    desc: 'Stop the leader run or every subagent on the client. Destructive.',
    danger: true,
  },
  spawn: {
    label: 'spawn',
    icon: <Bot size={13} />,
    desc: 'Launch a role subagent (bug-hunter, critic, …) with an optional task.',
  },
  broadcast: {
    label: 'broadcast',
    icon: <Megaphone size={13} />,
    desc: 'Mailbox message to every agent in the client’s project.',
  },
  'run-command': {
    label: 'run-command',
    icon: <SquareTerminal size={13} />,
    desc: 'Route a shell command to the client. RCE-gated (--hq-allow-exec + control.execute).',
    danger: true,
  },
};

export function ControlView(): React.ReactElement {
  const { snapshot, selectedClientId } = useHqStore(
    useShallow((s) => ({ snapshot: s.snapshot, selectedClientId: s.selectedClientId })),
  );
  const clients = (snapshot?.clients ?? []).filter((c) =>
    c.capabilities.includes('control.receive'),
  );
  const selected = selectedClientId ?? clients[0]?.clientId ?? null;
  const selectedClient = clients.find((c) => c.clientId === selected) ?? clients[0] ?? null;

  const persisted = useHqLocalPrefs();
  const pctl = persisted.control;

  const [cmdType, setCmdType] = useState<CmdType>(pctl.cmdType);
  const [stage, setStage] = useState<Stage>('compose');
  const [steerTo, setSteerTo] = useState(pctl.steerTo);
  const [steerSubject, setSteerSubject] = useState(pctl.steerSubject);
  const [steerBody, setSteerBody] = useState(pctl.steerBody);
  const [spawnRole, setSpawnRole] = useState(pctl.spawnRole);
  const [spawnTask, setSpawnTask] = useState(pctl.spawnTask);
  const [abortTarget, setAbortTarget] = useState(pctl.abortTarget);
  const [broadcastSubject, setBroadcastSubject] = useState(pctl.broadcastSubject);
  const [broadcastBody, setBroadcastBody] = useState(pctl.broadcastBody);
  const [runCommand, setRunCommand] = useState('');
  const [runCwd, setRunCwd] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [auditEntries, setAuditEntries] = useState<CommandAuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  /** Command id of the most recent dispatch — its audit row flashes so the
   *  eye lands on the lifecycle it should be watching. */
  const [lastDispatchedId, setLastDispatchedId] = useState<string | null>(null);

  const draft = useMemo<DraftCommand>(
    () => buildDraft(),
    [
      cmdType,
      steerTo,
      steerSubject,
      steerBody,
      spawnRole,
      spawnTask,
      abortTarget,
      broadcastSubject,
      broadcastBody,
      runCommand,
      runCwd,
    ],
  );

  const confirmRequired = draft.risk === 'danger';
  const confirmWord = cmdType === 'run-command' ? 'RUN' : 'ABORT';
  const canDispatch =
    selected !== null &&
    draft.disabledReason === null &&
    (!confirmRequired || confirmText === confirmWord);
  const canPreview = draft.disabledReason === null && selected !== null;

  function resetPreview(): void {
    setStage('compose');
    setConfirmText('');
    setError(null);
    setStatus(null);
  }

  function chooseType(type: CmdType): void {
    setCmdType(type);
    setHqControlPrefs({ cmdType: type });
    resetPreview();
  }

  async function loadAudit(): Promise<void> {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const data = await fetchJson<CommandsResponse>('/api/commands?limit=25');
      setAuditEntries(data.commands.slice().reverse());
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuditLoading(false);
    }
  }

  useEffect(() => {
    void loadAudit();
    // Skip refreshes while the tab is hidden — the audit only matters when
    // someone is looking at it.
    const timer = setInterval(() => {
      if (!document.hidden) void loadAudit();
    }, 5_000);
    return () => clearInterval(timer);
  }, []);

  async function dispatch(): Promise<void> {
    if (selected === null || !canDispatch) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await postCommand(selected, draft.type, draft.payload);
      setStatus(`queued ${draft.type} command ${res.commandId}`);
      setLastDispatchedId(res.commandId);
      setStage('compose');
      setConfirmText('');
      void loadAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Ctrl+Enter advances the staged flow: compose → preview → dispatch.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (stage === 'compose' && canPreview) {
        setStage('preview');
        setStatus(null);
        setError(null);
      } else if (stage === 'preview' && canDispatch && !busy) {
        void dispatch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function buildDraft(): DraftCommand {
    if (cmdType === 'steer' || cmdType === 'btw' || cmdType === 'queue') {
      const body = steerBody.trim();
      const verb =
        cmdType === 'steer'
          ? 'Send high-priority steer to'
          : cmdType === 'btw'
            ? 'Post a non-urgent FYI (btw) to'
            : 'Queue a prompt for';
      return {
        type: cmdType,
        payload: {
          to: steerTo || 'leader',
          subject: steerSubject || `HQ ${cmdType}`,
          body: steerBody,
          priority: cmdType === 'steer' ? 'high' : 'normal',
        },
        disabledReason: body.length === 0 ? 'Message body is required.' : null,
        risk: 'normal',
        summary: `${verb} ${steerTo || 'leader'}.`,
      };
    }
    if (cmdType === 'run-command') {
      const cmd = runCommand.trim();
      return {
        type: 'run-command',
        payload: { command: runCommand, ...(runCwd.trim() ? { cwd: runCwd.trim() } : {}) },
        disabledReason: cmd.length === 0 ? 'Command is required.' : null,
        risk: 'danger',
        summary:
          'Route a shell command to the client (requires --hq-allow-exec + control.execute; delivered as a steer, the agent’s permission policy still applies).',
      };
    }
    if (cmdType === 'abort') {
      return {
        type: 'abort',
        payload: { target: abortTarget },
        disabledReason: null,
        risk: 'danger',
        summary:
          abortTarget === 'fleet'
            ? 'Abort all subagents on the selected client.'
            : 'Abort the selected target on the selected client.',
      };
    }
    if (cmdType === 'spawn') {
      const task = spawnTask.trim();
      return {
        type: 'spawn',
        payload: { role: spawnRole, ...(task ? { task } : {}) },
        disabledReason: spawnRole.trim().length === 0 ? 'Role is required.' : null,
        risk: 'normal',
        summary: `Spawn a ${spawnRole} subagent${task ? ' with an initial task' : ''}.`,
      };
    }
    const body = broadcastBody.trim();
    return {
      type: 'broadcast',
      payload: {
        subject: broadcastSubject || 'HQ broadcast',
        body: broadcastBody,
        priority: 'normal',
      },
      disabledReason: body.length === 0 ? 'Broadcast body is required.' : null,
      risk: 'normal',
      summary: 'Broadcast a normal-priority mailbox message to the selected client project.',
    };
  }

  if (clients.length === 0) {
    return (
      <div className="hq-empty">
        No controllable clients connected. Clients must advertise the <code>control.receive</code>{' '}
        capability (CLI/TUI/WebUI surfaces do this automatically when connected to HQ).
      </div>
    );
  }

  return (
    <div className="hq-control-grid">
      <div className="hq-control-composer">
        <div className="hq-card-title">Command Target</div>
        <div className="hq-card hq-control-target">
          <label className="hq-label" htmlFor="hq-control-client">
            Client
          </label>
          <select
            id="hq-control-client"
            className="hq-select"
            value={selected ?? ''}
            onChange={(e) => {
              useHqStore.getState().selectClient(e.target.value);
              resetPreview();
            }}
          >
            {clients.map((c) => (
              <option key={c.clientId} value={c.clientId}>
                {c.kind} — {c.hostname ?? c.clientId} ({c.projectId})
              </option>
            ))}
          </select>
          {selectedClient !== null && (
            <div className="hq-control-meta">
              <span>
                <strong>kind</strong> {selectedClient.kind}
              </span>
              <span>
                <strong>host</strong> {selectedClient.hostname ?? 'unknown'}
              </span>
              <span>
                <strong>project</strong> {selectedClient.projectId}
              </span>
              <span>
                <strong>client</strong> {shortId(selectedClient.clientId)}
              </span>
            </div>
          )}
        </div>

        <div className="hq-card-title">Command Type</div>
        <fieldset className="hq-control-steps" aria-label="Control command stages">
          <span className="hq-step active">1 compose</span>
          <span className={'hq-step' + (stage === 'preview' ? ' active' : '')}>2 preview</span>
          <span className={'hq-step' + (status !== null ? ' active' : '')}>3 queued</span>
        </fieldset>
        <div className="hq-control-types">
          {(Object.keys(CMD_META) as CmdType[]).map((t) => {
            const meta = CMD_META[t];
            return (
              <button
                key={t}
                type="button"
                title={meta.desc}
                className={
                  'hq-control-type' +
                  (cmdType === t ? ' selected' : '') +
                  (meta.danger === true ? ' danger' : '')
                }
                onClick={() => chooseType(t)}
              >
                {meta.icon}
                {meta.label}
              </button>
            );
          })}
        </div>
        <div className="hq-control-typedesc">
          {CMD_META[cmdType].danger === true && <AlertTriangle size={12} />}
          {CMD_META[cmdType].desc}
        </div>

        <div className="hq-mt-12">
          {(cmdType === 'steer' || cmdType === 'btw' || cmdType === 'queue') && (
            <div className="hq-card">
              <label className="hq-label" htmlFor="hq-control-recipient">
                To (agent address — e.g. <code>leader</code>, <code>leader@sessionTag</code>, or a
                subagent id)
              </label>
              <input
                id="hq-control-recipient"
                className="hq-input"
                value={steerTo}
                onChange={(e) => {
                  setSteerTo(e.target.value);
                  setHqControlPrefs({ steerTo: e.target.value });
                }}
                placeholder="leader"
              />
              <label className="hq-label hq-mt-8" htmlFor="hq-control-subject">
                Subject
              </label>
              <input
                id="hq-control-subject"
                className="hq-input"
                value={steerSubject}
                onChange={(e) => {
                  setSteerSubject(e.target.value);
                  setHqControlPrefs({ steerSubject: e.target.value });
                }}
              />
              <label className="hq-label hq-mt-8" htmlFor="hq-control-body">
                Body
              </label>
              <textarea
                id="hq-control-body"
                className="hq-textarea"
                value={steerBody}
                onChange={(e) => {
                  setSteerBody(e.target.value);
                  setHqControlPrefs({ steerBody: e.target.value });
                }}
              />
            </div>
          )}

          {cmdType === 'abort' && (
            <div className="hq-card hq-card-danger">
              <label className="hq-label" htmlFor="hq-control-abort-target">
                Target
              </label>
              <select
                id="hq-control-abort-target"
                className="hq-select"
                value={abortTarget}
                onChange={(e) => {
                  setAbortTarget(e.target.value as 'leader' | 'fleet');
                  setHqControlPrefs({ abortTarget: e.target.value as 'leader' | 'fleet' });
                }}
              >
                <option value="leader">leader (session leader)</option>
                <option value="fleet">fleet (all subagents)</option>
              </select>
              <div className="hq-control-warning">
                Abort is destructive. Preview requires typing <strong>ABORT</strong> before
                dispatch.
              </div>
            </div>
          )}

          {cmdType === 'spawn' && (
            <div className="hq-card">
              <label className="hq-label" htmlFor="hq-control-spawn-role">
                Role
              </label>
              <select
                id="hq-control-spawn-role"
                className="hq-select"
                value={spawnRole}
                onChange={(e) => {
                  setSpawnRole(e.target.value);
                  setHqControlPrefs({ spawnRole: e.target.value });
                }}
              >
                <option value="bug-hunter">bug-hunter</option>
                <option value="refactor-planner">refactor-planner</option>
                <option value="critic">critic</option>
                <option value="security-scanner">security-scanner</option>
                <option value="code-reviewer">code-reviewer</option>
              </select>
              <label className="hq-label hq-mt-8" htmlFor="hq-control-spawn-task">
                Task (optional)
              </label>
              <textarea
                id="hq-control-spawn-task"
                className="hq-textarea"
                value={spawnTask}
                onChange={(e) => {
                  setSpawnTask(e.target.value);
                  setHqControlPrefs({ spawnTask: e.target.value });
                }}
                placeholder="Describe the task…"
              />
            </div>
          )}

          {cmdType === 'run-command' && (
            <div className="hq-card hq-card-danger">
              <label className="hq-label" htmlFor="hq-control-run-command">
                Shell command
              </label>
              <textarea
                id="hq-control-run-command"
                className="hq-textarea"
                value={runCommand}
                onChange={(e) => setRunCommand(e.target.value)}
                placeholder="pnpm test"
              />
              <label className="hq-label hq-mt-8" htmlFor="hq-control-run-cwd">
                Working directory (optional — defaults to the agent's project root)
              </label>
              <input
                id="hq-control-run-cwd"
                className="hq-input"
                value={runCwd}
                onChange={(e) => setRunCwd(e.target.value)}
                placeholder=""
              />
              <div className="hq-control-warning">
                RCE-gated: the client must run with <code>--hq-allow-exec</code> and your token
                needs the <code>control.execute</code> capability — otherwise the server rejects
                this. Preview requires typing <strong>RUN</strong> before dispatch.
              </div>
            </div>
          )}

          {cmdType === 'broadcast' && (
            <div className="hq-card">
              <label className="hq-label" htmlFor="hq-control-broadcast-subject">
                Subject
              </label>
              <input
                id="hq-control-broadcast-subject"
                className="hq-input"
                value={broadcastSubject}
                onChange={(e) => {
                  setBroadcastSubject(e.target.value);
                  setHqControlPrefs({ broadcastSubject: e.target.value });
                }}
              />
              <label
                className="hq-label hq-mt-8"
                htmlFor="hq-control-broadcast-body"
              >
                Body
              </label>
              <textarea
                id="hq-control-broadcast-body"
                className="hq-textarea"
                value={broadcastBody}
                onChange={(e) => {
                  setBroadcastBody(e.target.value);
                  setHqControlPrefs({ broadcastBody: e.target.value });
                }}
              />
            </div>
          )}
        </div>

        <div className="hq-card-title">Dispatch Gate</div>
        <div
          className={
            'hq-card hq-command-preview' + (draft.risk === 'danger' ? ' hq-card-danger' : '')
          }
        >
          <div className="hq-row">
            <span className={'hq-pill ' + (draft.risk === 'danger' ? 'error' : 'info')}>
              {draft.risk}
            </span>
            <span>{draft.summary}</span>
            {draft.disabledReason !== null && (
              <span className="hq-pill warn">{draft.disabledReason}</span>
            )}
          </div>
          {stage === 'preview' ? (
            <>
              <div className="hq-msg-sublabel">payload preview</div>
              <pre className="hq-msg-pre">
                {JSON.stringify(
                  { clientId: selected, type: draft.type, payload: draft.payload },
                  null,
                  2,
                )}
              </pre>
              {confirmRequired && (
                <>
                  <label
                    className="hq-label hq-mt-12"
                    htmlFor="hq-control-confirm"
                  >
                    Confirm destructive dispatch
                  </label>
                  <input
                    id="hq-control-confirm"
                    className="hq-input"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder={`Type ${confirmWord}`}
                  />
                </>
              )}
              <div className="hq-row hq-mt-12">
                <button
                  type="button"
                  className="hq-btn"
                  disabled={busy || !canDispatch}
                  onClick={() => void dispatch()}
                  title="Ctrl+Enter"
                >
                  {busy ? 'Dispatching…' : 'Dispatch Command'}
                </button>
                <button
                  type="button"
                  className="hq-btn secondary"
                  disabled={busy}
                  onClick={resetPreview}
                >
                  Back to Compose
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              className="hq-btn"
              disabled={!canPreview}
              onClick={() => {
                setStage('preview');
                setStatus(null);
                setError(null);
              }}
              title="Ctrl+Enter"
            >
              Preview Command
            </button>
          )}
        </div>

        {status && (
          <div className="hq-pill active hq-mt-12">
            {status}
          </div>
        )}
        {error && (
          <div className="hq-pill error hq-mt-12">
            {error}
          </div>
        )}
      </div>

      <div className="hq-control-audit">
        <div className="hq-card-title">Command Audit</div>
        <div className="hq-card hq-command-audit">
          <div className="hq-row">
            <span className="hq-pill info">recent {auditEntries.length}</span>
            {auditLoading && <span className="hq-pill idle">refreshing</span>}
            {auditError !== null && <span className="hq-pill error">{auditError}</span>}
            <button
              type="button"
              className="hq-btn secondary hq-ml-auto"
              onClick={() => void loadAudit()}
            >
              Refresh
            </button>
          </div>
          {auditEntries.length === 0 ? (
            <div className="hq-empty hq-cockpit-empty">
              No command audit entries yet.
            </div>
          ) : (
            <div className="hq-audit-list">
              {auditEntries.map((entry) => (
                <div
                  key={entry.commandId}
                  className={
                    'hq-audit-row' +
                    (entry.commandId === lastDispatchedId ? ' just-dispatched' : '') +
                    (selected !== null && entry.clientId === selected ? '' : ' other-client')
                  }
                >
                  <div className="hq-audit-main">
                    <span className={'hq-pill ' + auditTone(entry)}>{entry.status}</span>
                    <span className="hq-pill info">{entry.type}</span>
                    <span className="hq-mono">{shortId(entry.commandId)}</span>
                    {entry.ackStatus !== undefined && (
                      <span className={'hq-pill ' + ackTone(entry.ackStatus)}>
                        ack {entry.ackStatus}
                      </span>
                    )}
                  </div>
                  <div className="hq-audit-meta">
                    <span>
                      <strong>client</strong> {shortId(entry.clientId)}
                    </span>
                    <span>
                      <strong>by</strong> {entry.enqueuedBy}
                    </span>
                    <span>
                      <strong>queued</strong> {relativeTime(entry.enqueuedAt)}
                    </span>
                    {entry.ackedAt !== undefined && (
                      <span>
                        <strong>acked</strong> {relativeTime(entry.ackedAt)}
                      </span>
                    )}
                  </div>
                  {entry.ackMessage !== undefined && entry.ackMessage.length > 0 && (
                    <div className="hq-audit-message">{entry.ackMessage}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

/** "12s ago" / "3m ago" / clock time past an hour — audit rows are about
 *  recency, and absolute clock times force mental subtraction. */
export function relativeTime(ts: string, now = Date.now()): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const delta = Math.max(0, now - date.getTime());
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return date.toLocaleTimeString();
}

function auditTone(entry: CommandAuditEntry): 'active' | 'info' | 'idle' | 'error' | 'warn' {
  if (entry.ackStatus === 'failed' || entry.ackStatus === 'rejected') return 'error';
  if (entry.status === 'acked') return 'active';
  if (entry.status === 'delivered') return 'info';
  if (entry.status === 'queued') return 'warn';
  return 'idle';
}

function ackTone(ackStatus: string): 'active' | 'error' | 'info' {
  if (ackStatus === 'failed' || ackStatus === 'rejected') return 'error';
  if (ackStatus === 'completed') return 'active';
  return 'info';
}
