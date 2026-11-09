import { AgentRuntimeBadge } from '@wrongstack/project-surfaces/ui/AgentRuntimeBadge';
import type { ApiSession } from '@wrongstack/webui-protocol';
import { Background, Controls, type Edge, type Node, ReactFlow } from '@xyflow/react';
import { Network, RefreshCw, Search, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import type { EngineHttp } from './engine-http';
import { record } from './engine-values';
import { FleetActivity } from './FleetActivity';
import { FleetBroadcast } from './FleetBroadcast';
import { fleetMailboxAddress, fleetNodeId, projectFleet } from './live-fleet-model';
import { Modal } from './Modal';
import type { Session } from './model';
import { request } from './platform';
import { surfaceI18n } from './surface-i18n';
import '@xyflow/react/dist/style.css';
import './project-live-fleet.css';
import { displayDateTime } from './display-dates';

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
  const { t } = useDesktopText();
  // Read through a ref so a language change does not restart the registry polling.
  const words = useRef(t);
  words.current = t;
  const status = (value: string) => t(`liveFleet.status.${value}`, { defaultValue: value });
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
    async () =>
      projectFleet(await http('/api/sessions'), projectRoot, carrierId, {
        catalog: words.current('liveFleet.invalid.catalog'),
        records: words.current('liveFleet.invalid.records'),
        session: words.current('liveFleet.invalid.session'),
        agent: words.current('liveFleet.invalid.agent'),
      }),
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
  const agentCount = sessions.reduce((sum, session) => sum + session.agents.length, 0);
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
                  t('liveFleet.sessionNode', {
                    id: session.sessionId.split('/').at(-1)?.slice(-12),
                  })}
              </strong>
              <small>
                {t(
                  session.agents.length === 1
                    ? 'liveFleet.agentCountOne'
                    : 'liveFleet.agentCountMany',
                  { status: status(session.status), n: session.agents.length },
                )}
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
                <AgentRuntimeBadge provider={agent.provider} model={agent.model} />
                <small>
                  {status(agent.status)}
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
  }, [visible, sessionNames, selection, t]);
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
        throw Error(t('liveFleet.changed'));
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
        throw Error(t('liveFleet.badReceipt'));
      if (alive.current) {
        setNotice(t('liveFleet.delivered', { id: result['id'] }));
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
    <section className="project-live-fleet" aria-label={t('liveFleet.label')}>
      <header className="studio-heading">
        <div>
          <h1>{t('liveFleet.title')}</h1>
          <p>{t('liveFleet.intro')}</p>
        </div>
        <div>
          <button
            type="button"
            className="button secondary"
            disabled={loading || pending}
            onClick={() => void load()}
          >
            <RefreshCw size={14} />
            {t('liveFleet.refresh')}
          </button>
        </div>
      </header>
      {sessions.length > 0 && <FleetBroadcast http={http} read={read} onSent={() => void load()} />}
      <div className="live-fleet-metrics">
        <span>
          <Trans
            i18n={surfaceI18n}
            ns="desktop"
            i18nKey="liveFleet.runtimes"
            count={sessions.length}
            values={{ n: sessions.length }}
            components={{ strong: <strong /> }}
          />
        </span>
        <span>
          <Trans
            i18n={surfaceI18n}
            ns="desktop"
            i18nKey="liveFleet.agents"
            count={agentCount}
            values={{ n: agentCount }}
            components={{ strong: <strong /> }}
          />
        </span>
        <small>{loadError ? t('liveFleet.refreshFailed') : t('liveFleet.polling')}</small>
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
            aria-label={t('liveFleet.search')}
            placeholder={t('liveFleet.searchPlaceholder')}
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
            {t('liveFleet.map')}
          </button>
          <button
            type="button"
            className="button secondary"
            aria-pressed={!map}
            onClick={() => setMap(false)}
          >
            <Users size={14} />
            {t('liveFleet.list')}
          </button>
        </div>
      </div>
      {!loaded ? (
        <p role="status">{loadError ? t('liveFleet.unavailable') : t('liveFleet.reading')}</p>
      ) : !visible.length ? (
        <div className="live-fleet-empty">
          <Network size={32} />
          <h3>{sessions.length ? t('liveFleet.noMatches') : t('liveFleet.empty')}</h3>
          <p>{t('liveFleet.emptyHelp')}</p>
        </div>
      ) : (
        <>
          {map && (
            <>
              <p className="live-fleet-caption">{t('liveFleet.mapCaption')}</p>
              <div className="live-fleet-map">
                <ReactFlow
                  nodes={graph.nodes}
                  edges={graph.edges}
                  fitView
                  fitViewOptions={{ maxZoom: 1 }}
                  proOptions={{ hideAttribution: true }}
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
                      {t('liveFleet.statusPid', {
                        status: status(session.status),
                        pid: session.pid,
                      })}
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
                      <AgentRuntimeBadge provider={agent.provider} model={agent.model} />
                      <span>
                        {status(agent.status)}
                        {agent.currentTool ? ` · ${agent.currentTool}` : ''}
                      </span>
                      <small>
                        {t('liveFleet.agentCounters', {
                          iterations: t('counts.iterations', { count: agent.iterations }),
                          tools: t('counts.toolCalls', { count: agent.toolCalls }),
                        })}
                      </small>
                    </button>
                  ))}
                  {!session.agents.length && (
                    <p className="quiet-state">{t('liveFleet.noAgents')}</p>
                  )}
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {selection && (
        <aside className="live-fleet-inspector" aria-label={t('liveFleet.detail')}>
          <header>
            <h3>{selectedAgent?.name ?? t('liveFleet.runtimeDetail')}</h3>
            <button
              type="button"
              className="button secondary small"
              disabled={pending}
              onClick={() => {
                if (!pending) setSelection(null);
              }}
            >
              {t('liveFleet.closeDetail')}
            </button>
          </header>
          {selectedSession ? (
            <>
              <dl>
                <dt>{t('liveFleet.field.session')}</dt>
                <dd>{selectedSession.sessionId}</dd>
                <dt>{t('liveFleet.field.status')}</dt>
                <dd>{status(selectedAgent?.status ?? selectedSession.status)}</dd>
                <dt>{t('liveFleet.field.process')}</dt>
                <dd>{t('liveFleet.pid', { pid: selectedSession.pid })}</dd>
                <dt>{t('liveFleet.field.started')}</dt>
                <dd>{displayDateTime(selectedSession.startedAt)}</dd>
                <dt>{t('liveFleet.field.heartbeat')}</dt>
                <dd>{displayDateTime(selectedSession.lastHeartbeatAt)}</dd>
                {selectedAgent && (
                  <>
                    <dt>{t('liveFleet.field.agent')}</dt>
                    <dd>
                      {selectedAgent.id}{' '}
                      <AgentRuntimeBadge
                        provider={selectedAgent.provider}
                        model={selectedAgent.model}
                      />
                    </dd>
                    <dt>{t('liveFleet.field.activity')}</dt>
                    <dd>{selectedAgent.currentTool ?? t('liveFleet.noTool')}</dd>
                    <dt>{t('liveFleet.field.counters')}</dt>
                    <dd>
                      {selectedAgent.iterations} / {selectedAgent.toolCalls}
                    </dd>
                  </>
                )}
              </dl>
              <p>{t('liveFleet.controlsHelp')}</p>
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
                  {t('liveFleet.sendInstruction')}
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
                  {t('liveFleet.requestInterrupt')}
                </button>
              </div>
              <FleetActivity
                key={selectedSession.sessionId}
                http={http}
                sessionId={selectedSession.sessionId}
              />
            </>
          ) : (
            <p className="quiet-state">{t('liveFleet.gone')}</p>
          )}
        </aside>
      )}
      {review && (
        <Modal
          title={
            review === 'message' ? t('liveFleet.reviewInstruction') : t('liveFleet.reviewInterrupt')
          }
          onClose={() => {
            if (!pending) setReview(null);
          }}
        >
          <div className="live-fleet-review">
            <h2>
              {review === 'message' ? t('liveFleet.askInstruction') : t('liveFleet.askInterrupt')}
            </h2>
            <code>{selectedSession?.sessionId ?? selection?.sessionId}</code>
            <p>{t('liveFleet.reviewHelp')}</p>
            {review === 'message' && (
              <label>
                {t('liveFleet.kind')}
                <select
                  aria-label={t('liveFleet.kindLabel')}
                  disabled={pending}
                  value={type}
                  onChange={(event) => setField('type', event.target.value)}
                >
                  {['note', 'steer', 'btw', 'ask', 'assign'].map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`liveFleet.kindOption.${kind}`)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {review === 'message' && (
              <>
                <label>
                  {t('liveFleet.priority')}
                  <select
                    aria-label={t('liveFleet.priorityLabel')}
                    value={priority}
                    onChange={(event) => setField('priority', event.target.value)}
                    disabled={pending}
                  >
                    {['low', 'normal', 'high'].map((value) => (
                      <option key={value} value={value}>
                        {t(`liveFleet.priorityOption.${value}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('liveFleet.subject')}
                  <input
                    aria-label={t('liveFleet.subjectLabel')}
                    value={subject}
                    maxLength={256}
                    onChange={(event) => setField('subject', event.target.value)}
                    disabled={pending}
                  />
                </label>
              </>
            )}
            <label>
              {review === 'message' ? t('liveFleet.instruction') : t('liveFleet.reason')}
              <textarea
                aria-label={t('liveFleet.textLabel')}
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
                {t('liveFleet.keepReviewing')}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={pending || !selectedSession || (review === 'message' && !text.trim())}
                onClick={() => void act()}
              >
                {t('liveFleet.confirm')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
