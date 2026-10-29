import { LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type ContextEditorSnapshot,
  contextEditorSnapshot,
  metricsSummary,
  removalProposal,
  removalSet,
} from './context-editor-model';
import { type EngineCommand, EngineReplyError } from './engine-operations';
import { entries, record } from './engine-values';
import { Modal } from './Modal';

const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);

/**
 * Removes whole messages from the provider context through the engine's validated editor:
 * every removal plan is validated against the snapshot revision before it can be applied.
 */
export function ContextEditorDialog({
  command,
  running,
  onClose,
  onApplied,
}: {
  command: EngineCommand;
  running: boolean;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ContextEditorSnapshot | null>(null),
    [chosen, setChosen] = useState<Set<number>>(new Set()),
    [validation, setValidation] = useState<{ key: string; result: Record<string, unknown> } | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setSnapshot(
        contextEditorSnapshot(
          await command('context.editor.open', {}, ['context.editor.snapshot']),
        ),
      );
      setChosen(new Set());
      setValidation(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [command]);
  useEffect(() => {
    void load();
  }, [load]);
  const removed = useMemo(
    () => (snapshot ? removalSet(snapshot, chosen) : new Set<number>()),
    [snapshot, chosen],
  );
  const key = [...removed].sort((a, b) => a - b).join(',');
  const current = validation?.key === key ? validation.result : null;
  const run = async (kind: 'validate' | 'apply') => {
    if (!snapshot || !removed.size) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const proposal = removalProposal(snapshot, removed);
      // A refused plan arrives as a rejected request carrying the validation result.
      const answer = (reply: Promise<Record<string, unknown>>) =>
        reply.catch((failure: unknown) => {
          if (failure instanceof EngineReplyError && failure.details['ok'] === false)
            return failure.details as Record<string, unknown>;
          throw failure;
        });
      if (kind === 'validate') {
        const result = await answer(
          command('context.editor.validate', proposal, ['context.editor.validation']),
        );
        setValidation({ key, result });
        return;
      }
      // The asking socket receives the operation result; the applied record is broadcast.
      const reply = await answer(
        command(
          'context.editor.apply',
          proposal,
          ['key.operation_result', 'context.editor.validation'],
          { timeoutMs: 60000 },
        ),
      );
      // A refused apply answers with a validation result instead of an operation result.
      if (reply['ok'] === false) {
        setValidation({ key, result: reply });
        return;
      }
      setNotice(`${String(reply['message'] ?? 'Context editor applied.')}.`);
      onApplied();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const conflict = record(current?.['conflict']);
  const repair = record(current?.['repair']);
  const toggle = (index: number) =>
    setChosen((set) => {
      const next = new Set(set);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  return (
    <Modal
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <header>
        <div>
          <span className="eyebrow">CONVERSATION CONTEXT</span>
          <h2 id="dialog-title">Edit provider context</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close context editor"
          disabled={busy}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <section className="context-editor">
        <p>
          Remove whole messages from what the model sees next. The conversation transcript on disk
          is not changed. Removing your message also removes the replies it produced. Every plan is
          checked by the engine before it can be applied.
        </p>
        {running && (
          <p role="status" className="composer-notice">
            Wait for this turn to finish; the engine refuses context edits while it runs.
          </p>
        )}
        {error && (
          <p role="alert" className="session-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="composer-notice">
            {notice}
          </p>
        )}
        {!snapshot ? (
          <p role="status">
            <LoaderCircle className="spin" size={14} /> Reading the context snapshot…
          </p>
        ) : (
          <>
            <p className="field-help">
              {snapshot.rows.length} messages · ~{snapshot.totalTokens.toLocaleString()} tokens in
              the full request · {removed.size} selected for removal
            </p>
            <ol className="context-editor-rows" aria-label="Context messages">
              {snapshot.rows.map((row) => {
                const pairedOnly = removed.has(row.index) && !chosen.has(row.index);
                return (
                  <li key={row.index} className={removed.has(row.index) ? 'removed' : ''}>
                    <label className="context-editor-row">
                      <input
                        type="checkbox"
                        aria-label={`Remove message ${row.index + 1} (${row.role})`}
                        checked={removed.has(row.index)}
                        disabled={busy || pairedOnly}
                        onChange={() => toggle(row.index)}
                      />
                      <small>
                        {row.index + 1} · {row.role}
                      </small>
                      <span className="context-editor-preview">{row.preview || '(no text)'}</span>
                      <strong>~{row.tokens.toLocaleString()}</strong>
                    </label>
                    {pairedOnly && (
                      <small className="field-help">
                        Removed with the user message it answers.
                      </small>
                    )}
                    {row.warnings.map((warning) => (
                      <small key={warning} className="field-help">
                        {warning}
                      </small>
                    ))}
                  </li>
                );
              })}
            </ol>
            {current && (
              <section className="context-editor-validation" aria-label="Context edit validation">
                {current['ok'] === true ? (
                  <p role="status">Valid: {metricsSummary(current)}.</p>
                ) : (
                  <p role="alert">
                    {conflict['message']
                      ? String(conflict['message'])
                      : 'The engine refused this plan.'}
                  </p>
                )}
                {entries(current['validationErrors']).map((item) => (
                  <p key={String(item['path']) + String(item['code'])}>{String(item['message'])}</p>
                ))}
                {repair['changed'] === true && (
                  <p>
                    Protocol repair will also remove {count(repair['removedToolUses'])} tool calls,{' '}
                    {count(repair['removedToolResults'])} tool results and{' '}
                    {Number(repair['removedMessages'] ?? 0)} emptied messages.
                  </p>
                )}
                {entries(current['warnings']).map((item) => (
                  <p key={String(item['code']) + String(item['path'])}>{String(item['message'])}</p>
                ))}
              </section>
            )}
          </>
        )}
      </section>
      <footer>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          <RefreshCw size={13} /> Reload context
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy || !removed.size}
          onClick={() => setChosen(new Set())}
        >
          Clear selection
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy || running || !removed.size}
          onClick={() => void run('validate')}
        >
          Check removal
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy || running || current?.['ok'] !== true}
          onClick={() => void run('apply')}
        >
          Remove {removed.size} {removed.size === 1 ? 'message' : 'messages'}
        </button>
      </footer>
    </Modal>
  );
}
