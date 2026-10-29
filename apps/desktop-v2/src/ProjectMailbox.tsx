import { Mail, Plus, RefreshCw, Reply } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { entries, record } from './engine-values';
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
  unreadMail,
} from './mailbox-model';
import { openExternal, projectFormDraftStorage } from './platform';
import './project-mailbox.css';

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const when = (value: unknown) => {
  const date = new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(date.getTime()) ? 'Time not reported' : date.toLocaleString();
};
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
  const [messages, setMessages] = useState<Record<string, unknown>[]>([]);
  const [agents, setAgents] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState('');
  const [actor, setActor] = useState('');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(100);
  const [loaded, setLoaded] = useState(false);
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
      setLoaded(true);
    } else throw results[0].reason;
    if (results[1].status === 'fulfilled') setAgents(entries(results[1].value['agents']));
    else throw results[1].reason;
  }, [command, actor, filter, limit]);
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
        throw Error('Enter a recipient, subject and message.');
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
        if (typeof reply['messageId'] !== 'string')
          throw Error(
            'The engine did not confirm a saved message. Check the mailbox before retrying; your draft is retained.',
          );
        draftStore.acknowledge(submitted);
      } catch (error) {
        draftStore.fail(error);
        throw error;
      }
      setComposing(false);
      setNotice(
        'Message recorded in the project mailbox. Delivery and completion are shown separately.',
      );
      await load();
    });
  const action = (id: string, kind: 'mark-read' | 'acknowledge' | 'reopen' | 'soft-delete') =>
    void run(async () => {
      if (!actor.trim()) throw Error('Choose the actor whose receipt or action you are recording.');
      await command('mailbox.action', { mailId: id, action: kind, readerId: actor.trim() }, [
        'mailbox.action_result',
      ]);
      setDeleting(null);
      setNotice(
        kind === 'soft-delete'
          ? 'Message removed from the active mailbox.'
          : `Mailbox action recorded for ${actor.trim()}.`,
      );
      await load();
    });
  const maintain = () =>
    void run(async () => {
      if (!maintenance) return;
      const options =
        maintenance === 'clear'
          ? {}
          : {
              completedMaxAgeMs: mailboxDuration(completedAge, 'Completed message age'),
              incompleteMaxAgeMs: mailboxDuration(incompleteAge, 'Incomplete message age'),
              ...(maintenance === 'compact'
                ? {
                    readMaxAgeMs: mailboxDuration(readAge, 'Read message age'),
                    defaultTtlMs: mailboxDuration(ttlAge, 'Default lifetime'),
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
      setNotice(
        maintenance === 'clear'
          ? 'All project mailbox messages cleared.'
          : `${maintenance === 'purge' ? 'Purge' : 'Compaction'} completed: ${String(result['totalPurged'] ?? result['totalRemoved'] ?? 'not reported')} removed · ${String(result['remaining'] ?? 'not reported')} remaining.`,
      );
      await load();
    });
  return (
    <section className="project-mailbox" aria-label="Project mailbox">
      <header className="mailbox-heading">
        <div>
          <span className="eyebrow">KEEP THE TEAM IN CONTEXT</span>
          <h2>Mailbox</h2>
          <p>Project correspondence, agent receipts and follow-up in one place.</p>
        </div>
        <div className="sdd-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void load().catch((error) => setError(String(error)))}
          >
            <RefreshCw size={14} />
            Refresh mailbox
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
            {hasMailDraft(draft) ? 'Resume message draft' : 'Compose message'}
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
          View as actor
          <input
            aria-label="Mailbox actor"
            list="mailbox-actors"
            placeholder="All agents · aggregate view"
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
          Messages
          <select
            aria-label="Mailbox status filter"
            value={filter}
            disabled={busy}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">All recent messages</option>
            <option value="unread">Unread</option>
            <option value="open">Incomplete</option>
            <option value="completed">Completed</option>
          </select>
        </label>
        <label>
          Recent window
          <select
            aria-label="Mailbox recent limit"
            value={limit}
            disabled={busy}
            onChange={(event) => setLimit(Number(event.target.value))}
          >
            {[30, 100, 200].map((value) => (
              <option key={value} value={value}>
                {value} messages
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mailbox-scope">
        {actor.trim()
          ? `Receipts and visibility are scoped to ${actor.trim()}.`
          : 'Aggregate view: unread means nobody has read the message. Choose an actor to inspect or change that actor’s receipts.'}{' '}
        Search and thread grouping cover the loaded recent window.
      </p>
      <div className="mailbox-layout">
        <aside className="mailbox-thread-list">
          <label>
            Search loaded messages
            <input
              aria-label="Search mailbox messages"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <small>
            {messages.length} messages · {threads.length} conversations
          </small>
          {!loaded ? (
            <p>Loading correspondence…</p>
          ) : !shown.length ? (
            <div className="mailbox-empty">
              <Mail size={24} />
              <p>No messages in this view.</p>
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
                  <strong>{text(thread.first['subject']) || 'Untitled conversation'}</strong>
                  {thread.items.some(unreadMail) && (
                    <span
                      className="mail-unread-dot"
                      role="img"
                      aria-label={
                        actor.trim() ? 'Unread for selected actor' : 'Unread to all readers'
                      }
                    />
                  )}
                </div>
                <p>{text(thread.latest['body']).slice(0, 100)}</p>
                <small>
                  {String(thread.latest['from'])} → {String(thread.latest['to'])}
                </small>
                <small>
                  {thread.items.length} {thread.items.length === 1 ? 'message' : 'messages'} ·{' '}
                  {when(thread.latest['timestamp'])}
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
                <small>{current.items.length} loaded messages in this conversation</small>
              </header>
              {current.missingParent && (
                <p>The earlier parent message is outside the loaded window.</p>
              )}
              {current.items.map((mail) => (
                <article className="mailbox-message" key={String(mail['id'])}>
                  <header>
                    <div>
                      <strong>{String(mail['from'])}</strong>
                      <span> → {String(mail['to'])}</span>
                      <small>{when(mail['timestamp'])}</small>
                    </div>
                    <div className="mailbox-message-tags">
                      <span>{String(mail['type'])}</span>
                      <span>{String(mail['priority'])}</span>
                      <span>{mail['completed'] === true ? 'Completed' : 'Open'}</span>
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
                      Audience:{' '}
                      {mail['audience'] === 'leaders' ? 'Leaders only' : 'All eligible recipients'}
                    </span>
                    <span>{String(mail['readByCount'] ?? 0)} read receipts in this view</span>
                    {typeof mail['completedBy'] === 'string' && (
                      <span>
                        Completed by {String(mail['completedBy'])} · {when(mail['completedAt'])}
                      </span>
                    )}
                  </div>
                  <details>
                    <summary>Receipts and references</summary>
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
                        Reply to: <code>{mail['replyTo']}</code>
                      </p>
                    )}
                    {typeof mail['senderSessionId'] === 'string' && (
                      <p>
                        Sender session: <code>{mail['senderSessionId']}</code>
                      </p>
                    )}
                    {typeof mail['outcome'] === 'string' && <p>Outcome: {mail['outcome']}</p>}
                    {Object.keys(record(mail['taskContext'])).length > 0 && (
                      <dl>
                        {[
                          ['taskId', 'Task'],
                          ['agentName', 'Agent'],
                          ['agentRole', 'Role'],
                          ['status', 'Task status'],
                        ].map(
                          ([key, label]) =>
                            typeof record(mail['taskContext'])[key!] === 'string' && (
                              <div key={key}>
                                <dt>{label}</dt>
                                <dd>
                                  {String(record(mail['taskContext'])[key!]).replaceAll('_', ' ')}
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
                      Reply
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || !actor.trim()}
                      onClick={() => action(String(mail['id']), 'mark-read')}
                    >
                      Mark read
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
                      {mail['completed'] === true ? 'Reopen message' : 'Complete message'}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || !actor.trim()}
                      onClick={() => setDeleting(String(mail['id']))}
                    >
                      Remove message
                    </button>
                  </div>
                  {deleting === mail['id'] && (
                    <div className="mailbox-confirm">
                      <p>
                        Remove this message from the active mailbox? Its soft-deleted record is
                        retained by the engine.
                      </p>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        onClick={() => setDeleting(null)}
                      >
                        Keep message
                      </button>
                      <button
                        type="button"
                        className="button secondary danger"
                        disabled={busy}
                        onClick={() => action(String(mail['id']), 'soft-delete')}
                      >
                        Confirm remove message
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </>
          ) : (
            <div className="mailbox-empty">
              <Mail size={32} />
              <h3>Follow the conversation</h3>
              <p>Select a thread to read its messages, receipts and replies.</p>
            </div>
          )}
        </main>
      </div>
      <details className="mailbox-agents">
        <summary>Registered agents ({agents.length})</summary>
        <div>
          {agents.map((agent) => (
            <article key={String(agent['agentId'])}>
              <strong>{String(agent['name'] ?? agent['agentId'])}</strong>
              <code>{String(agent['agentId'])}</code>
              <span>
                {agent['online'] === true ? 'Online' : 'Offline'} ·{' '}
                {String(agent['role'] ?? 'Role not reported')} ·{' '}
                {String(agent['status'] ?? 'Status not reported')}
              </span>
              {typeof agent['currentTask'] === 'string' && <p>{agent['currentTask']}</p>}
              {typeof agent['currentTool'] === 'string' && (
                <p>Current tool: {agent['currentTool']}</p>
              )}
              <small>Last seen: {when(agent['lastSeenAt'])}</small>
            </article>
          ))}
        </div>
      </details>
      <details className="mailbox-maintenance">
        <summary>Retention and maintenance</summary>
        <p>
          These operations affect the whole project mailbox, including messages outside this loaded
          window.
        </p>
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
              {kind === 'purge'
                ? 'Purge stale messages'
                : kind === 'compact'
                  ? 'Compact mailbox'
                  : 'Clear all messages'}
            </button>
          ))}
        </div>
        {maintenance && (
          <div className="mailbox-confirm">
            {maintenance !== 'clear' ? (
              <>
                <p>
                  Configure {maintenance === 'purge' ? 'stale-message purge' : 'mailbox compaction'}{' '}
                  thresholds in hours. Zero makes matching messages immediately eligible.
                </p>
                <div className="mailbox-controls">
                  <label>
                    Completed age (hours)
                    <input
                      aria-label="Completed mailbox age hours"
                      type="number"
                      min={0}
                      value={completedAge}
                      disabled={busy || maintenanceConfirm}
                      onChange={(event) => setCompletedAge(event.target.value)}
                    />
                  </label>
                  <label>
                    Incomplete age (hours)
                    <input
                      aria-label="Incomplete mailbox age hours"
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
                        Read-by-all age (hours)
                        <input
                          aria-label="Read mailbox age hours"
                          type="number"
                          min={0}
                          value={readAge}
                          disabled={busy || maintenanceConfirm}
                          onChange={(event) => setReadAge(event.target.value)}
                        />
                      </label>
                      <label>
                        Default lifetime (hours)
                        <input
                          aria-label="Mailbox default lifetime hours"
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
              <p>
                Permanently clear all project mailbox messages? This cannot be undone in this
                screen.
              </p>
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
                Cancel mailbox maintenance
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
                  ? `Confirm ${maintenance} mailbox`
                  : 'Review mailbox maintenance'}
              </button>
            </div>
            {maintenanceConfirm && (
              <p>
                This will apply to the complete project mailbox, not only the selected conversation.
              </p>
            )}
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
