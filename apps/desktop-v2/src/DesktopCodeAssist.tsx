import type { CodeAssistPreset } from '@wrongstack/webui-protocol';
import { Bot, Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CodeAssistEditReview } from './CodeAssistEditReview';
import { useDesktopText } from './desktop-i18n';
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
  const { t } = useDesktopText();
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
      setError(t('codeAssist.budget'));
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
        if (read['binary'] || read['tooLarge']) setSnapshotNote(t('codeAssist.notText'));
        else setSnapshot({ requestId: id, content: String(read['content'] ?? '') });
      } catch (e) {
        setSnapshotNote(
          t('codeAssist.unreadable', { message: e instanceof Error ? e.message : String(e) }),
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
            aria-label={t('codeAssist.stopLabel')}
            onClick={() => void send('code.assist.abort', { requestId })}
          >
            <Square size={11} />
            {t('codeAssist.stop')}
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
          {t('codeAssist.analysis')}
          <select
            aria-label={t('codeAssist.presetLabel')}
            value={preset}
            disabled={busy}
            onChange={(event) => {
              setPreset(event.target.value as CodeAssistPreset);
              setAllowEdits(false);
            }}
          >
            {(
              [
                'overview',
                'explain',
                'quality',
                'bugs',
                'security',
                'tests',
                'impact',
                'fix',
                'custom',
              ] as const
            ).map((id) => (
              <option key={id} value={id}>
                {t(`codeAssist.preset.${id}`)}
              </option>
            ))}
          </select>
        </label>
        {preset === 'custom' && (
          <textarea
            aria-label={t('codeAssist.questionLabel')}
            placeholder={t('codeAssist.questionPlaceholder')}
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
              {t('codeAssist.allowEdits')}
            </label>
          ) : (
            <span>{t('codeAssist.readOnly')}</span>
          )}
          <button
            type="submit"
            className="button primary small"
            disabled={
              busy || (preset === 'fix' && !allowEdits) || (preset === 'custom' && !question.trim())
            }
          >
            <Play size={12} />
            {busy ? t('codeAssist.analyzing') : t('codeAssist.run')}
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
          {t('codeAssist.applied')}
          {snapshotNote ? ` ${snapshotNote}` : ''}
        </p>
      )}
      {run?.appliedEdits && run.status !== 'running' && command && run.edits && (
        // Engines that capture every written file: review and restore each one.
        <section className="code-assist-edit-list" aria-label={t('codeAssist.changedFiles')}>
          {run.edits.length === 0 && <p className="file-quiet-state">{t('codeAssist.noWrites')}</p>}
          {run.edits.map((edit) => (
            <CodeAssistEditReview
              key={edit.path}
              command={command}
              path={edit.path}
              before={edit.before}
              note={t('codeAssist.captured')}
              {...(onEdited ? { onRestored: onEdited } : {})}
            />
          ))}
          {run.uncaptured && run.uncaptured.length > 0 && (
            <p className="code-assist-applied">
              {t('codeAssist.uncaptured', { files: run.uncaptured.join(', ') })}
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
      {run?.status === 'aborted' && <p className="file-quiet-state">{t('codeAssist.stopped')}</p>}
    </section>
  );
}
