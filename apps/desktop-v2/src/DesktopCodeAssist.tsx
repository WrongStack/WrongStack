import type { CodeAssistPreset } from '@wrongstack/webui-protocol';
import { Bot, Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CodeAssistEditReview } from './CodeAssistEditReview';
import type { EngineCommand, EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { MarkdownContent } from './MarkdownContent';
import { markdownTarget } from './markdown-target';
import { openExternal } from './platform';

export function DesktopCodeAssist({
  filePath,
  symbol,
  line,
  send,
  command,
  state,
  onEdited,
}: {
  filePath: string;
  symbol?: string;
  line?: number;
  send: EngineSend;
  /** Enables the before/after comparison and restore for editing runs. */
  command?: EngineCommand;
  state: EngineState;
  onEdited?: () => void;
}) {
  const [preset, setPreset] = useState<CodeAssistPreset>('overview'),
    [question, setQuestion] = useState(''),
    [allowEdits, setAllowEdits] = useState(false),
    [requestId, setRequestId] = useState(''),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [snapshot, setSnapshot] = useState<{ requestId: string; content: string } | null>(null),
    [snapshotNote, setSnapshotNote] = useState('');
  const current = useRef(''),
    completed = useRef('');
  const run = state.assists[requestId];
  const busy = pending || run?.status === 'running';
  useEffect(() => {
    if (!requestId) return;
    if (run) {
      setPending(false);
      if (run.status !== 'running') {
        current.current = '';
        if (run.appliedEdits && completed.current !== requestId) {
          completed.current = requestId;
          onEdited?.();
        }
      }
    }
  }, [run, requestId, onEdited]);
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => {
      setPending(false);
      setError('The code analysis exceeded its ten-minute run budget.');
      if (current.current)
        void send('code.assist.abort', { requestId: current.current }).catch(() => {});
      current.current = '';
    }, 600000);
    return () => clearTimeout(timer);
  }, [busy, send]);
  useEffect(
    () => () => {
      if (current.current)
        void send('code.assist.abort', { requestId: current.current }).catch(() => {});
    },
    [send],
  );
  const start = async () => {
    if (current.current) await send('code.assist.abort', { requestId: current.current });
    const id = crypto.randomUUID();
    const edits = (preset === 'fix' || preset === 'custom') && allowEdits;
    setSnapshot(null);
    setSnapshotNote('');
    // The target file is read before an editing run so its changes can be compared and undone.
    if (edits && command) {
      try {
        const read = await command('files.read', { filePath }, ['files.read']);
        if (read['binary'] || read['tooLarge'])
          setSnapshotNote('This file is not text, so its changes cannot be compared here.');
        else setSnapshot({ requestId: id, content: String(read['content'] ?? '') });
      } catch (e) {
        setSnapshotNote(
          `The file could not be read before the run (${e instanceof Error ? e.message : String(e)}); its changes cannot be compared here.`,
        );
      }
    }
    current.current = id;
    setRequestId(id);
    setPending(true);
    setError('');
    try {
      await send('code.assist.run', {
        requestId: id,
        filePath,
        preset,
        ...(symbol ? { symbol } : {}),
        ...(line ? { line } : {}),
        ...(preset === 'custom' ? { question } : {}),
        allowEdits: preset === 'fix' || preset === 'custom' ? allowEdits : false,
      });
    } catch (e) {
      setPending(false);
      current.current = '';
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="desktop-code-assist" aria-label="Code Assist">
      <header>
        <Bot size={16} />
        <div>
          <h3>Code Assist</h3>
          <span>
            {symbol ? `${symbol} · ` : ''}
            {filePath}
            {line ? `:${line}` : ''}
          </span>
        </div>
        {busy && (
          <button
            type="button"
            className="button secondary small"
            aria-label="Stop code analysis"
            onClick={() => void send('code.assist.abort', { requestId })}
          >
            <Square size={11} />
            Stop
          </button>
        )}
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <label>
          Analysis
          <select
            aria-label="Code analysis preset"
            value={preset}
            disabled={busy}
            onChange={(event) => {
              setPreset(event.target.value as CodeAssistPreset);
              setAllowEdits(false);
            }}
          >
            {[
              ['overview', 'Architecture overview'],
              ['explain', 'Explain this symbol'],
              ['quality', 'Quality & maintainability'],
              ['bugs', 'Find defects'],
              ['security', 'Security review'],
              ['tests', 'Test coverage & gaps'],
              ['impact', 'Change impact'],
              ['fix', 'Implement a fix'],
              ['custom', 'Ask a question'],
            ].map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
        </label>
        {preset === 'custom' && (
          <textarea
            aria-label="Question about code"
            placeholder="What would you like to understand?"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            required
            rows={3}
          />
        )}
        <div className="code-assist-run-options">
          {preset === 'fix' || preset === 'custom' ? (
            <label>
              <input
                type="checkbox"
                checked={allowEdits}
                disabled={busy}
                onChange={(event) => setAllowEdits(event.target.checked)}
              />
              Allow changes to project files
            </label>
          ) : (
            <span>Read-only analysis · no project files are modified</span>
          )}
          <button
            type="submit"
            className="button primary small"
            disabled={
              busy || (preset === 'fix' && !allowEdits) || (preset === 'custom' && !question.trim())
            }
          >
            <Play size={12} />
            {busy ? 'Analyzing…' : 'Run analysis'}
          </button>
        </div>
      </form>
      {(error || run?.error) && (
        <p className="session-error" role="alert">
          {error || run?.error}
        </p>
      )}
      {run?.appliedEdits && (
        <p className="code-assist-applied">
          This run was allowed to edit project files. Review the working tree changes.
          {snapshotNote ? ` ${snapshotNote}` : ''}
        </p>
      )}
      {run?.appliedEdits && run.status !== 'running' && command && run.edits && (
        // Engines that capture every written file: review and restore each one.
        <section className="code-assist-edit-list" aria-label="Files changed by this run">
          {run.edits.length === 0 && (
            <p className="file-quiet-state">No file writes were recorded for this run.</p>
          )}
          {run.edits.map((edit) => (
            <CodeAssistEditReview
              key={edit.path}
              command={command}
              path={edit.path}
              before={edit.before}
              note="Captured by the engine before this run first wrote the file."
              {...(onEdited ? { onRestored: onEdited } : {})}
            />
          ))}
          {run.uncaptured && run.uncaptured.length > 0 && (
            <p className="code-assist-applied">
              Not captured, review these in the working tree: {run.uncaptured.join(', ')}.
            </p>
          )}
        </section>
      )}
      {run?.appliedEdits &&
        run.status !== 'running' &&
        command &&
        !run.edits &&
        snapshot?.requestId === requestId && (
          <CodeAssistEditReview
            command={command}
            path={filePath}
            before={snapshot.content}
            {...(onEdited ? { onRestored: onEdited } : {})}
          />
        )}
      {run?.text && (
        <div className="code-assist-answer">
          <MarkdownContent
            text={run.text}
            onLink={(url) => {
              const target = markdownTarget(url);
              if (target?.kind === 'external') void openExternal(target.value).catch(() => {});
            }}
          />
        </div>
      )}
      {run?.status === 'aborted' && <p className="file-quiet-state">Analysis stopped.</p>}
    </section>
  );
}
