import { Gauge, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ContextEditorDialog } from './ContextEditorDialog';
import { ContextModes } from './ContextModes';
import { ContextResidency } from './ContextResidency';
import { type CompactionOutcome, compactionOutcome, reductionLabels } from './compaction-outcome';
import type { EngineCommand } from './engine-operations';
import { contentText, entries, record } from './engine-values';
import { MarkdownContent } from './MarkdownContent';
import { Modal } from './Modal';
import type { MemoryContext, MemoryInjectorRun } from './memory-injections';
import { SessionMemoryInjections } from './SessionMemoryInjections';

export function SessionContextPanel({
  command,
  running,
  maxContext,
  initialAction,
  onClose,
  memoryRuns = [],
  memoryContext = null,
}: {
  command: EngineCommand;
  running: boolean;
  maxContext: number;
  initialAction?: 'compact' | 'compact-aggressive' | 'repair' | 'clear' | undefined;
  onClose: () => void;
  /** SAGE injector runs and the latest request's memories, as the engine reported them. */
  memoryRuns?: MemoryInjectorRun[] | undefined;
  memoryContext?: MemoryContext | null | undefined;
}) {
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null),
    [instructions, setInstructions] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [confirmClear, setConfirmClear] = useState(initialAction === 'clear'),
    [compaction, setCompaction] = useState<CompactionOutcome | null>(null),
    [editing, setEditing] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSnapshot(await command('context.debug', {}, ['context.debug']));
    } finally {
      setLoading(false);
    }
  }, [command]);
  const mutate = useCallback(
    async (action: 'compact' | 'compact-aggressive' | 'repair' | 'clear') => {
      if (running) {
        setError('Wait for this turn to finish before changing its context.');
        return;
      }
      setBusy(true);
      setError('');
      setNotice('');
      setCompaction(null);
      try {
        // A compaction answers with its report first; a refusal arrives as an operation result.
        const compacting = action.startsWith('compact');
        const result = await command(
          compacting ? 'context.compact' : `context.${action}`,
          action === 'compact-aggressive' ? { aggressive: true } : {},
          compacting ? ['context.compacted', 'key.operation_result'] : ['key.operation_result'],
          { timeoutMs: 120000 },
        );
        const outcome = compacting ? compactionOutcome(result) : null;
        setCompaction(outcome);
        setNotice(
          outcome
            ? `Compacted: ~${outcome.before.toLocaleString()} → ~${outcome.after.toLocaleString()} message tokens (saved ~${outcome.saved.toLocaleString()}).`
            : String(result['message'] ?? 'Context operation completed.'),
        );
        setConfirmClear(false);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [command, refresh, running],
  );
  useEffect(() => {
    void refresh().catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, [refresh]);
  useEffect(() => {
    if (initialAction && initialAction !== 'clear') void mutate(initialAction);
  }, []);
  const tools = record(snapshot?.['tools']),
    messages = record(snapshot?.['messages']),
    total = Number(snapshot?.['total'] ?? 0);
  if (editing)
    return (
      <ContextEditorDialog
        command={command}
        running={running}
        onClose={() => setEditing(false)}
        onApplied={() => void refresh().catch((e) => setError(String(e)))}
      />
    );
  return (
    <Modal
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="composer-dialog resource-dialog context-inspector">
        <header>
          <div>
            <span className="eyebrow">THIS CONVERSATION</span>
            <h2 id="dialog-title">
              <Gauge size={20} /> Context & instructions
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close context inspector"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <p>
          The engine’s calibrated estimate of the current provider context. This is separate from
          cumulative billed usage.
        </p>
        {error && (
          <p className="composer-error" role="alert">
            {error}
          </p>
        )}
        {compaction && (
          <section className="compaction-outcome" aria-label="Compaction result">
            {compaction.request && (
              <p>
                Full request: ~{compaction.request.before.toLocaleString()} → ~
                {compaction.request.after.toLocaleString()} tokens
              </p>
            )}
            {compaction.reductions.length > 0 ? (
              <ul>
                {compaction.reductions.map((reduction) => (
                  <li key={reduction.phase}>
                    {reductionLabels[reduction.phase] ?? reduction.phase}: ~
                    {reduction.saved.toLocaleString()} tokens
                  </li>
                ))}
              </ul>
            ) : (
              compaction.saved === 0 && <p>Nothing needed compacting.</p>
            )}
            {compaction.quality && !compaction.quality.ok && (
              <p role="alert">
                The compactor's own check flagged the result: {compaction.quality.issues.join('; ')}
              </p>
            )}
            {compaction.digest && (
              <details>
                <summary>What the collapsed turns became</summary>
                <pre>{compaction.digest}</pre>
                {compaction.digestTruncated && (
                  <small>Shortened here; the session log keeps the complete digest.</small>
                )}
              </details>
            )}
          </section>
        )}
        {notice && (
          <p className="composer-notice" role="status">
            {notice}
          </p>
        )}
        {loading ? (
          <p role="status">
            <LoaderCircle size={14} className="spin" /> Reading context…
          </p>
        ) : !snapshot ? (
          <p>Context data is unavailable. Refresh to try again.</p>
        ) : (
          <>
            <div className="context-summary">
              <div>
                <strong>{total.toLocaleString()}</strong>
                <span>Estimated current tokens</span>
              </div>
              <div>
                <strong>{maxContext > 0 ? maxContext.toLocaleString() : 'Not reported'}</strong>
                <span>Model context window</span>
              </div>
              <div>
                <strong>{String(snapshot['mode'] ?? 'Default')}</strong>
                <span>Context mode</span>
              </div>
            </div>
            <section aria-label="Estimated context sections">
              {[
                ['System instructions', Number(snapshot['systemPrompt'] ?? 0)],
                ['Tool definitions', Number(tools['total'] ?? 0)],
                ['Conversation messages', Number(messages['total'] ?? 0)],
              ].map(([label, count]) => (
                <div className="context-token-row" key={String(label)}>
                  <span>{label}</span>
                  <meter
                    min={0}
                    max={Math.max(1, total)}
                    value={Number(count)}
                    aria-label={String(label)}
                  />
                  <strong>~{Number(count).toLocaleString()}</strong>
                </div>
              ))}
            </section>
            <details>
              <summary>Tool definitions · {String(tools['count'] ?? 0)}</summary>
              <div className="context-entries">
                {entries(tools['breakdown']).map((tool, i) => (
                  <div key={i}>
                    <span>{String(tool['name'] ?? 'Tool')}</span>
                    <strong>
                      ~{Number(tool['tokens'] ?? tool['total'] ?? 0).toLocaleString()}
                    </strong>
                  </div>
                ))}
              </div>
            </details>
            <details>
              <summary>Conversation messages · {String(messages['count'] ?? 0)}</summary>
              <div className="context-entries">
                {entries(messages['breakdown']).map((message, i) => (
                  <div key={i}>
                    <span>
                      <small>{String(message['role'] ?? 'Message')}</small>{' '}
                      {String(message['preview'] ?? '')}
                    </span>
                    <strong>~{Number(message['tokens'] ?? 0).toLocaleString()}</strong>
                  </div>
                ))}
              </div>
            </details>
            <ContextResidency residency={snapshot['residency']} retention={snapshot['retention']} />
            <ContextModes command={command} onChanged={() => void refresh()} />
            <section>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError('');
                  void command('context.editor.open', { includeReadonlyContent: true }, [
                    'context.editor.snapshot',
                  ])
                    .then((result) =>
                      setInstructions(
                        contentText(record(result['readonlyContent'])['systemPrompt']),
                      ),
                    )
                    .catch((e) => setError(String(e instanceof Error ? e.message : e)))
                    .finally(() => setBusy(false));
                }}
              >
                Read effective instructions
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                Edit context…
              </button>
              {instructions !== null && (
                <div className="context-instructions">
                  <MarkdownContent
                    text={instructions || 'The engine returned no instruction text.'}
                  />
                </div>
              )}
            </section>
          </>
        )}
        <SessionMemoryInjections runs={memoryRuns} context={memoryContext} />
        <footer>
          <button
            type="button"
            className="button secondary"
            disabled={busy || loading}
            onClick={() => void refresh().catch((e) => setError(String(e)))}
          >
            <RefreshCw size={13} /> Refresh context
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || running}
            onClick={() => void mutate('repair')}
          >
            Repair protocol
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || running}
            onClick={() => void mutate('compact')}
          >
            Compact context
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || running}
            onClick={() => void mutate('compact-aggressive')}
          >
            Compact aggressively
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || running}
            onClick={() => setConfirmClear(true)}
          >
            Clear provider context
          </button>
        </footer>
        {confirmClear && (
          <div className="context-clear-confirm">
            <h3>Clear this provider context?</h3>
            <p>
              The session identity and on-disk conversation remain. The next request starts with an
              empty provider-bound conversation.
            </p>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirmClear(false)}
            >
              Keep context
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy || running}
              onClick={() => void mutate('clear')}
            >
              Confirm clear context
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
