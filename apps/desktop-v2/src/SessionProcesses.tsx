import { ArrowLeft, RefreshCw, Search, Square, Terminal, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { Modal } from './Modal';
import { ProcessKillAll } from './ProcessKillAll';
import { ProcessPreviewLinks } from './ProcessPreviewLinks';
import {
  batchTermination,
  batchTerminationSummary,
  type EndedProcess,
  endedProcesses,
  endLabel,
  observedDuration,
  processKey,
  type ReportedEnd,
  reportedEnded,
  type SessionProcess,
  sameSessionProcess,
  sessionProcesses,
  terminable,
} from './session-process-model';
import { surfaceI18n } from './surface-i18n';
import './session-processes.css';
import { displayDateTime, displayTime } from './display-dates';

/** Ended runs seen by this window, per session; kept while the window stays open. */
const endedBySession = new Map<
  string,
  { ended: EndedProcess[]; last: SessionProcess[]; at: number }
>();

export function SessionProcesses({
  sessionId,
  connected,
  command,
  onBack,
}: {
  sessionId: string;
  connected: boolean;
  command: EngineCommand;
  onBack: () => void;
}) {
  const { t } = useDesktopText();
  const endWords = {
    terminatedExit: (code: number) => t('processes.end.terminatedExit', { code }),
    exit: (code: number) => t('processes.end.exit', { code }),
    terminatedSignal: (signal: string) => t('processes.end.terminatedSignal', { signal }),
    stopped: (signal: string) => t('processes.end.stopped', { signal }),
    terminatedUnreported: t('processes.end.terminatedUnreported'),
    unreported: t('processes.end.unreported'),
  };
  const [processes, setProcesses] = useState<SessionProcess[]>([]),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [query, setQuery] = useState(''),
    [loading, setLoading] = useState(false),
    [pending, setPending] = useState(false),
    [selected, setSelected] = useState<SessionProcess | null>(null),
    [review, setReview] = useState<SessionProcess | null>(null),
    [output, setOutput] = useState<string[] | null>(null),
    [outputError, setOutputError] = useState(''),
    [outputBusy, setOutputBusy] = useState(false),
    [lines, setLines] = useState(100),
    [picked, setPicked] = useState<string[]>([]),
    [batchReview, setBatchReview] = useState(false),
    [ended, setEnded] = useState<EndedProcess[]>(() => endedBySession.get(sessionId)?.ended ?? []);
  const alive = useRef(true),
    reading = useRef(false),
    operating = useRef(false),
    outputSequence = useRef(0);
  // Engines that report ended processes with their exit replace the list this window observed.
  const [reported, setReported] = useState<ReportedEnd[] | null>(null);
  const read = useCallback(async () => {
    const payload = await command('process.list', { sessionId }, [
      'process.list',
      'key.operation_result',
    ]);
    const rows = sessionProcesses(payload, sessionId);
    if (alive.current) setReported(reportedEnded(payload, sessionId));
    return rows;
  }, [command, sessionId]);
  const refresh = useCallback(async () => {
    if (!connected || reading.current || !sessionId) return;
    reading.current = true;
    setLoading(true);
    try {
      const rows = await read();
      const now = Date.now();
      const history = endedBySession.get(sessionId);
      const next = history
        ? endedProcesses(history.ended, history.last, rows, history.at, now)
        : [];
      endedBySession.set(sessionId, { ended: next, last: rows, at: now });
      if (alive.current) {
        setEnded(next);
        setProcesses(rows);
        setLoaded(true);
        setError('');
      }
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      reading.current = false;
      if (alive.current) setLoading(false);
    }
  }, [read, connected, sessionId]);
  useEffect(() => {
    alive.current = true;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      alive.current = false;
      stopped = true;
      outputSequence.current++;
      clearTimeout(timer);
    };
  }, [refresh]);
  const readOutput = async (proc: SessionProcess, count = lines) => {
    const sequence = ++outputSequence.current;
    setSelected(proc);
    setOutput(null);
    setOutputError('');
    setOutputBusy(true);
    try {
      const rows = await read(),
        current = rows.find((row) => sameSessionProcess(row, proc));
      if (!current) throw Error(t('processes.changedOutput'));
      if (!current.hasOutput) throw Error(t('processes.noLog'));
      const result = await command(
        'process.output',
        { sessionId, pid: proc.pid, expectedStartedAt: current.startedAt, lines: count },
        ['process.output', 'key.operation_result'],
      );
      if (result['sessionId'] !== sessionId || result['pid'] !== proc.pid)
        throw Error(t('processes.otherProcess'));
      if (result['gone']) throw Error(t('processes.gone'));
      if (
        !Array.isArray(result['lines']) ||
        !result['lines'].every((line) => typeof line === 'string')
      )
        throw Error(t('processes.invalidLines'));
      const text = result['lines'].slice(-count).join('\n');
      if (text.length > 262144) throw Error(t('processes.tooLarge'));
      if (alive.current && sequence === outputSequence.current)
        setOutput(result['lines'].slice(-count));
    } catch (error) {
      if (alive.current && sequence === outputSequence.current)
        setOutputError(error instanceof Error ? error.message : String(error));
    } finally {
      if (alive.current && sequence === outputSequence.current) setOutputBusy(false);
    }
  };
  const terminate = async (proc: SessionProcess) => {
    if (operating.current) return;
    operating.current = true;
    setPending(true);
    setError('');
    setNotice('');
    try {
      const rows = await read(),
        current = rows.find((row) => sameSessionProcess(row, proc));
      if (!current || current.protected || current.status !== 'running')
        throw Error(t('processes.notSent'));
      const result = await command(
        'process.kill',
        { sessionId, pid: proc.pid, expectedStartedAt: current.startedAt },
        ['key.operation_result'],
      );
      if (!alive.current) return;
      setNotice(
        t('processes.refreshVerifies', {
          message: String(result['message'] ?? t('processes.acknowledged')),
        }),
      );
      setReview(null);
      await refresh();
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      operating.current = false;
      if (alive.current) setPending(false);
    }
  };
  // Picks follow the list: a process that exited or became protected drops out.
  const pickedProcesses = processes.filter(
    (proc) => terminable(proc) && picked.includes(processKey(proc)),
  );
  const terminateBatch = async (targets: SessionProcess[]) => {
    if (operating.current) return;
    operating.current = true;
    setPending(true);
    setError('');
    setNotice('');
    try {
      const { send, skipped } = batchTermination(targets, await read());
      const done: SessionProcess[] = [],
        failed: { proc: SessionProcess; error: string }[] = [];
      for (const proc of send) {
        if (!alive.current) return;
        try {
          await command(
            'process.kill',
            { sessionId, pid: proc.pid, expectedStartedAt: proc.startedAt },
            ['key.operation_result'],
          );
          done.push(proc);
        } catch (failure) {
          failed.push({
            proc,
            error: failure instanceof Error ? failure.message : String(failure),
          });
        }
      }
      if (!alive.current) return;
      setNotice(
        batchTerminationSummary(targets.length, done, failed, skipped, {
          acknowledged: (count, total) => t('processes.batch.acknowledged', { done: count, total }),
          failed: (list) => t('processes.batch.failed', { list }),
          skipped: (list) => t('processes.batch.skipped', { list }),
          refresh: t('processes.batch.refresh'),
        }),
      );
      setPicked([]);
      setBatchReview(false);
      await refresh();
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      operating.current = false;
      if (alive.current) setPending(false);
    }
  };
  const visible = processes.filter((proc) =>
    `${proc.pid} ${proc.command} ${proc.tool}`.toLowerCase().includes(query.toLowerCase()),
  );
  const selectable = visible.filter(terminable),
    allPicked =
      selectable.length > 0 && selectable.every((proc) => picked.includes(processKey(proc)));
  return (
    <section className="session-processes" aria-label={t('processes.label')}>
      <header>
        <div>
          <span className="eyebrow">{t('processes.eyebrow')}</span>
          <h2>{t('processes.title')}</h2>
          <p>{t('processes.intro')}</p>
        </div>
        <div className="feature-actions">
          <button type="button" className="button secondary" onClick={onBack}>
            <ArrowLeft size={14} />
            {t('processes.back')}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!connected || loading || pending}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} />
            {t('processes.refresh')}
          </button>
          <ProcessKillAll
            sessionId={sessionId}
            running={processes.filter((proc) => proc.status === 'running').length}
            connected={connected}
            busy={pending}
            command={command}
            onDone={(result) => {
              setNotice(result.ok ? result.message : '');
              setError(result.ok ? '' : result.message);
              void refresh();
            }}
          />
        </div>
      </header>
      <div className="process-summary">
        <span>
          <Trans
            i18n={surfaceI18n}
            ns="desktop"
            i18nKey="processes.running"
            values={{ n: processes.filter((proc) => proc.status === 'running').length }}
            components={{ strong: <strong /> }}
          />
        </span>
        <span>
          {t('processes.backgroundCount', {
            n: processes.filter((proc) => proc.background).length,
          })}
        </span>
        <span>
          {t('processes.protectedCount', { n: processes.filter((proc) => proc.protected).length })}
        </span>
        <small>{connected ? t('processes.polling') : t('processes.disconnected')}</small>
      </div>
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
      <label className="process-search">
        <Search size={14} />
        <input
          aria-label={t('processes.search')}
          placeholder={t('processes.searchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {connected && processes.some(terminable) && (
        <div className="process-batch-bar" role="toolbar" aria-label={t('processes.selection')}>
          <span>{t('processes.selected', { n: pickedProcesses.length })}</span>
          <button
            type="button"
            className="button secondary small"
            disabled={pending}
            onClick={() => setPicked(allPicked ? [] : selectable.map(processKey))}
          >
            {allPicked ? t('processes.clearSelection') : t('processes.selectAll')}
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={pending || !pickedProcesses.length}
            onClick={() => {
              setError('');
              setBatchReview(true);
            }}
          >
            <Square size={12} />
            {t('processes.terminateSelected')}
          </button>
        </div>
      )}
      {!connected ? (
        <p className="quiet-state">{t('processes.reconnect')}</p>
      ) : !loaded ? (
        <p role="status">{error ? t('processes.unavailable') : t('processes.reading')}</p>
      ) : !visible.length ? (
        <div className="process-empty">
          <Terminal size={30} />
          <h3>{processes.length ? t('processes.noMatch') : t('processes.none')}</h3>
          <p>{t('processes.noExecute')}</p>
        </div>
      ) : (
        <div className="process-list">
          {visible.map((proc) => (
            <article key={`${proc.pid}:${proc.startedAt}`} data-process-pid={proc.pid}>
              <header>
                {terminable(proc) && (
                  <input
                    type="checkbox"
                    aria-label={t('processes.selectPid', { pid: proc.pid })}
                    checked={picked.includes(processKey(proc))}
                    disabled={pending}
                    onChange={(event) =>
                      setPicked((current) =>
                        event.target.checked
                          ? [...current, processKey(proc)]
                          : current.filter((key) => key !== processKey(proc)),
                      )
                    }
                  />
                )}
                <span className={`process-status ${proc.status}`}>
                  {t(`processes.status.${proc.status}`, { defaultValue: proc.status })}
                </span>
                <code>PID {proc.pid}</code>
                <small>
                  {proc.tool}
                  {` · ${proc.background ? t('processes.background') : t('processes.foreground')}`}
                  {proc.protected ? ` · ${t('processes.protected')}` : ''}
                </small>
              </header>
              <pre>{proc.command}</pre>
              <footer>
                <time dateTime={new Date(proc.startedAt).toISOString()}>
                  {t('processes.started', { time: displayDateTime(proc.startedAt) })}
                </time>
                <div className="feature-actions">
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={!connected || pending}
                    onClick={() => void readOutput(proc)}
                  >
                    {proc.hasOutput ? t('processes.viewOutput') : t('processes.outputDetails')}
                  </button>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={!connected || pending || proc.protected || proc.status !== 'running'}
                    onClick={() => {
                      setError('');
                      setReview(proc);
                    }}
                  >
                    <Square size={12} />
                    {t('processes.terminate')}
                  </button>
                </div>
              </footer>
            </article>
          ))}
        </div>
      )}
      {reported && reported.length > 0 && (
        <details className="process-ended">
          <summary>{t('processes.ended', { n: reported.length })}</summary>
          <p className="field-help">{t('processes.reportedHint')}</p>
          <ul aria-label={t('processes.endedLabel')}>
            {reported.map((item) => {
              const end = endLabel(item, endWords);
              return (
                <li key={`${item.pid}:${item.startedAt}`}>
                  <code>PID {item.pid}</code> {item.tool}
                  {item.background ? ` · ${t('processes.background')}` : ''}
                  <b
                    className={
                      end.failed === null
                        ? 'process-end'
                        : end.failed
                          ? 'process-end failed'
                          : 'process-end ok'
                    }
                  >
                    {end.text}
                  </b>
                  <pre>{item.command}</pre>
                  <small>
                    {t('processes.reportedTimes', {
                      started: displayDateTime(item.startedAt),
                      ended: displayTime(item.endedAt),
                      duration: observedDuration(item.startedAt, item.endedAt),
                    })}
                  </small>
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {!reported && ended.length > 0 && (
        <details className="process-ended">
          <summary>{t('processes.ended', { n: ended.length })}</summary>
          <p className="field-help">{t('processes.observedHint')}</p>
          <ul aria-label={t('processes.endedLabel')}>
            {ended.map((item) => (
              <li key={`${item.proc.pid}:${item.proc.startedAt}`}>
                <code>PID {item.proc.pid}</code> {item.proc.tool}
                {item.proc.background ? ` · ${t('processes.background')}` : ''}
                <pre>{item.proc.command}</pre>
                <small>
                  {t('processes.observedTimes', {
                    started: displayDateTime(item.proc.startedAt),
                    seen: displayTime(item.lastSeenAt),
                    gone: displayTime(item.goneBy),
                    duration: observedDuration(item.proc.startedAt, item.lastSeenAt),
                  })}
                </small>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="button secondary small"
            onClick={() => {
              const history = endedBySession.get(sessionId);
              if (history) endedBySession.set(sessionId, { ...history, ended: [] });
              setEnded([]);
            }}
          >
            {t('processes.clearEnded')}
          </button>
        </details>
      )}
      {selected && (
        <aside
          className="process-output"
          aria-label={t('processes.outputLabel', { pid: selected.pid })}
        >
          <header>
            <div>
              <span className="eyebrow">{t('processes.logEyebrow')}</span>
              <h3>
                PID {selected.pid} · {selected.tool}
              </h3>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={t('processes.closeOutput')}
              onClick={() => {
                outputSequence.current++;
                setSelected(null);
              }}
            >
              <X size={16} />
            </button>
          </header>
          <div className="feature-actions">
            <select
              aria-label={t('processes.lineCount')}
              value={lines}
              onChange={(event) => {
                const next = Number(event.target.value);
                setLines(next);
                void readOutput(selected, next);
              }}
            >
              {[50, 100, 200].map((count) => (
                <option key={count} value={count}>
                  {t('processes.lastLines', { n: count })}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button secondary small"
              disabled={!connected || outputBusy}
              onClick={() => void readOutput(selected)}
            >
              {t('processes.refreshOutput')}
            </button>
          </div>
          {outputBusy && <p role="status">{t('processes.readingOutput')}</p>}
          {outputError && (
            <p className="session-error" role="alert">
              {outputError}
            </p>
          )}
          {output !== null && (
            <>
              <ProcessPreviewLinks lines={output} />
              <pre>{output.join('\n') || t('processes.emptyLog')}</pre>
            </>
          )}
        </aside>
      )}
      {batchReview && (
        <Modal
          title={t('processes.batchTitle')}
          onClose={() => {
            if (!pending) setBatchReview(false);
          }}
        >
          <div className="process-review">
            <h2>
              {t(
                pickedProcesses.length === 1 ? 'processes.batchAskOne' : 'processes.batchAskMany',
                {
                  n: pickedProcesses.length,
                },
              )}
            </h2>
            <ul aria-label={t('processes.batchList')}>
              {pickedProcesses.map((proc) => (
                <li key={processKey(proc)}>
                  <code>PID {proc.pid}</code> {proc.command}
                </li>
              ))}
            </ul>
            <p>{t('processes.batchBody')}</p>
            {error && (
              <p role="alert" className="session-error">
                {error}
              </p>
            )}
            <div className="feature-actions">
              <button
                type="button"
                className="button secondary"
                disabled={pending}
                onClick={() => setBatchReview(false)}
              >
                {t('processes.keepAll')}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={pending || !connected || !pickedProcesses.length}
                onClick={() => void terminateBatch(pickedProcesses)}
              >
                {pending
                  ? t('processes.requesting')
                  : t('processes.confirmBatch', { n: pickedProcesses.length })}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {review && (
        <Modal
          title={t('processes.singleTitle')}
          onClose={() => {
            if (!pending) setReview(null);
          }}
        >
          <div className="process-review">
            <h2>{t('processes.singleAsk', { pid: review.pid })}</h2>
            <pre>{review.command}</pre>
            <p>{t('processes.singleBody')}</p>
            {error && (
              <p role="alert" className="session-error">
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
                {t('processes.keepOne')}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={pending || !connected}
                onClick={() => void terminate(review)}
              >
                {pending ? t('processes.requesting') : t('processes.confirmSingle')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
