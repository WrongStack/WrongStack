import { Mail, Plus, RefreshCw, Reply } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { entries, markdownExcerpt, record } from './engine-values';
import { MailboxComposer } from './MailboxComposer';
import { MailboxDraftStatus } from './MailboxDraftStatus';
import { MarkdownContent } from './MarkdownContent';
import { mailboxDraftStore } from './mailbox-draft';
import {
  emptyMailDraft,
  hasMailDraft,
  type MailDraft,
  mailboxDuration,
  mailboxThreads,
  oldestMailTimestamp,
  unreadMail,
  withOlderMail,
} from './mailbox-model';
import { openExternal, projectFormDraftStorage } from './platform';
import './project-mailbox.css';

const text = (value: unknown) => (typeof value === 'string' ? value : '');
type Maintenance = 'clear' | 'purge' | 'compact';
export function ProjectMailbox({
  command,
  projectId,
  state,
}: {
  command: EngineCommand;
  projectId: string;
  state: EngineState;
}) {
  const { t } = useDesktopText();
  const when = (value: unknown) => {
    const date = new Date(typeof value === 'number' ? value : String(value));
    return Number.isNaN(date.getTime()) ? t('mailboxPage.timeMissing') : date.toLocaleString();
  };
  // Engine values: named per language, shown as sent when the catalog has no name for them.
  const named = (group: 'type' | 'priority', value: unknown) =>
    t(`mailboxPage.${group}.${String(value)}`, { defaultValue: String(value) });
  const [messages, setMessages] = useState<Record<string, unknown>[]>([]);
  const [agents, setAgents] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState('');
  const [actor, setActor] = useState('');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(100);
  const [loaded, setLoaded] = useState(false);
  // Older pages read with an inclusive timestamp bound; a reload returns to the recent window.
  const [older, setOlder] = useState<{ busy: boolean; done: boolean; note: string }>({
    busy: false,
    done: false,
    note: '',
  });
  const [localBusy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const draftStore = useMemo(
    () => mailboxDraftStore(projectId, projectFormDraftStorage(projectId, 'mailbox-compose')),
    [projectId],
  );
  const draftState = useSyncExternalStore(
    draftStore.subscribe,
    draftStore.snapshot,
    draftStore.snapshot,
  );
  const durable = draftStore.durable;
  const savedState = useSyncExternalStore(
    durable?.subscribe ?? draftStore.subscribe,
    durable?.snapshot ?? (() => null),
  );
  useEffect(() => {
    void draftStore.hydrate();
  }, [draftStore]);
  const draft = draftState.draft;
  const setDraft = draftStore.update;
  const busy = localBusy || draftState.pending;
  const displayedError = draftState.error || error;
  const [composing, setComposing] = useState(false);
  const [replacement, setReplacement] = useState<MailDraft | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [maintenance, setMaintenance] = useState<Maintenance | null>(null);
  const [maintenanceConfirm, setMaintenanceConfirm] = useState(false);
  const [completedAge, setCompletedAge] = useState('168');
  const [incompleteAge, setIncompleteAge] = useState('720');
  const [readAge, setReadAge] = useState('24');
  const [ttlAge, setTtlAge] = useState('168');
  const busyRef = useRef(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const seq = ++sequence.current;
    const results = await Promise.allSettled([
      command(
        'mailbox.messages',
        {
          limit,
          ...(actor.trim() ? { agentId: actor.trim() } : {}),
          ...(filter === 'unread'
            ? { unreadOnly: true }
            : filter === 'open'
              ? { incompleteOnly: true }
              : {}),
        },
        ['mailbox.messages'],
      ),
      command('mailbox.agents', { onlineOnly: false }, ['mailbox.agents']),
    ]);
    if (seq !== sequence.current) return;
    if (results[0].status === 'fulfilled') {
      setMessages(entries(results[0].value['messages']));
      setOlder({ busy: false, done: false, note: '' });
      setLoaded(true);
    } else throw results[0].reason;
    if (results[1].status === 'fulfilled') setAgents(entries(results[1].value['agents']));
    else throw results[1].reason;
  }, [command, actor, filter, limit]);
  const loadOlder = async () => {
    const until = oldestMailTimestamp(messages);
    if (!until || older.busy) return;
    const seq = sequence.current;
    setOlder((current) => ({ ...current, busy: true, note: '' }));
    try {
      const reply = await command(
        'mailbox.messages',
        {
          limit,
          until,
          ...(actor.trim() ? { agentId: actor.trim() } : {}),
          ...(filter === 'unread'
            ? { unreadOnly: true }
            : filter === 'open'
              ? { incompleteOnly: true }
              : {}),
        },
        ['mailbox.messages'],
      );
      if (seq !== sequence.current) return;
      const page = entries(reply['messages']);
      // An engine without the bound returns the recent window again: nothing new is added.
      const next = withOlderMail(messages, page, limit);
      setMessages(next.messages);
      setOlder({
        busy: false,
        done: next.complete || next.stuck,
        note: next.stuck
          ? t('mailboxPage.older.stuck')
          : next.complete
            ? t('mailboxPage.older.done')
            : t('mailboxPage.older.loaded', { count: next.added }),
      });
    } catch (failure) {
      setOlder({ busy: false, done: false, note: String(failure) });
    }
  };
  useEffect(() => {
    setLoaded(false);
    setSelected('');
    setError('');
    void load().catch((error) => setError(String(error)));
    return () => {
      sequence.current++;
    };
  }, [load]);
  const mailboxEvent = state.results['mailbox.event'];
  const receivedEvent = state.results['mailbox.received'];
  useEffect(() => {
    if (!mailboxEvent && !receivedEvent) return;
    const timer = setTimeout(() => {
      if (!busyRef.current && !draftState.pending)
        void load().catch((error) => setError(String(error)));
    }, 150);
    return () => clearTimeout(timer);
  }, [mailboxEvent, receivedEvent, load, draftState.pending]);
  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current || draftState.pending) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const threads = useMemo(() => mailboxThreads(messages), [messages]);
  const current = threads.find((thread) => thread.id === selected);
  const shown = threads.filter((thread) =>
    thread.items.some(
      (mail) =>
        `${mail['subject']} ${mail['body']} ${mail['from']} ${mail['to']}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (filter !== 'completed' || mail['completed'] === true),
    ),
  );
  const start = (next: MailDraft) => {
    if (hasMailDraft(draft)) {
      setReplacement(next);
      setComposing(true);
      return;
    }
    setDraft(next);
    setComposing(true);
    setError('');
  };
  const send = () =>
    void run(async () => {
      if (
        !draft.subject.trim() ||
        !draft.body.trim() ||
        (!draft.to.trim() && draft.type !== 'broadcast')
      )
        throw Error(t('mailboxPage.missingFields'));
      const submitted = draftStore.begin();
      try {
        const reply = await command(
          'mailbox.send',
          {
            ...submitted,
            from: 'desktop',
            to: submitted.type === 'broadcast' ? '*' : submitted.to.trim(),
            ...(submitted.replyTo ? { replyTo: submitted.replyTo } : {}),
          },
          ['mailbox.sent'],
        );
        if (typeof reply['messageId'] !== 'string') throw Error(t('mailboxPage.unconfirmed'));
        draftStore.acknowledge(submitted);
      } catch (error) {
        draftStore.fail(error);
        throw error;
      }
      setComposing(false);
      setNotice(t('mailboxPage.recorded'));
      await load();
    });
  const action = (id: string, kind: 'mark-read' | 'acknowledge' | 'reopen' | 'soft-delete') =>
    void run(async () => {
      if (!actor.trim()) throw Error(t('mailboxPage.chooseActor'));
      await command('mailbox.action', { mailId: id, action: kind, readerId: actor.trim() }, [
        'mailbox.action_result',
      ]);
      setDeleting(null);
      setNotice(
        kind === 'soft-delete'
          ? t('mailboxPage.removed')
          : t('mailboxPage.actionRecorded', { actor: actor.trim() }),
      );
      await load();
    });
  const maintain = () =>
    void run(async () => {
      if (!maintenance) return;
      const hours = (label: string) => t('mailboxPage.invalidHours', { label });
      const options =
        maintenance === 'clear'
          ? {}
          : {
              completedMaxAgeMs: mailboxDuration(
                completedAge,
                t('mailboxPage.ageCompleted'),
                hours,
              ),
              incompleteMaxAgeMs: mailboxDuration(
                incompleteAge,
                t('mailboxPage.ageIncomplete'),
                hours,
              ),
              ...(maintenance === 'compact'
                ? {
                    readMaxAgeMs: mailboxDuration(readAge, t('mailboxPage.ageRead'), hours),
                    defaultTtlMs: mailboxDuration(ttlAge, t('mailboxPage.ageDefault'), hours),
                  }
                : {}),
            };
      const result = await command(
        `mailbox.${maintenance}`,
        options,
        [
          maintenance === 'clear'
            ? 'mailbox.cleared'
            : maintenance === 'purge'
              ? 'mailbox.purged'
              : 'mailbox.compacted',
        ],
        { timeoutMs: 120000 },
      );
      setMaintenance(null);
      setMaintenanceConfirm(false);
      setSelected('');
      const missing = t('mailboxPage.notReported');
      setNotice(
        maintenance === 'clear'
          ? t('mailboxPage.cleared')
          : t(maintenance === 'purge' ? 'mailboxPage.purged' : 'mailboxPage.compacted', {
              removed: String(result['totalPurged'] ?? result['totalRemoved'] ?? missing),
              remaining: String(result['remaining'] ?? missing),
            }),
      );
      await load();
    });
  return (
    <section className="project-mailbox" aria-label={t('mailboxPage.label')}>
      <header className="mailbox-heading">
        <div>
          <span className="eyebrow">{t('mailboxPage.eyebrow')}</span>
          <h2>{t('mailboxPage.title')}</h2>
          <p>{t('mailboxPage.intro')}</p>
        </div>
        <div className="sdd-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void load().catch((error) => setError(String(error)))}
          >
            <RefreshCw size={14} />
            {t('mailboxPage.refresh')}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => {
              if (hasMailDraft(draft)) setComposing(true);
              else start(emptyMailDraft());
            }}
          >
            <Plus size={14} />
            {hasMailDraft(draft) ? t('mailboxPage.resumeDraft') : t('mailboxPage.composeMessage')}
          </button>
        </div>
      </header>
      <MailboxDraftStatus
        restoredAt={draftState.restoredAt}
        saved={savedState}
        localBody={draft.body}
        onResolve={(choice) => void draftStore.resolve(choice)}
        onMerge={(body) => void draftStore.merge(body)}
        onRetry={() => void durable?.load()}
      />
      {displayedError && !composing && (
        <p className="session-error" role="alert">
          {displayedError}
        </p>
      )}
      {notice && (
        <p className="studio-notice" role="status">
          {notice}
        </p>
      )}
      <div className="mailbox-controls">
        <label>
          {t('mailboxPage.actor')}
          <input
            aria-label={t('mailboxPage.actorLabel')}
            list="mailbox-actors"
            placeholder={t('mailboxPage.actorPlaceholder')}
            value={actor}
            disabled={busy}
            onChange={(event) => setActor(event.target.value)}
          />
        </label>
        <datalist id="mailbox-actors">
          <option value="desktop" />
          {agents.map((agent) => (
            <option key={String(agent['agentId'])} value={String(agent['agentId'])}>
              {String(agent['name'])}
            </option>
          ))}
        </datalist>
        <label>
          {t('mailboxPage.messages')}
          <select
            aria-label={t('mailboxPage.filterLabel')}
            value={filter}
            disabled={busy}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">{t('mailboxPage.filterAll')}</option>
            <option value="unread">{t('mailboxPage.filterUnread')}</option>
            <option value="open">{t('mailboxPage.filterOpen')}</option>
            <option value="completed">{t('mailboxPage.completed')}</option>
          </select>
        </label>
        <label>
          {t('mailboxPage.window')}
          <select
            aria-label={t('mailboxPage.windowLabel')}
            value={limit}
            disabled={busy}
            onChange={(event) => setLimit(Number(event.target.value))}
          >
            {[30, 100, 200].map((value) => (
              <option key={value} value={value}>
                {t('mailboxPage.windowOption', { n: value })}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mailbox-scope">
        {actor.trim()
          ? t('mailboxPage.scoped', { actor: actor.trim() })
          : t('mailboxPage.aggregate')}{' '}
        {t('mailboxPage.scopeSearch')}
      </p>
      <div className="mailbox-layout">
        <aside className="mailbox-thread-list">
          <label>
            {t('mailboxPage.search')}
            <input
              aria-label={t('mailboxPage.searchLabel')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <small>
            {t('mailboxPage.loadedCount', {
              messages: t('mailboxPage.messageCount', { count: messages.length }),
              threads: t('mailboxPage.threadCount', { count: threads.length }),
            })}
          </small>
          {loaded && messages.length >= limit && !older.done && (
            <button
              type="button"
              className="button secondary small"
              disabled={busy || older.busy}
              onClick={() => void loadOlder()}
            >
              {older.busy ? t('mailboxPage.loadingOlder') : t('mailboxPage.loadOlder')}
            </button>
          )}
          {older.note && <small role="status">{older.note}</small>}
          {!loaded ? (
            <p>{t('mailboxPage.loading')}</p>
          ) : !shown.length ? (
            <div className="mailbox-empty">
              <Mail size={24} />
              <p>{t('mailboxPage.empty')}</p>
            </div>
          ) : (
            shown.map((thread) => (
              <button
                type="button"
                key={thread.id}
                className="mailbox-thread"
                aria-pressed={selected === thread.id}
                disabled={busy}
                onClick={() => {
                  setSelected(thread.id);
                  setDeleting(null);
                }}
              >
                <div>
                  <strong>{text(thread.first['subject']) || t('mailboxPage.untitled')}</strong>
                  {thread.items.some(unreadMail) && (
                    <span
                      className="mail-unread-dot"
                      role="img"
                      aria-label={
                        actor.trim() ? t('mailboxPage.unreadActor') : t('mailboxPage.unreadAll')
                      }
                    />
                  )}
                </div>
                <p>{markdownExcerpt(text(thread.latest['body']), 140)}</p>
                <small>
                  {String(thread.latest['from'])} → {String(thread.latest['to'])}
                </small>
                <small>
                  {t(
                    thread.items.length === 1 ? 'mailboxPage.threadOne' : 'mailboxPage.threadMany',
                    {
                      n: thread.items.length,
                      time: when(thread.latest['timestamp']),
                    },
                  )}
                </small>
              </button>
            ))
          )}
        </aside>
        <main className="mailbox-conversation">
          {current ? (
            <>
              <header>
                <h3>{text(current.first['subject'])}</h3>
                <small>{t('mailboxPage.conversationCount', { count: current.items.length })}</small>
              </header>
              {current.missingParent && <p>{t('mailboxPage.missingParent')}</p>}
              {current.items.map((mail) => (
                <article className="mailbox-message" key={String(mail['id'])}>
                  <header>
                    <div>
                      <strong>{String(mail['from'])}</strong>
                      <span> → {String(mail['to'])}</span>
                      <small>{when(mail['timestamp'])}</small>
                    </div>
                    <div className="mailbox-message-tags">
                      <span>{named('type', mail['type'])}</span>
                      <span>{named('priority', mail['priority'])}</span>
                      <span>
                        {mail['completed'] === true
                          ? t('mailboxPage.completed')
                          : t('mailboxPage.open')}
                      </span>
                    </div>
                  </header>
                  <h4>{text(mail['subject'])}</h4>
                  <MarkdownContent
                    text={text(mail['body'])}
                    onLink={(url) =>
                      void openExternal(url).catch((error) => setError(String(error)))
                    }
                  />
                  <div className="mailbox-message-meta">
                    <span>
                      {t('mailboxPage.audience', {
                        audience:
                          mail['audience'] === 'leaders'
                            ? t('mailboxPage.audienceLeaders')
                            : t('mailboxPage.audienceAll'),
                      })}
                    </span>
                    <span>
                      {t('mailboxPage.receipts', { count: Number(mail['readByCount'] ?? 0) })}
                    </span>
                    {typeof mail['completedBy'] === 'string' && (
                      <span>
                        {t('mailboxPage.completedBy', {
                          actor: mail['completedBy'],
                          time: when(mail['completedAt']),
                        })}
                      </span>
                    )}
                  </div>
                  <details>
                    <summary>{t('mailboxPage.references')}</summary>
                    <dl>
                      {Object.entries(record(mail['readBy'])).map(([reader, time]) => (
                        <div key={reader}>
                          <dt>{reader}</dt>
                          <dd>{when(time)}</dd>
                        </div>
                      ))}
                    </dl>
                    {typeof mail['replyTo'] === 'string' && (
                      <p>
                        {t('mailboxPage.replyTo')} <code>{mail['replyTo']}</code>
                      </p>
                    )}
                    {typeof mail['senderSessionId'] === 'string' && (
                      <p>
                        {t('mailboxPage.senderSession')} <code>{mail['senderSessionId']}</code>
                      </p>
                    )}
                    {typeof mail['outcome'] === 'string' && (
                      <p>{t('mailboxPage.outcome', { outcome: mail['outcome'] })}</p>
                    )}
                    {Object.keys(record(mail['taskContext'])).length > 0 && (
                      <dl>
                        {['taskId', 'agentName', 'agentRole', 'status'].map(
                          (key) =>
                            typeof record(mail['taskContext'])[key] === 'string' && (
                              <div key={key}>
                                <dt>{t(`mailboxPage.task.${key}`)}</dt>
                                <dd>
                                  {String(record(mail['taskContext'])[key]).replaceAll('_', ' ')}
                                </dd>
                              </div>
                            ),
                        )}
                      </dl>
                    )}
                  </details>
                  <div className="sdd-actions">
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        start({
                          ...emptyMailDraft(),
                          to: text(mail['from']),
                          subject: /^re:/i.test(text(mail['subject']))
                            ? text(mail['subject'])
                            : `Re: ${text(mail['subject'])}`,
                          replyTo: String(mail['id']),
                        })
                      }
                    >
                      <Reply size={13} />
                      {t('mailboxPage.reply')}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || !actor.trim()}
                      onClick={() => action(String(mail['id']), 'mark-read')}
                    >
                      {t('mailboxPage.markRead')}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || !actor.trim()}
                      onClick={() =>
                        action(
                          String(mail['id']),
                          mail['completed'] === true ? 'reopen' : 'acknowledge',
                        )
                      }
                    >
                      {mail['completed'] === true
                        ? t('mailboxPage.reopen')
                        : t('mailboxPage.complete')}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || !actor.trim()}
                      onClick={() => setDeleting(String(mail['id']))}
                    >
                      {t('mailboxPage.remove')}
                    </button>
                  </div>
                  {deleting === mail['id'] && (
                    <div className="mailbox-confirm">
                      <p>{t('mailboxPage.removeConfirm')}</p>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        onClick={() => setDeleting(null)}
                      >
                        {t('mailboxPage.keep')}
                      </button>
                      <button
                        type="button"
                        className="button secondary danger"
                        disabled={busy}
                        onClick={() => action(String(mail['id']), 'soft-delete')}
                      >
                        {t('mailboxPage.confirmRemove')}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </>
          ) : (
            <div className="mailbox-empty">
              <Mail size={32} />
              <h3>{t('mailboxPage.followTitle')}</h3>
              <p>{t('mailboxPage.followHint')}</p>
            </div>
          )}
        </main>
      </div>
      <details className="mailbox-agents">
        <summary>{t('mailboxPage.agents', { n: agents.length })}</summary>
        <div>
          {agents.map((agent) => (
            <article key={String(agent['agentId'])}>
              <strong>{String(agent['name'] ?? agent['agentId'])}</strong>
              <code>{String(agent['agentId'])}</code>
              <span>
                {agent['online'] === true ? t('mailboxPage.online') : t('mailboxPage.offline')} ·{' '}
                {String(agent['role'] ?? t('mailboxPage.roleMissing'))} ·{' '}
                {String(agent['status'] ?? t('mailboxPage.statusMissing'))}
              </span>
              {typeof agent['currentTask'] === 'string' && <p>{agent['currentTask']}</p>}
              {typeof agent['currentTool'] === 'string' && (
                <p>{t('mailboxPage.currentTool', { tool: agent['currentTool'] })}</p>
              )}
              <small>{t('mailboxPage.lastSeen', { time: when(agent['lastSeenAt']) })}</small>
            </article>
          ))}
        </div>
      </details>
      <details className="mailbox-maintenance">
        <summary>{t('mailboxPage.maintenance')}</summary>
        <p>{t('mailboxPage.maintenanceScope')}</p>
        <div className="sdd-actions">
          {(['purge', 'compact', 'clear'] as const).map((kind) => (
            <button
              type="button"
              className="button secondary"
              key={kind}
              disabled={busy}
              onClick={() => {
                setMaintenance(kind);
                setMaintenanceConfirm(false);
                setError('');
              }}
            >
              {t(`mailboxPage.kind.${kind}`)}
            </button>
          ))}
        </div>
        {maintenance && (
          <div className="mailbox-confirm">
            {maintenance !== 'clear' ? (
              <>
                <p>
                  {maintenance === 'purge'
                    ? t('mailboxPage.configurePurge')
                    : t('mailboxPage.configureCompact')}
                </p>
                <div className="mailbox-controls">
                  <label>
                    {t('mailboxPage.completedHours')}
                    <input
                      aria-label={t('mailboxPage.completedHoursLabel')}
                      type="number"
                      min={0}
                      value={completedAge}
                      disabled={busy || maintenanceConfirm}
                      onChange={(event) => setCompletedAge(event.target.value)}
                    />
                  </label>
                  <label>
                    {t('mailboxPage.incompleteHours')}
                    <input
                      aria-label={t('mailboxPage.incompleteHoursLabel')}
                      type="number"
                      min={0}
                      value={incompleteAge}
                      disabled={busy || maintenanceConfirm}
                      onChange={(event) => setIncompleteAge(event.target.value)}
                    />
                  </label>
                  {maintenance === 'compact' && (
                    <>
                      <label>
                        {t('mailboxPage.readHours')}
                        <input
                          aria-label={t('mailboxPage.readHoursLabel')}
                          type="number"
                          min={0}
                          value={readAge}
                          disabled={busy || maintenanceConfirm}
                          onChange={(event) => setReadAge(event.target.value)}
                        />
                      </label>
                      <label>
                        {t('mailboxPage.ttlHours')}
                        <input
                          aria-label={t('mailboxPage.ttlHoursLabel')}
                          type="number"
                          min={0}
                          value={ttlAge}
                          disabled={busy || maintenanceConfirm}
                          onChange={(event) => setTtlAge(event.target.value)}
                        />
                      </label>
                    </>
                  )}
                </div>
              </>
            ) : (
              <p>{t('mailboxPage.clearConfirm')}</p>
            )}
            <div className="sdd-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setMaintenance(null);
                  setMaintenanceConfirm(false);
                }}
              >
                {t('mailboxPage.cancelMaintenance')}
              </button>
              <button
                type="button"
                className="button secondary danger"
                disabled={busy}
                onClick={() => {
                  if (maintenanceConfirm) maintain();
                  else setMaintenanceConfirm(true);
                }}
              >
                {maintenanceConfirm
                  ? t(`mailboxPage.confirmKind.${maintenance}`)
                  : t('mailboxPage.reviewMaintenance')}
              </button>
            </div>
            {maintenanceConfirm && <p>{t('mailboxPage.maintenanceWarning')}</p>}
          </div>
        )}
      </details>
      {composing && (
        <MailboxComposer
          draft={draft}
          setDraft={setDraft}
          busy={busy}
          replacement={replacement}
          setReplacement={setReplacement}
          setComposing={setComposing}
          send={send}
          displayedError={displayedError}
        />
      )}
    </section>
  );
}
