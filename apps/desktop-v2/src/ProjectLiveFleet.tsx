import type { ApiSession } from '@wrongstack/webui-protocol';
import { Background, Controls, type Edge, type Node, ReactFlow } from '@xyflow/react';
import { Network, RefreshCw, Search, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EngineHttp } from './engine-http';
import { record } from './engine-values';
import { FleetActivity } from './FleetActivity';
import { FleetBroadcast } from './FleetBroadcast';
import { fleetMailboxAddress, fleetNodeId, projectFleet } from './live-fleet-model';
import { Modal } from './Modal';
import type { Session } from './model';
import { request } from './platform';
import '@xyflow/react/dist/style.css';
import './project-live-fleet.css';

export function ProjectLiveFleet({
  http,
  projectRoot,
  carrierId,
  nativeSessions,
}: {
  http: EngineHttp;
  projectRoot: string;
  carrierId: string;
  nativeSessions: Session[];
}) {
  const [sessions, setSessions] = useState<ApiSession[]>([]),
    [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [loadError, setLoadError] = useState(''),
    [query, setQuery] = useState(''),
    [map, setMap] = useState(true),
    [selection, setSelection] = useState<{ sessionId: string; agentId?: string } | null>(null),
    [review, setReview] = useState<'message' | 'interrupt' | null>(null),
    [drafts, setDrafts] = useState<
      Record<
        string,
        Partial<Record<'message' | 'interrupt' | 'subject' | 'priority' | 'type', string>>
      >
    >({}),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState('');
  const [sessionNames, setSessionNames] = useState<Record<string, string>>({});
  const nativeKey = JSON.stringify(
    nativeSessions
      .filter((session) => session.kind === 'agent' && session.status === 'running')
      .map((session) => ({ id: session.id, title: session.title })),
  );
  const alive = useRef(true),
    reading = useRef(false),
    acting = useRef(false),
    reviewTarget = useRef<ApiSession | null>(null),
    readSequence = useRef(0);
  useEffect(() => {
    let stopped = false;
    const candidates = JSON.parse(nativeKey) as { id: string; title: string }[];
    void Promise.allSettled(
      candidates.map(async (session) => {
        const identity = await request<Record<string, unknown>>('engine.identity', {
          id: session.id,
        });
        return typeof identity['sessionId'] === 'string'
          ? ([identity['sessionId'], session.title] as const)
          : null;
      }),
    ).then((results) => {
      if (!stopped)
        setSessionNames(
          Object.fromEntries(
            results.flatMap((result) =>
              result.status === 'fulfilled' && result.value ? [result.value] : [],
            ),
          ),
        );
    });
    return () => {
      stopped = true;
    };
  }, [nativeKey]);
  const read = useCallback(
    async () => projectFleet(await http('/api/sessions'), projectRoot, carrierId),
    [http, projectRoot, carrierId],
  );
  const load = useCallback(async () => {
    if (reading.current || !carrierId) return;
    reading.current = true;
    const sequence = ++readSequence.current;
    setLoading(true);
    try {
      const rows = await read();
      if (alive.current && sequence === readSequence.current) {
        setSessions(rows);
        setLoaded(true);
        setLoadError('');
      }
    } catch (error) {
      if (alive.current && sequence === readSequence.current)
        setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      reading.current = false;
      if (alive.current && sequence === readSequence.current) setLoading(false);
    }
  }, [read, carrierId]);
  useEffect(() => {
    alive.current = true;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load();
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      alive.current = false;
      readSequence.current++;
      stopped = true;
      clearTimeout(timer);
    };
  }, [load]);
  const visible = sessions.filter((session) =>
    `${sessionNames[session.sessionId] ?? ''} ${session.sessionId} ${session.status} ${session.agents.map((agent) => `${agent.name} ${agent.id} ${agent.currentTool ?? ''}`).join(' ')}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const selectedSession = sessions.find((session) => session.sessionId === selection?.sessionId),
    selectedAgent = selectedSession?.agents.find((agent) => agent.id === selection?.agentId);
  const draftOwner = reviewTarget.current?.sessionId ?? selection?.sessionId ?? '';
  const text = drafts[draftOwner]?.[review ?? 'message'] ?? '';
  const type = drafts[draftOwner]?.type ?? 'note',
    priority = drafts[draftOwner]?.priority ?? 'high',
    subject = drafts[draftOwner]?.subject ?? '';
  const setField = (field: 'type' | 'priority' | 'subject', value: string) =>
    setDrafts((current) => ({
      ...current,
      [draftOwner]: { ...current[draftOwner], [field]: value },
    }));
  const setText = (value: string) =>
    setDrafts((current) => ({
      ...current,
      [draftOwner]: { ...current[draftOwner], [review ?? 'message']: value },
    }));
  const graph = useMemo(() => {
    const nodes: Node[] = [],
      edges: Edge[] = [];
    for (const [index, session] of visible.slice(0, 40).entries()) {
      const parent = fleetNodeId(session.sessionId);
      nodes.push({
        id: parent,
        selected: selection?.sessionId === session.sessionId && selection.agentId === undefined,
        position: { x: index * 300, y: 0 },
        data: {
          label: (
            <div>
              <strong>
                {sessionNames[session.sessionId] ??
                  `Session · ${session.sessionId.split('/').at(-1)?.slice(-12)}`}
              </strong>
              <small>
                {session.status} · {session.agents.length}{' '}
                {session.agents.length === 1 ? 'agent' : 'agents'}
              </small>
            </div>
          ),
        },
        style: {
          width: 250,
          background: 'var(--accent-soft)',
          color: 'var(--text)',
          borderColor: 'var(--accent)',
          borderRadius: 8,
        },
      });
      for (const [row, agent] of session.agents.slice(0, 20).entries()) {
        const id = fleetNodeId(session.sessionId, agent.id);
        nodes.push({
          id,
          selected: selection?.sessionId === session.sessionId && selection.agentId === agent.id,
          position: { x: index * 300, y: 130 + row * 110 },
          data: {
            label: (
              <div>
                <strong>{agent.name}</strong>
                <small>
                  {agent.status}
                  {agent.currentTool ? ` · ${agent.currentTool}` : ''}
                </small>
              </div>
            ),
          },
          style: {
            width: 240,
            background: 'var(--raised)',
            color: 'var(--text)',
            borderColor: 'var(--border)',
            borderRadius: 8,
          },
        });
        edges.push({
          id,
          source: parent,
          target: id,
          type: 'smoothstep',
          style: { stroke: 'var(--accent)' },
        });
      }
    }
    return { nodes, edges };
  }, [visible, sessionNames, selection]);
  const act = async () => {
    const target = reviewTarget.current;
    if (!target || !review || acting.current) return;
    acting.current = true;
    setPending(true);
    setError('');
    setNotice('');
    try {
      const current = (await read()).find((row) => row.sessionId === target.sessionId);
      if (!current || current.pid !== target.pid || current.startedAt !== target.startedAt)
        throw Error('The selected runtime changed or exited. No request was sent.');
      const result = record(
        await http(
          `/api/sessions/${encodeURIComponent(current.sessionId)}/${review}`,
          'POST',
          review === 'message'
            ? {
                text: text.trim(),
                type,
                from: 'human@desktop',
                priority,
                ...(subject.trim() ? { subject: subject.trim() } : {}),
              }
            : {
                reason: text.trim() || 'Desktop operator requested interruption',
                from: 'human@desktop',
              },
        ),
      );
      if (
        result['ok'] !== true ||
        result['to'] !== (await fleetMailboxAddress(current.sessionId)) ||
        typeof result['id'] !== 'string'
      )
        throw Error(
          'The engine returned an unrecognized delivery receipt. Refresh before retrying.',
        );
      if (alive.current) {
        setNotice(
          `Request delivered to session mailbox · receipt ${result['id']}. Execution or interruption is not confirmed by delivery alone.`,
        );
        setText('');
        setReview(null);
        await load();
      }
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      acting.current = false;
      if (alive.current) setPending(false);
    }
  };
  return (
    <section className="project-live-fleet" aria-label="Project live fleet">
      <header>
        <div>
          <span className="eyebrow">PROJECT EXECUTION</span>
          <h2>Live fleet</h2>
          <p>
            Actual registered runtimes and agents in this project. The role catalog remains in Agent
            Roster.
          </p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={loading || pending}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
          Refresh live fleet
        </button>
      </header>
      {sessions.length > 0 && <FleetBroadcast http={http} read={read} onSent={() => void load()} />}
      <div className="live-fleet-metrics">
        <span>
          <strong>{sessions.length}</strong> runtimes
        </span>
        <span>
          <strong>{sessions.reduce((sum, session) => sum + session.agents.length, 0)}</strong>{' '}
          registered agents
        </span>
        <small>
          {loadError
            ? 'Refresh failed; last loaded snapshot retained'
            : 'Registry refreshes every 3 seconds'}
        </small>
      </div>
      {loadError && (
        <p className="session-error" role="alert">
          {loadError}
        </p>
      )}
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="feature-notice" role="status">
          {notice}
        </p>
      )}
      <div className="live-fleet-toolbar">
        <label>
          <Search size={14} />
          <input
            aria-label="Search live fleet"
            placeholder="Session, agent or current tool…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="feature-actions">
          <button
            type="button"
            className="button secondary"
            aria-pressed={map}
            onClick={() => setMap(true)}
          >
            <Network size={14} />
            Execution map
          </button>
          <button
            type="button"
            className="button secondary"
            aria-pressed={!map}
            onClick={() => setMap(false)}
          >
            <Users size={14} />
            Runtime list
          </button>
        </div>
      </div>
      {!loaded ? (
        <p role="status">
          {loadError ? 'Live registry unavailable. Refresh to retry.' : 'Reading project runtimes…'}
        </p>
      ) : !visible.length ? (
        <div className="live-fleet-empty">
          <Network size={32} />
          <h3>
            {sessions.length ? 'No matching runtimes.' : 'No registered conversation runtimes.'}
          </h3>
          <p>Opening this workspace does not create a conversation or start a worker.</p>
        </div>
      ) : (
        <>
          {map && (
            <>
              <p className="live-fleet-caption">
                Connections show recorded session membership. They do not assert delegation or
                parent-agent relationships. The map shows up to 40 runtimes and 20 agents per
                runtime; the list retains all records.
              </p>
              <div className="live-fleet-map">
                <ReactFlow
                  nodes={graph.nodes}
                  edges={graph.edges}
                  fitView
                  fitViewOptions={{ maxZoom: 1 }}
                  minZoom={0.1}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  onNodeClick={(_, node) => {
                    const [sessionId, agentId] = JSON.parse(node.id);
                    setSelection({ sessionId, ...(agentId ? { agentId } : {}) });
                  }}
                >
                  <Background color="var(--border)" />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </div>
            </>
          )}
          {!map && (
            <div className="live-fleet-list">
              {visible.map((session) => (
                <article key={session.sessionId}>
                  <header>
                    <button
                      type="button"
                      className="text-link"
                      data-live-session={session.sessionId}
                      onClick={() => setSelection({ sessionId: session.sessionId })}
                    >
                      {sessionNames[session.sessionId] ? (
                        <>
                          <strong>{sessionNames[session.sessionId]}</strong>
                          <small>{session.sessionId}</small>
                        </>
                      ) : (
                        session.sessionId
                      )}
                    </button>
                    <span>
                      {session.status} · PID {session.pid}
                    </span>
                  </header>
                  {session.agents.map((agent) => (
                    <button
                      type="button"
                      key={agent.id}
                      onClick={() =>
                        setSelection({ sessionId: session.sessionId, agentId: agent.id })
                      }
                    >
                      <strong>{agent.name}</strong>
                      <span>
                        {agent.status}
                        {agent.currentTool ? ` · ${agent.currentTool}` : ''}
                      </span>
                      <small>
                        {agent.iterations} iterations · {agent.toolCalls} tool calls
                      </small>
                    </button>
                  ))}
                  {!session.agents.length && (
                    <p className="quiet-state">No agents have been recorded for this runtime.</p>
                  )}
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {selection && (
        <aside className="live-fleet-inspector" aria-label="Live fleet detail">
          <header>
            <h3>{selectedAgent?.name ?? 'Runtime detail'}</h3>
            <button
              type="button"
              className="button secondary small"
              disabled={pending}
              onClick={() => {
                if (!pending) setSelection(null);
              }}
            >
              Close detail
            </button>
          </header>
          {selectedSession ? (
            <>
              <dl>
                <dt>Core session</dt>
                <dd>{selectedSession.sessionId}</dd>
                <dt>Status</dt>
                <dd>{selectedAgent?.status ?? selectedSession.status}</dd>
                <dt>Process</dt>
                <dd>PID {selectedSession.pid}</dd>
                <dt>Started</dt>
                <dd>{new Date(selectedSession.startedAt).toLocaleString()}</dd>
                <dt>Last heartbeat</dt>
                <dd>{new Date(selectedSession.lastHeartbeatAt).toLocaleString()}</dd>
                {selectedAgent && (
                  <>
                    <dt>Agent ID</dt>
                    <dd>{selectedAgent.id}</dd>
                    <dt>Activity</dt>
                    <dd>{selectedAgent.currentTool ?? 'No current tool reported'}</dd>
                    <dt>Iterations / tools</dt>
                    <dd>
                      {selectedAgent.iterations} / {selectedAgent.toolCalls}
                    </dd>
                  </>
                )}
              </dl>
              <p>
                Controls address this runtime's session mailbox, including when an agent is
                selected.
              </p>
              <div className="feature-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={pending}
                  onClick={() => {
                    reviewTarget.current = selectedSession;
                    setReview('message');
                  }}
                >
                  Send session instruction
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={pending}
                  onClick={() => {
                    reviewTarget.current = selectedSession;
                    setReview('interrupt');
                  }}
                >
                  Request session interruption
                </button>
              </div>
              <FleetActivity
                key={selectedSession.sessionId}
                http={http}
                sessionId={selectedSession.sessionId}
              />
            </>
          ) : (
            <p className="quiet-state">
              This runtime is no longer in the current project snapshot.
            </p>
          )}
        </aside>
      )}
      {review && (
        <Modal
          title={
            review === 'message' ? 'Review session instruction' : 'Review session interruption'
          }
          onClose={() => {
            if (!pending) setReview(null);
          }}
        >
          <div className="live-fleet-review">
            <h2>
              {review === 'message' ? 'Send instruction to this session?' : 'Request interruption?'}
            </h2>
            <code>{selectedSession?.sessionId ?? selection?.sessionId}</code>
            <p>
              The engine delivers a request to this session's mailbox. Delivery does not confirm
              that the agent has acted on it.
            </p>
            {review === 'message' && (
              <label>
                Delivery kind
                <select
                  aria-label="Fleet instruction kind"
                  disabled={pending}
                  value={type}
                  onChange={(event) => setField('type', event.target.value)}
                >
                  {['note', 'steer', 'btw', 'ask', 'assign'].map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {review === 'message' && (
              <>
                <label>
                  Priority
                  <select
                    aria-label="Fleet instruction priority"
                    value={priority}
                    onChange={(event) => setField('priority', event.target.value)}
                    disabled={pending}
                  >
                    {['low', 'normal', 'high'].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Subject (optional)
                  <input
                    aria-label="Fleet instruction subject"
                    value={subject}
                    maxLength={256}
                    onChange={(event) => setField('subject', event.target.value)}
                    disabled={pending}
                  />
                </label>
              </>
            )}
            <label>
              {review === 'message' ? 'Instruction' : 'Reason'}
              <textarea
                aria-label="Fleet request text"
                rows={5}
                value={text}
                onChange={(event) => setText(event.target.value)}
                maxLength={16000}
                disabled={pending}
              />
            </label>
            {error && (
              <p className="session-error" role="alert">
                {error}
              </p>
            )}
            <div className="feature-actions">
              <button
                type="button"
                className="button secondary"
                disabled={pending}
                onClick={() => setReview(null)}
              >
                Keep reviewing fleet
              </button>
              <button
                type="button"
                className="button primary"
                disabled={pending || !selectedSession || (review === 'message' && !text.trim())}
                onClick={() => void act()}
              >
                Confirm session request
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
