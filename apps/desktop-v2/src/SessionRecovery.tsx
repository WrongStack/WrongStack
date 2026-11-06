import { ArrowLeft, Clock3, FileCode, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CopyButton } from './CopyButton';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { Modal } from './Modal';
import { RecoveryRecords } from './RecoveryRecords';
import { recoveryLog, redoRecord, rewindRecord, unfinishedRecord } from './recovery-log';
import {
  checkpointBoundaries,
  checkpointMatches,
  type RecoveryCheckpoint,
  recoveryCheckpoints,
  recoveryDate,
  recoveryResult,
  redoResult,
  retryCheckpoint,
  retryPlan,
} from './session-recovery-model';
import './session-recovery.css';
import { displayLocale } from './display-dates';

export function SessionRecovery({
  sessionId,
  sessionTitle,
  running,
  command,
  onBack,
  onOpenFile,
  draftEmpty = true,
  onEditPrompt,
  onRetryPrompt,
}: {
  sessionId: string;
  sessionTitle: string;
  running: boolean;
  command: EngineCommand;
  onBack: () => void;
  onOpenFile: (path: string) => void;
  /** Whether the composer holds no unsent text; editing a rewound prompt asks before replacing it. */
  draftEmpty?: boolean | undefined;
  /** Puts the rewound prompt into the composer for editing and sending again. */
  onEditPrompt?: ((text: string) => void) | undefined;
  /** Sends the rewound prompt again, unchanged; rejects when the engine did not accept it. */
  onRetryPrompt?: ((text: string) => Promise<void>) | undefined;
}) {
  const { t } = useDesktopText();
  const when = (value: unknown) => recoveryDate(value, t('recovery.timeMissing'));
  const [inspect, setInspect] = useState<Record<string, unknown> | null>(null);
  const [checkpoints, setCheckpoints] = useState<RecoveryCheckpoint[]>([]);
  const [revision, setRevision] = useState('');
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [checkpointError, setCheckpointError] = useState('');
  const [confirm, setConfirm] = useState<RecoveryCheckpoint | null>(null);
  const [result, setResult] = useState<ReturnType<typeof recoveryResult>>(null);
  const [redone, setRedone] = useState<ReturnType<typeof redoResult>>(null);
  const [retrying, setRetrying] = useState(false),
    [retryNote, setRetryNote] = useState('');
  const [search, setSearch] = useState(''),
    [kind, setKind] = useState(''),
    [limit, setLimit] = useState(100);
  const records = useSyncExternalStore(recoveryLog.subscribe, () => recoveryLog.list(sessionId));
  const recordsError = useSyncExternalStore(recoveryLog.subscribe, () =>
    recoveryLog.error(sessionId),
  );
  const generation = useRef(0),
    mounted = useRef(true),
    mutation = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const load = useCallback(async () => {
    const run = ++generation.current;
    setLoading(true);
    setError('');
    setCheckpointError('');
    setRevision('');
    const [details, points] = await Promise.allSettled([
      command('session.inspect', { id: sessionId }, ['session.inspect']),
      command('session.checkpoints', { includeRevision: true }, ['session.checkpoints']),
    ]);
    if (!mounted.current || run !== generation.current) return;
    if (details.status === 'fulfilled') setInspect(details.value);
    else {
      setInspect(null);
      setError(details.reason instanceof Error ? details.reason.message : String(details.reason));
    }
    if (points.status === 'fulfilled') {
      setCheckpoints(recoveryCheckpoints(points.value['checkpoints']));
      setRevision(
        typeof points.value['journalRevision'] === 'string' ? points.value['journalRevision'] : '',
      );
    } else {
      setCheckpoints([]);
      setCheckpointError(
        points.reason instanceof Error ? points.reason.message : String(points.reason),
      );
    }
    setLoading(false);
  }, [command, sessionId]);
  useEffect(() => {
    void load();
  }, [load]);
  const rewind = async () => {
    if (!confirm || busy || mutation.current || running || !revision) return;
    const target = confirm;
    const retry = retrying;
    const operation = retry ? 'retry' : 'rewind';
    let requested = false,
      observed: ReturnType<typeof recoveryResult> = null;
    mutation.current = true;
    setBusy(true);
    setError('');
    setRetryNote('');
    try {
      const fresh = await command('session.checkpoints', { includeRevision: true }, [
        'session.checkpoints',
      ]);
      if (
        fresh['journalRevision'] !== revision ||
        !checkpointMatches(checkpoints, recoveryCheckpoints(fresh['checkpoints']))
      ) {
        const message = t('recovery.changed');
        void recoveryLog.record(
          sessionId,
          unfinishedRecord(operation, 'refused', target.promptIndex, message),
        );
        throw Error(message);
      }
      requested = true;
      const reply = await command(
        'session.rewind',
        { checkpointIndex: target.promptIndex, expectedJournalRevision: revision },
        ['key.operation_result'],
        { timeoutMs: 120000 },
      );
      observed = recoveryResult(reply);
      if (!observed) throw Error(t('recovery.noRewindResult'));
      const rewound = observed;
      let note = '';
      if (retry && onRetryPrompt && !mounted.current) note = t('recovery.notSentClosed');
      else if (retry && onRetryPrompt) {
        const plan = retryPlan(rewound, {
          noText: t('recovery.reason.noText'),
          fileErrors: t('recovery.reason.fileErrors'),
          attachments: t('recovery.reason.attachments'),
        });
        if ('reason' in plan) note = plan.reason;
        else
          try {
            await onRetryPrompt(plan.text);
            note = t('recovery.sentAgain');
          } catch (failure) {
            note = t('recovery.sendFailed', {
              error: failure instanceof Error ? failure.message : String(failure),
            });
          }
      }
      void recoveryLog.record(sessionId, rewindRecord(rewound, operation, note));
      if (!mounted.current) return;
      setResult(rewound);
      setRetryNote(note);
      setConfirm(null);
      setRetrying(false);
      await load();
    } catch (error) {
      if (requested && !observed)
        void recoveryLog.record(
          sessionId,
          unfinishedRecord(
            operation,
            'failed',
            target.promptIndex,
            error instanceof Error ? error.message : String(error),
          ),
        );
      if (mounted.current) {
        setError(error instanceof Error ? error.message : String(error));
        setRevision('');
      }
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  /**
   * Undo the newest rewind. The engine re-applies its file changes only if every file still
   * holds what the rewind left, and refuses once a prompt was sent after the rewind.
   */
  const redo = async () => {
    if (busy || mutation.current || running) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    let observed: ReturnType<typeof redoResult> = null;
    try {
      const reply = await command('session.redo', {}, ['key.operation_result'], {
        timeoutMs: 120000,
      });
      observed = redoResult(reply);
      if (!observed) throw Error(t('recovery.noRedoResult'));
      void recoveryLog.record(sessionId, redoRecord(observed));
      if (!mounted.current) return;
      setRedone(observed);
      setResult(null);
      await load();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!observed)
        void recoveryLog.record(sessionId, unfinishedRecord('redo', 'failed', null, message));
      if (mounted.current) setError(message);
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const events = entries(inspect?.['events']);
  const query = search.trim().toLowerCase();
  const matching = events.filter(
    (event) =>
      (!kind || event['type'] === kind) &&
      (!query || `${event['label']} ${event['detail']}`.toLowerCase().includes(query)),
  );
  const tools = Object.entries(record(inspect?.['toolBreakdown']))
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort((a, b) => b[1] - a[1]);
  const maxToolCount = Math.max(1, ...tools.map(([, value]) => value));
  const boundaries = checkpointBoundaries(checkpoints);
  const snapshotCount = confirm
    ? boundaries
        .filter((item) => item.promptIndex >= confirm.promptIndex)
        .reduce((sum, item) => sum + item.fileCount, 0)
    : 0;
  return (
    <section className="session-recovery" aria-label={t('recovery.label')}>
      <header className="recovery-heading">
        <div>
          <span className="eyebrow">{t('recovery.eyebrow')}</span>
          <h2>{t('recovery.title')}</h2>
          <p>{t('recovery.intro')}</p>
        </div>
        <div>
          <button type="button" className="button secondary" disabled={busy} onClick={onBack}>
            <ArrowLeft size={14} />
            {t('recovery.back')}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            <RefreshCw size={14} />
            {t('recovery.refresh')}
          </button>
        </div>
      </header>
      {error && !confirm && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {loading && <p role="status">{t('recovery.reading')}</p>}
      {result && (
        <section
          className={`recovery-outcome ${result.errors.length ? 'recovery-partial' : ''}`}
          aria-label={t('recovery.rewindLabel')}
        >
          <h3>{result.errors.length ? t('recovery.rewindPartial') : t('recovery.rewindDone')}</h3>
          <p>
            {t('recovery.rewindFacts', {
              checkpoint: result.checkpoint,
              files: result.files.length,
              removed: result.removedEvents ?? t('recovery.unreported'),
              messages: result.messageCount ?? t('recovery.unreported'),
            })}
          </p>
          {result.files.map((path) => (
            <button
              type="button"
              className="recovery-file-link"
              key={path}
              onClick={() => onOpenFile(path)}
            >
              <FileCode size={14} />
              {path}
            </button>
          ))}
          {retryNote && <p role="status">{retryNote}</p>}
          {result.promptText && onEditPrompt && (
            <RewoundPrompt
              key={`${result.checkpoint}:${result.promptText}`}
              text={result.promptText}
              draftEmpty={draftEmpty}
              onEdit={onEditPrompt}
            />
          )}
          {result.errors.length > 0 && (
            <>
              <p>{t('recovery.fileErrors')}</p>
              <ul>
                {result.errors.map((item, index) => (
                  <li key={`${index}-${item}`}>{item}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {redone && (
        <section className="recovery-outcome" aria-label={t('recovery.redoLabel')}>
          <h3>{t('recovery.redone')}</h3>
          <p>
            {t('recovery.redoFacts', {
              checkpoint: redone.checkpoint,
              files: redone.files.length,
              messages: redone.messageCount ?? t('recovery.unreported'),
            })}
          </p>
          {redone.files.map((path) => (
            <button
              type="button"
              className="recovery-file-link"
              key={path}
              onClick={() => onOpenFile(path)}
            >
              <FileCode size={14} />
              {path}
            </button>
          ))}
        </section>
      )}
      <RecoveryRecords records={records} error={recordsError} onOpenFile={onOpenFile} />
      {inspect && (
        <>
          <div className="recovery-identity">
            <div>
              <h3>
                {sessionTitle ||
                  String(inspect['name'] || inspect['title'] || t('recovery.recorded'))}
              </h3>
              <p>
                {String(inspect['provider'] ?? t('recovery.unknownProvider'))} /{' '}
                {String(inspect['model'] ?? t('recovery.unknownModel'))}
              </p>
            </div>
            <CopyButton text={sessionId} label={t('recovery.copyId')} />
            <small>
              {inspect['endedAt']
                ? t('recovery.startedEnded', {
                    time: when(inspect['startedAt']),
                    ended: when(inspect['endedAt']),
                  })
                : t('recovery.started', { time: when(inspect['startedAt']) })}
            </small>
          </div>
          <div className="recovery-metrics">
            {[
              'retainedMessageCount',
              'iterationCount',
              'toolCallCount',
              'toolErrorCount',
              'fileChangeCount',
              'journalTokenTotal',
            ].map((key) => (
              <article key={key}>
                <span>{t(`recovery.metric.${key}`)}</span>
                <strong>
                  {typeof inspect[key] === 'number'
                    ? Number(inspect[key]).toLocaleString(displayLocale())
                    : t('recovery.notReported')}
                </strong>
              </article>
            ))}
          </div>
        </>
      )}
      <section className="recovery-checkpoints" aria-label={t('recovery.checkpointsLabel')}>
        <header>
          <Clock3 size={18} />
          <div>
            <h3>{t('recovery.returnTitle')}</h3>
            <p>{t('recovery.returnHint')}</p>
          </div>
          <button
            type="button"
            className="button secondary small"
            disabled={busy || running}
            title={t('recovery.redoTitle')}
            onClick={() => void redo()}
          >
            <RotateCcw size={14} />
            {t('recovery.redo')}
          </button>
          {onRetryPrompt && (
            <button
              type="button"
              className="button secondary small"
              disabled={busy || running || !revision || !retryCheckpoint(checkpoints)}
              title={t('recovery.retryTitle')}
              onClick={() => {
                const newest = retryCheckpoint(checkpoints);
                if (!newest) return;
                setRetrying(true);
                setConfirm(newest);
              }}
            >
              <RefreshCw size={14} />
              {t('recovery.retry')}
            </button>
          )}
        </header>
        {running && (
          <p role="status" className="settings-defaults-note">
            {t('recovery.stopFirst')}
          </p>
        )}
        {checkpointError && (
          <p role="alert" className="session-error">
            {t('recovery.checkpointError', { error: checkpointError })}
          </p>
        )}
        {!loading && !checkpointError && !checkpoints.length && (
          <p className="quiet-state">{t('recovery.noCheckpoints')}</p>
        )}
        {boundaries
          .slice()
          .reverse()
          .map((point, index) => (
            <article key={`${point.promptIndex}-${point.ts}-${index}`}>
              <span className="recovery-checkpoint-index">{point.promptIndex}</span>
              <div>
                <strong>{point.promptPreview || t('recovery.noPromptText')}</strong>
                <small>
                  {t('recovery.snapshots', {
                    count: point.fileCount,
                    time: when(point.ts),
                  })}
                </small>
              </div>
              <button
                type="button"
                className="button secondary small"
                disabled={running || busy || loading || !revision}
                onClick={() => {
                  setError('');
                  setConfirm(point);
                }}
                aria-label={t('recovery.reviewLabel', { n: point.promptIndex })}
              >
                <RotateCcw size={13} />
                {t('recovery.review')}
              </button>
            </article>
          ))}
        <p className="field-help">{t('recovery.snapshotHint')}</p>
      </section>
      {inspect && (
        <div className="recovery-detail-grid">
          <section className="recovery-events" aria-label={t('recovery.eventsLabel')}>
            <h3>{t('recovery.follow')}</h3>
            <div className="recovery-event-filters">
              <label>
                <Search size={14} />
                <input
                  aria-label={t('recovery.search')}
                  placeholder={t('recovery.searchPlaceholder')}
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setLimit(100);
                  }}
                />
              </label>
              <select
                aria-label={t('recovery.typeLabel')}
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value);
                  setLimit(100);
                }}
              >
                <option value="">{t('recovery.allTypes')}</option>
                {[...new Set(events.map((event) => String(event['type'])))].sort().map((type) => (
                  <option key={type} value={type}>
                    {type.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </div>
            <p className="field-help">{t('recovery.matching', { count: matching.length })}</p>
            <ol>
              {matching
                .slice(-limit)
                .reverse()
                .map((event, index) => (
                  <li key={`${event['ts']}-${index}`}>
                    <span className="recovery-timeline-dot" />
                    <div>
                      <small>{when(event['ts'])}</small>
                      <strong>{String(event['label'] ?? '')}</strong>
                      {event['detail'] ? <p>{String(event['detail'])}</p> : null}
                    </div>
                  </li>
                ))}
            </ol>
            {!matching.length && <p className="quiet-state">{t('recovery.noMatch')}</p>}
            {matching.length > limit && (
              <button
                type="button"
                className="button secondary"
                onClick={() => setLimit((value) => value + 100)}
              >
                {t('recovery.older')}
              </button>
            )}
          </section>
          <aside>
            <section className="recovery-tools">
              <h3>{t('recovery.tools')}</h3>
              {tools.map(([name, count]) => (
                <div key={name}>
                  <span>{name}</span>
                  <strong>{count}</strong>
                  <progress
                    aria-label={t('recovery.toolCalls', { name })}
                    value={count}
                    max={maxToolCount}
                  />
                </div>
              ))}
              {!tools.length && <p className="quiet-state">{t('recovery.noTools')}</p>}
            </section>
            <section className="recovery-files">
              <h3>{t('recovery.files')}</h3>
              {entries(inspect['fileEvents'])
                .slice(-100)
                .reverse()
                .map((file, index) => (
                  <article key={`${file['ts']}-${index}`}>
                    <button
                      type="button"
                      className="recovery-file-link"
                      onClick={() => onOpenFile(String(file['filePath']))}
                    >
                      <FileCode size={14} />
                      {String(file['filePath'])}
                    </button>
                    <small>
                      {t(`chronicleView.insights.operation.${String(file['operation'])}`, {
                        defaultValue: String(file['operation']),
                      })}{' '}
                      · {String(file['toolName'])} · {when(file['ts'])}
                    </small>
                  </article>
                ))}
              {!entries(inspect['fileEvents']).length && (
                <p className="quiet-state">{t('recovery.noFiles')}</p>
              )}
              <p className="field-help">{t('recovery.filesHint')}</p>
            </section>
          </aside>
        </div>
      )}
      {confirm && (
        <Modal
          onClose={() => {
            if (!busy) {
              setConfirm(null);
              setRetrying(false);
            }
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void rewind();
            }}
          >
            <span className="eyebrow">
              {retrying ? t('recovery.retryEyebrow') : t('recovery.rewindEyebrow')}
            </span>
            <h2 id="dialog-title">
              {t(retrying ? 'recovery.retryAsk' : 'recovery.rewindAsk', { n: confirm.promptIndex })}
            </h2>
            <p>{confirm.promptPreview}</p>
            <p>{t('recovery.confirmBody', { count: snapshotCount })}</p>
            <p>{t('recovery.draftKept')}</p>
            {error && (
              <p role="alert" className="session-error">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setConfirm(null);
                  setRetrying(false);
                }}
              >
                {t('recovery.keep')}
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={busy || running || !revision}
              >
                {busy
                  ? t('recovery.rewinding')
                  : retrying
                    ? t('recovery.rewindSend')
                    : t('recovery.confirm')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

/**
 * The prompt a rewind took back, offered for editing in the composer. Unsent composer text is
 * replaced only after an explicit choice.
 */
export function RewoundPrompt({
  text,
  draftEmpty,
  onEdit,
}: {
  text: string;
  draftEmpty: boolean;
  onEdit: (text: string) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const { t } = useDesktopText();
  return (
    <div className="recovery-rewound-prompt">
      <h4>{t('recovery.prompt.title')}</h4>
      <pre>{text}</pre>
      <p className="field-help">{t('recovery.prompt.hint')}</p>
      {replacing ? (
        <div className="recovery-prompt-actions">
          <span>{t('recovery.prompt.unsent')}</span>
          <button type="button" className="button primary small" onClick={() => onEdit(text)}>
            {t('recovery.prompt.replace')}
          </button>
          <button
            type="button"
            className="button secondary small"
            onClick={() => setReplacing(false)}
          >
            {t('recovery.prompt.keep')}
          </button>
        </div>
      ) : (
        <div className="recovery-prompt-actions">
          <button
            type="button"
            className="button primary small"
            onClick={() => (draftEmpty ? onEdit(text) : setReplacing(true))}
          >
            {t('recovery.prompt.edit')}
          </button>
          <CopyButton text={text} label={t('recovery.prompt.copy')} />
        </div>
      )}
    </div>
  );
}
