import { ArrowLeft, Clock3, FileCode, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CopyButton } from './CopyButton';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { Modal } from './Modal';
import {
  checkpointBoundaries,
  checkpointMatches,
  type RecoveryCheckpoint,
  recoveryCheckpoints,
  recoveryDate,
  recoveryResult,
  redoResult,
} from './session-recovery-model';
import './session-recovery.css';

export function SessionRecovery({
  sessionId,
  sessionTitle,
  running,
  command,
  onBack,
  onOpenFile,
}: {
  sessionId: string;
  sessionTitle: string;
  running: boolean;
  command: EngineCommand;
  onBack: () => void;
  onOpenFile: (path: string) => void;
}) {
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
  const [search, setSearch] = useState(''),
    [kind, setKind] = useState(''),
    [limit, setLimit] = useState(100);
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
    mutation.current = true;
    setBusy(true);
    setError('');
    try {
      const fresh = await command('session.checkpoints', { includeRevision: true }, [
        'session.checkpoints',
      ]);
      if (
        fresh['journalRevision'] !== revision ||
        !checkpointMatches(checkpoints, recoveryCheckpoints(fresh['checkpoints']))
      )
        throw Error(
          'The session changed after this review. Close this dialog and refresh checkpoints.',
        );
      const reply = await command(
        'session.rewind',
        { checkpointIndex: target.promptIndex, expectedJournalRevision: revision },
        ['key.operation_result'],
        { timeoutMs: 120000 },
      );
      if (!mounted.current) return;
      const observed = recoveryResult(reply);
      if (!observed)
        throw Error(
          'The engine acknowledged rewind without a detailed result. Refresh and inspect the journal before another action.',
        );
      setResult(observed);
      setConfirm(null);
      await load();
    } catch (error) {
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
    try {
      const reply = await command('session.redo', {}, ['key.operation_result'], {
        timeoutMs: 120000,
      });
      if (!mounted.current) return;
      const observed = redoResult(reply);
      if (!observed)
        throw Error(
          'The engine acknowledged the redo without a detailed result. Refresh and inspect the journal.',
        );
      setRedone(observed);
      setResult(null);
      await load();
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
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
    <section className="session-recovery" aria-label="Session history and recovery">
      <header className="recovery-heading">
        <div>
          <span className="eyebrow">THIS CONVERSATION · RECORDED HISTORY</span>
          <h2>
            History & recovery<span className="heading-dot">.</span>
          </h2>
          <p>
            Inspect the journal, follow file activity, or return to a recorded prompt checkpoint.
          </p>
        </div>
        <div>
          <button type="button" className="button secondary" disabled={busy} onClick={onBack}>
            <ArrowLeft size={14} />
            Back to chat
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            <RefreshCw size={14} />
            Refresh session history
          </button>
        </div>
      </header>
      {error && !confirm && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {loading && <p role="status">Reading this session’s journal…</p>}
      {result && (
        <section
          className={`recovery-outcome ${result.errors.length ? 'recovery-partial' : ''}`}
          aria-label="Observed rewind result"
        >
          <h3>
            {result.errors.length
              ? 'Conversation rewound · file errors need attention'
              : 'Rewind completed'}
          </h3>
          <p>
            Checkpoint {result.checkpoint} · Restored files: {result.files.length} · Removed journal
            events: {result.removedEvents ?? 'Unreported'} · Retained messages:{' '}
            {result.messageCount ?? 'Unreported'}
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
          {result.errors.length > 0 && (
            <>
              <p>
                The conversation journal has already been cut back. These file operations did not
                complete; inspect the files before continuing.
              </p>
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
        <section className="recovery-outcome" aria-label="Observed redo result">
          <h3>Rewind redone</h3>
          <p>
            Checkpoint {redone.checkpoint} · Re-applied files: {redone.files.length} · Messages:{' '}
            {redone.messageCount ?? 'Unreported'}
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
      {inspect && (
        <>
          <div className="recovery-identity">
            <div>
              <h3>
                {sessionTitle ||
                  String(inspect['name'] || inspect['title'] || 'Recorded conversation')}
              </h3>
              <p>
                {String(inspect['provider'] ?? 'Unknown provider')} /{' '}
                {String(inspect['model'] ?? 'Unknown model')}
              </p>
            </div>
            <CopyButton text={sessionId} label="Copy core session ID" />
            <small>
              Started {recoveryDate(inspect['startedAt'])}
              {inspect['endedAt'] ? ` · Ended ${recoveryDate(inspect['endedAt'])}` : ''}
            </small>
          </div>
          <div className="recovery-metrics">
            {[
              ['Retained messages', 'retainedMessageCount'],
              ['Iterations', 'iterationCount'],
              ['Tool calls', 'toolCallCount'],
              ['Tool errors', 'toolErrorCount'],
              ['Recorded file changes', 'fileChangeCount'],
              ['Journal usage tokens', 'journalTokenTotal'],
            ].map(([label, key]) => (
              <article key={key}>
                <span>{label}</span>
                <strong>
                  {typeof inspect[key!] === 'number'
                    ? Number(inspect[key!]).toLocaleString()
                    : 'Not reported'}
                </strong>
              </article>
            ))}
          </div>
        </>
      )}
      <section className="recovery-checkpoints" aria-label="Prompt checkpoints">
        <header>
          <Clock3 size={18} />
          <div>
            <h3>Return to a prompt</h3>
            <p>
              Rewind undoes the selected prompt and subsequent work, cuts the journal back and
              restores recorded file snapshots. Later manual edits can be overwritten.
            </p>
          </div>
          <button
            type="button"
            className="button secondary small"
            disabled={busy || running}
            title="Re-apply the newest rewind, unless a prompt was sent or its files changed since"
            onClick={() => void redo()}
          >
            <RotateCcw size={14} />
            Redo last rewind
          </button>
        </header>
        {running && (
          <p role="status" className="settings-defaults-note">
            Stop the active run and refresh before reviewing a rewind.
          </p>
        )}
        {checkpointError && (
          <p role="alert" className="session-error">
            Checkpoints could not be read: {checkpointError}
          </p>
        )}
        {!loading && !checkpointError && !checkpoints.length && (
          <p className="quiet-state">No prompt checkpoints recorded in this session.</p>
        )}
        {boundaries
          .slice()
          .reverse()
          .map((point, index) => (
            <article key={`${point.promptIndex}-${point.ts}-${index}`}>
              <span className="recovery-checkpoint-index">{point.promptIndex}</span>
              <div>
                <strong>{point.promptPreview || 'Prompt text not recorded'}</strong>
                <small>
                  {recoveryDate(point.ts)} · {point.fileCount} file snapshots at this prompt index
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
                aria-label={`Review rewind to prompt ${point.promptIndex}`}
              >
                <RotateCcw size={13} />
                Review rewind
              </button>
            </article>
          ))}
        <p className="field-help">
          Snapshot counts are recorded entries, not a unique-file preview. Unsaved composer drafts
          are kept separately. Rewind is not a Git checkout or a complete project backup.
        </p>
      </section>
      {inspect && (
        <div className="recovery-detail-grid">
          <section className="recovery-events" aria-label="Recorded session events">
            <h3>Follow the journal</h3>
            <div className="recovery-event-filters">
              <label>
                <Search size={14} />
                <input
                  aria-label="Search recorded session events"
                  placeholder="Find a recorded event…"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setLimit(100);
                  }}
                />
              </label>
              <select
                aria-label="Session event type"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value);
                  setLimit(100);
                }}
              >
                <option value="">All event types</option>
                {[...new Set(events.map((event) => String(event['type'])))].sort().map((type) => (
                  <option key={type} value={type}>
                    {type.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </div>
            <p className="field-help">
              {matching.length} matching recorded events. Search covers journal labels and recorded
              previews, not the complete message transcript.
            </p>
            <ol>
              {matching
                .slice(-limit)
                .reverse()
                .map((event, index) => (
                  <li key={`${event['ts']}-${index}`}>
                    <span className="recovery-timeline-dot" />
                    <div>
                      <small>{recoveryDate(event['ts'])}</small>
                      <strong>{String(event['label'] ?? '')}</strong>
                      {event['detail'] ? <p>{String(event['detail'])}</p> : null}
                    </div>
                  </li>
                ))}
            </ol>
            {!matching.length && <p className="quiet-state">No recorded events match.</p>}
            {matching.length > limit && (
              <button
                type="button"
                className="button secondary"
                onClick={() => setLimit((value) => value + 100)}
              >
                Show 100 older events
              </button>
            )}
          </section>
          <aside>
            <section className="recovery-tools">
              <h3>Tool footprint</h3>
              {tools.map(([name, count]) => (
                <div key={name}>
                  <span>{name}</span>
                  <strong>{count}</strong>
                  <progress
                    aria-label={`${name} recorded calls`}
                    value={count}
                    max={maxToolCount}
                  />
                </div>
              ))}
              {!tools.length && <p className="quiet-state">No tool calls recorded.</p>}
            </section>
            <section className="recovery-files">
              <h3>File activity</h3>
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
                      {String(file['operation'])} · {String(file['toolName'])} ·{' '}
                      {recoveryDate(file['ts'])}
                    </small>
                  </article>
                ))}
              {!entries(inspect['fileEvents']).length && (
                <p className="quiet-state">No file activity recorded.</p>
              )}
              <p className="field-help">
                Latest 100 file events. Opens the current file, not its historical contents.
              </p>
            </section>
          </aside>
        </div>
      )}
      {confirm && (
        <Modal
          onClose={() => {
            if (!busy) setConfirm(null);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void rewind();
            }}
          >
            <span className="eyebrow">REWIND THIS CONVERSATION</span>
            <h2 id="dialog-title">Undo prompt {confirm.promptIndex} and later work?</h2>
            <p>{confirm.promptPreview}</p>
            <p>
              {snapshotCount} recorded file snapshots belong to this prompt and later prompts. The
              engine will restore their recorded content, remove later conversation events and
              replace the live context. This can overwrite edits made since those snapshots.
            </p>
            <p>
              Your unsent composer draft will remain. This does not provide a complete file backup.
            </p>
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
                onClick={() => setConfirm(null)}
              >
                Keep current history
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={busy || running || !revision}
              >
                {busy ? 'Rewinding…' : 'Confirm checkpoint rewind'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
