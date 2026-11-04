import type { MCPTaskView } from '@wrongstack/webui-protocol';
import { ArrowLeft, Plug, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { Modal } from './Modal';
import { mcpTaskSnapshot, mcpTaskStatuses, mcpTaskTerminal } from './mcp-tasks-model';
import './session-mcp-tasks.css';

export function SessionMcpTasks({
  sessionId,
  connected,
  command,
  onBack,
  pendingReviews,
}: {
  sessionId: string;
  connected: boolean;
  command: EngineCommand;
  onBack: () => void;
  pendingReviews: number;
}) {
  const { t } = useDesktopText();
  const statusLabel = (status: MCPTaskView['status']) => t(`mcpTasks.status.${status}`);
  const [tasks, setTasks] = useState<MCPTaskView[]>([]),
    [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [actionError, setActionError] = useState(''),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState(''),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [cancel, setCancel] = useState<MCPTaskView | null>(null),
    [cancelled, setCancelled] = useState<Set<string>>(new Set());
  const alive = useRef(true),
    reading = useRef(false),
    resultVersion = useRef(0),
    readSequence = useRef(0),
    actionPending = useRef(false);
  const load = useCallback(async () => {
    if (!connected || !sessionId || reading.current) return;
    reading.current = true;
    const version = resultVersion.current,
      request = ++readSequence.current;
    setLoading(true);
    try {
      const value = await command('mcp.tasks.list', { sessionId }, [
        'mcp.tasks.list',
        'mcp.tasks.result',
      ]);
      const next = mcpTaskSnapshot(value, sessionId);
      if (!alive.current || request !== readSequence.current || version !== resultVersion.current)
        return;
      setTasks(next);
      setLoaded(true);
      setError('');
    } catch (error) {
      if (alive.current && request === readSequence.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      reading.current = false;
      if (alive.current && request === readSequence.current) setLoading(false);
    }
  }, [connected, sessionId, command]);
  useEffect(() => {
    alive.current = true;
    resultVersion.current++;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    // Native windows share an engine socket. Independent correlated reads avoid replacing
    // another window's session-keyed server subscription and leave no watcher on UI restart.
    const poll = async () => {
      await load();
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    if (connected && sessionId) void poll();
    return () => {
      stopped = true;
      alive.current = false;
      readSequence.current++;
      clearTimeout(timer);
    };
  }, [connected, sessionId, load]);
  const act = async (task: MCPTaskView, kind: 'retry' | 'cancel') => {
    if (actionPending.current) return;
    actionPending.current = true;
    setPending(task.id);
    setActionError('');
    setNotice('');
    try {
      const reply = await command(
        `mcp.tasks.${kind}`,
        { sessionId, id: task.id },
        ['mcp.tasks.result'],
        { timeoutMs: 120000 },
      );
      if (!alive.current) return;
      if (reply['sessionId'] !== sessionId) throw Error(t('mcpTasks.otherSession'));
      resultVersion.current++;
      setNotice(String(reply['message'] ?? t('mcpTasks.acknowledged')));
      if (kind === 'cancel') setCancelled((current) => new Set([...current, task.id]));
      setCancel(null);
      await load();
    } catch (error) {
      if (alive.current) setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      actionPending.current = false;
      if (alive.current) setPending('');
    }
  };
  const visible = tasks
    .filter(
      (task) =>
        (filter === 'all' || filter === task.status) &&
        `${task.id} ${task.server} ${task.tool}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt));
  const cancelCurrent = tasks.find((task) => task.id === cancel?.id);
  return (
    <section className="session-mcp-tasks" aria-label={t('mcpTasks.label')}>
      <header>
        <div>
          <span className="eyebrow">{t('mcpTasks.eyebrow')}</span>
          <h2>{t('mcpTasks.title')}</h2>
          <p>{t('mcpTasks.intro')}</p>
        </div>
        <div className="feature-actions">
          <button type="button" className="button secondary" onClick={onBack}>
            <ArrowLeft size={14} />
            {t('mcpTasks.back')}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!connected || loading || !!pending}
            onClick={() => void load()}
          >
            <RefreshCw size={14} />
            {t('mcpTasks.refresh')}
          </button>
        </div>
      </header>
      <div className="mcp-task-summary">
        <span>{t('mcpTasks.recorded', { number: tasks.length })}</span>
        <span>
          {t('mcpTasks.active', {
            number: tasks.filter((task) => !mcpTaskTerminal(task)).length,
          })}
        </span>
        <span>
          {t('mcpTasks.needInput', {
            number: tasks.filter((task) => task.status === 'input_required').length,
          })}
        </span>
        <span role="status">
          {!connected ? t('mcpTasks.disconnected') : t('mcpTasks.refreshes')}
        </span>
      </div>
      {pendingReviews > 0 && (
        <button type="button" className="button secondary" onClick={onBack}>
          {t('mcpTasks.reviewPending', { number: pendingReviews })}
        </button>
      )}
      <div className="mcp-task-filters">
        <label>
          <Search size={14} />
          <input
            aria-label={t('mcpTasks.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('mcpTasks.searchPlaceholder')}
          />
        </label>
        <select
          aria-label={t('mcpTasks.statusFilter')}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">{t('mcpTasks.allStatuses')}</option>
          {mcpTaskStatuses.map((status) => (
            <option key={status} value={status}>
              {statusLabel(status)}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {actionError && (
        <p className="session-error" role="alert">
          {actionError}
        </p>
      )}
      {notice && (
        <p className="feature-notice" role="status">
          {notice}
        </p>
      )}
      {!sessionId || !connected ? (
        <p className="quiet-state">{t('mcpTasks.reconnect')}</p>
      ) : !loaded ? (
        <p role="status">{error && !loading ? t('mcpTasks.unavailable') : t('mcpTasks.reading')}</p>
      ) : !visible.length ? (
        <div className="mcp-task-empty">
          <Plug size={30} />
          <h3>{tasks.length ? t('mcpTasks.noMatch') : t('mcpTasks.none')}</h3>
          <p>{t('mcpTasks.noInvoke')}</p>
        </div>
      ) : (
        <div className="mcp-task-list">
          {visible.map((task) => (
            <article key={task.id} data-mcp-task={task.id}>
              <header>
                <div>
                  <h3>
                    {task.server} / {task.tool}
                  </h3>
                  <code>{task.id}</code>
                </div>
                <span className={`mcp-task-status status-${task.status}`}>
                  {statusLabel(task.status)}
                </span>
              </header>
              <p>
                {task.delivered
                  ? task.status === 'completed'
                    ? t('mcpTasks.resultCollected')
                    : t('mcpTasks.terminalCollected')
                  : task.observing
                    ? t('mcpTasks.observing')
                    : t('mcpTasks.noObserver')}
              </p>
              {task.status === 'input_required' && (
                <button type="button" className="text-link" onClick={onBack}>
                  {t('mcpTasks.answer')}
                </button>
              )}
              <dl>
                <dt>{t('mcpTasks.created')}</dt>
                <dd>{new Date(task.createdAt).toLocaleString()}</dd>
                <dt>{t('mcpTasks.updated')}</dt>
                <dd>{new Date(task.lastUpdatedAt).toLocaleString()}</dd>
              </dl>
              {!task.delivered && (
                <footer>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!connected || !!pending || task.observing}
                    onClick={() => void act(task, 'retry')}
                  >
                    {t('mcpTasks.resume')}
                  </button>
                  {!mcpTaskTerminal(task) && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={!connected || !!pending || cancelled.has(task.id)}
                      onClick={() => setCancel(task)}
                    >
                      {cancelled.has(task.id)
                        ? t('mcpTasks.cancelRequested')
                        : t('mcpTasks.requestCancel')}
                    </button>
                  )}
                </footer>
              )}
            </article>
          ))}
        </div>
      )}
      {cancel && (
        <Modal
          title={t('mcpTasks.cancelTitle')}
          onClose={() => {
            if (!pending) setCancel(null);
          }}
        >
          <div className="mcp-task-cancel">
            <h2>{t('mcpTasks.cancelQuestion')}</h2>
            <p>
              {cancel.server} / {cancel.tool} · <code>{cancel.id}</code>
            </p>
            <p>{t('mcpTasks.cancelNote')}</p>
            {pendingReviews > 0 && (
              <button type="button" className="button secondary" onClick={onBack}>
                {t('mcpTasks.reviewPending', { number: pendingReviews })}
              </button>
            )}
            {actionError && (
              <p className="session-error" role="alert">
                {actionError}
              </p>
            )}
            <button
              type="button"
              className="button secondary"
              disabled={!!pending}
              onClick={() => setCancel(null)}
            >
              {t('mcpTasks.keep')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={
                !!pending ||
                !cancelCurrent ||
                cancelCurrent.delivered ||
                mcpTaskTerminal(cancelCurrent)
              }
              onClick={() => cancelCurrent && void act(cancelCurrent, 'cancel')}
            >
              {t('mcpTasks.confirm')}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
