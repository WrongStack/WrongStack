import { ArrowLeft, RefreshCw, Search, Square, Terminal, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { Modal } from './Modal';
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
import './session-processes.css';

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
      if (!current) throw Error('This process has exited or changed. Refresh the process list.');
      if (!current.hasOutput)
        throw Error(
          'This command has no background output log. Its foreground output appears in run activity.',
        );
      const result = await command(
        'process.output',
        { sessionId, pid: proc.pid, expectedStartedAt: current.startedAt, lines: count },
        ['process.output', 'key.operation_result'],
      );
      if (result['sessionId'] !== sessionId || result['pid'] !== proc.pid)
        throw Error('Output belongs to another process or conversation.');
      if (result['gone']) throw Error('The process is no longer tracked.');
      if (
        !Array.isArray(result['lines']) ||
        !result['lines'].every((line) => typeof line === 'string')
      )
        throw Error('The engine returned invalid output lines.');
      const text = result['lines'].slice(-count).join('\n');
      if (text.length > 262144)
        throw Error('Output exceeds the display limit. Request fewer lines.');
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
        throw Error('This process changed, exited or became protected. No termination was sent.');
      const result = await command(
        'process.kill',
        { sessionId, pid: proc.pid, expectedStartedAt: current.startedAt },
        ['key.operation_result'],
      );
      if (!alive.current) return;
      setNotice(
        `${String(result['message'] ?? 'The engine acknowledged termination.')} Refresh verifies whether it is still tracked.`,
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
      setNotice(batchTerminationSummary(targets.length, done, failed, skipped));
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
    <section className="session-processes" aria-label="Session processes">
      <header>
        <div>
          <span className="eyebrow">THIS CONVERSATION</span>
          <h2>Processes</h2>
          <p>
            Commands tracked by this session's engine. Native terminal tabs remain in the session
            tree.
          </p>
        </div>
        <div className="feature-actions">
          <button type="button" className="button secondary" onClick={onBack}>
            <ArrowLeft size={14} />
            Back to conversation
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!connected || loading || pending}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} />
            Refresh processes
          </button>
        </div>
      </header>
      <div className="process-summary">
        <span>
          <strong>{processes.filter((proc) => proc.status === 'running').length}</strong> running
        </span>
        <span>{processes.filter((proc) => proc.background).length} background</span>
        <span>{processes.filter((proc) => proc.protected).length} protected</span>
        <small>{connected ? 'Metadata refreshes every 2 seconds' : 'Disconnected'}</small>
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
          aria-label="Search session processes"
          placeholder="Command, tool or PID…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {connected && processes.some(terminable) && (
        <div className="process-batch-bar" role="toolbar" aria-label="Process selection">
          <span>{pickedProcesses.length} selected</span>
          <button
            type="button"
            className="button secondary small"
            disabled={pending}
            onClick={() => setPicked(allPicked ? [] : selectable.map(processKey))}
          >
            {allPicked ? 'Clear selection' : 'Select all running'}
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
            Terminate selected…
          </button>
        </div>
      )}
      {!connected ? (
        <p className="quiet-state">Reconnect this conversation to inspect its commands.</p>
      ) : !loaded ? (
        <p role="status">
          {error
            ? 'Process metadata is unavailable. Refresh to try again.'
            : 'Reading tracked processes…'}
        </p>
      ) : !visible.length ? (
        <div className="process-empty">
          <Terminal size={30} />
          <h3>{processes.length ? 'No matching processes.' : 'No tracked processes.'}</h3>
          <p>Opening this view does not execute a command.</p>
        </div>
      ) : (
        <div className="process-list">
          {visible.map((proc) => (
            <article key={`${proc.pid}:${proc.startedAt}`} data-process-pid={proc.pid}>
              <header>
                {terminable(proc) && (
                  <input
                    type="checkbox"
                    aria-label={`Select PID ${proc.pid}`}
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
                <span className={`process-status ${proc.status}`}>{proc.status}</span>
                <code>PID {proc.pid}</code>
                <small>
                  {proc.tool}
                  {proc.background ? ' · Background' : ' · Foreground'}
                  {proc.protected ? ' · Protected' : ''}
                </small>
              </header>
              <pre>{proc.command}</pre>
              <footer>
                <time dateTime={new Date(proc.startedAt).toISOString()}>
                  Started {new Date(proc.startedAt).toLocaleString()}
                </time>
                <div className="feature-actions">
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={!connected || pending}
                    onClick={() => void readOutput(proc)}
                  >
                    {proc.hasOutput ? 'View output' : 'Output details'}
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
                    Terminate process
                  </button>
                </div>
              </footer>
            </article>
          ))}
        </div>
      )}
      {reported && reported.length > 0 && (
        <details className="process-ended">
          <summary>Recently ended · {reported.length}</summary>
          <p className="field-help">
            Exits as the engine recorded them when each process left its registry.
          </p>
          <ul aria-label="Recently ended processes">
            {reported.map((item) => {
              const end = endLabel(item);
              return (
                <li key={`${item.pid}:${item.startedAt}`}>
                  <code>PID {item.pid}</code> {item.tool}
                  {item.background ? ' · Background' : ''}
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
                    Started {new Date(item.startedAt).toLocaleString()} · ended{' '}
                    {new Date(item.endedAt).toLocaleTimeString()} · ran{' '}
                    {observedDuration(item.startedAt, item.endedAt)}
                  </small>
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {!reported && ended.length > 0 && (
        <details className="process-ended">
          <summary>Recently ended · {ended.length}</summary>
          <p className="field-help">
            Runs this window saw that the engine no longer tracks. The engine does not report how
            they ended or their exit code; times are when this window last saw them.
          </p>
          <ul aria-label="Recently ended processes">
            {ended.map((item) => (
              <li key={`${item.proc.pid}:${item.proc.startedAt}`}>
                <code>PID {item.proc.pid}</code> {item.proc.tool}
                {item.proc.background ? ' · Background' : ''}
                <pre>{item.proc.command}</pre>
                <small>
                  Started {new Date(item.proc.startedAt).toLocaleString()} · last seen{' '}
                  {new Date(item.lastSeenAt).toLocaleTimeString()} · gone by{' '}
                  {new Date(item.goneBy).toLocaleTimeString()} · tracked for at least{' '}
                  {observedDuration(item.proc.startedAt, item.lastSeenAt)}
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
            Clear ended list
          </button>
        </details>
      )}
      {selected && (
        <aside className="process-output" aria-label={`Output for PID ${selected.pid}`}>
          <header>
            <div>
              <span className="eyebrow">REGISTERED BACKGROUND LOG</span>
              <h3>
                PID {selected.pid} · {selected.tool}
              </h3>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Close process output"
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
              aria-label="Process output line count"
              value={lines}
              onChange={(event) => {
                const next = Number(event.target.value);
                setLines(next);
                void readOutput(selected, next);
              }}
            >
              <option value={50}>Last 50 lines</option>
              <option value={100}>Last 100 lines</option>
              <option value={200}>Last 200 lines</option>
            </select>
            <button
              type="button"
              className="button secondary small"
              disabled={!connected || outputBusy}
              onClick={() => void readOutput(selected)}
            >
              Refresh output
            </button>
          </div>
          {outputBusy && <p role="status">Reading output…</p>}
          {outputError && (
            <p className="session-error" role="alert">
              {outputError}
            </p>
          )}
          {output !== null && (
            <>
              <ProcessPreviewLinks lines={output} />
              <pre>{output.join('\n') || 'The registered log has no output yet.'}</pre>
            </>
          )}
        </aside>
      )}
      {batchReview && (
        <Modal
          title="Terminate selected processes"
          onClose={() => {
            if (!pending) setBatchReview(false);
          }}
        >
          <div className="process-review">
            <h2>
              Terminate {pickedProcesses.length}{' '}
              {pickedProcesses.length === 1 ? 'process' : 'processes'}?
            </h2>
            <ul aria-label="Processes to terminate">
              {pickedProcesses.map((proc) => (
                <li key={processKey(proc)}>
                  <code>PID {proc.pid}</code> {proc.command}
                </li>
              ))}
            </ul>
            <p>
              Each selected command and its child process tree is stopped separately. A process that
              exits, changes or becomes protected before its turn is skipped and reported. Unsaved
              work inside these commands may be lost.
            </p>
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
                Keep processes running
              </button>
              <button
                type="button"
                className="button primary"
                disabled={pending || !connected || !pickedProcesses.length}
                onClick={() => void terminateBatch(pickedProcesses)}
              >
                {pending
                  ? 'Requesting termination…'
                  : `Confirm termination of ${pickedProcesses.length}`}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {review && (
        <Modal
          title="Terminate session process"
          onClose={() => {
            if (!pending) setReview(null);
          }}
        >
          <div className="process-review">
            <h2>Terminate PID {review.pid}?</h2>
            <pre>{review.command}</pre>
            <p>
              This stops the selected tracked command and its child process tree. Unsaved work
              inside that command may be lost.
            </p>
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
                Keep process running
              </button>
              <button
                type="button"
                className="button primary"
                disabled={pending || !connected}
                onClick={() => void terminate(review)}
              >
                {pending ? 'Requesting termination…' : 'Confirm process termination'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
