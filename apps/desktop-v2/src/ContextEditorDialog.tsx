import { LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ContextEditorSnapshot,
  type ContextTextRange,
  contextEditorSnapshot,
  draftTokenEstimate,
  editProposal,
  messageTexts,
  metricsSummary,
  rangePlan,
  removalSet,
  withTextRange,
} from './context-editor-model';
import { useDesktopText } from './desktop-i18n';
import { type EngineCommand, EngineReplyError } from './engine-operations';
import { entries, record } from './engine-values';
import { Modal } from './Modal';

const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);

/**
 * Removes whole messages, or selected text inside a message, from the provider context through
 * the engine's validated editor: every plan is validated against the snapshot revision before it
 * can be applied.
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
  const { t } = useDesktopText();
  const [snapshot, setSnapshot] = useState<ContextEditorSnapshot | null>(null),
    [chosen, setChosen] = useState<Set<number>>(new Set()),
    [ranges, setRanges] = useState<ContextTextRange[]>([]),
    [trimming, setTrimming] = useState<number | null>(null),
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
      setRanges([]);
      setTrimming(null);
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
  const removed = useMemo(() => {
    if (!snapshot) return new Set<number>();
    return rangePlan(snapshot, removalSet(snapshot, chosen), ranges).whole;
  }, [snapshot, chosen, ranges]);
  const activeRanges = useMemo(
    () => (snapshot ? rangePlan(snapshot, removed, ranges).ranges : []),
    [snapshot, removed, ranges],
  );
  const key = `${[...removed].sort((a, b) => a - b).join(',')}|${JSON.stringify(activeRanges)}`;
  const editing = removed.size > 0 || activeRanges.length > 0;
  const trimAreas = useRef(new Map<string, HTMLTextAreaElement>());
  const trimSelection = (messageIndex: number, blockIndex: number | undefined) => {
    const area = trimAreas.current.get(`${messageIndex}:${blockIndex ?? ''}`);
    if (!area) return;
    const next = withTextRange(
      ranges,
      {
        messageIndex,
        ...(blockIndex === undefined ? {} : { blockIndex }),
        start: area.selectionStart,
        end: area.selectionEnd,
      },
      { empty: t('contextEdit.selectFirst'), overlap: t('contextEdit.overlap') },
    );
    if (typeof next === 'string') setError(next);
    else {
      setError('');
      setRanges(next);
    }
  };
  const current = validation?.key === key ? validation.result : null;
  const run = async (kind: 'validate' | 'apply') => {
    if (!snapshot || !editing) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const proposal = editProposal(snapshot, removalSet(snapshot, chosen), ranges);
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
      setNotice(`${String(reply['message'] ?? t('contextEdit.applied'))}.`);
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
          <span className="eyebrow">{t('contextEdit.eyebrow')}</span>
          <h2 id="dialog-title">{t('contextEdit.title')}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('contextEdit.close')}
          disabled={busy}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <section className="context-editor">
        <p>{t('contextEdit.body')}</p>
        {running && (
          <p role="status" className="composer-notice">
            {t('contextEdit.wait')}
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
            <LoaderCircle className="spin" size={14} /> {t('contextEdit.reading')}
          </p>
        ) : (
          <>
            <p className="field-help">
              {t('contextEdit.summary', {
                messages: snapshot.rows.length,
                tokens: snapshot.totalTokens.toLocaleString(),
                removed: removed.size,
              })}
              {activeRanges.length > 0 &&
                ` · ${t('contextEdit.cuts', { count: activeRanges.length })}`}
              {editing &&
                ` · ${t('contextEdit.after', {
                  tokens: draftTokenEstimate(
                    snapshot,
                    removalSet(snapshot, chosen),
                    ranges,
                  ).toLocaleString(),
                })}`}
            </p>
            <ol className="context-editor-rows" aria-label={t('contextEdit.messages')}>
              {snapshot.rows.map((row) => {
                const pairedOnly = removed.has(row.index) && !chosen.has(row.index);
                return (
                  <li key={row.index} className={removed.has(row.index) ? 'removed' : ''}>
                    <label className="context-editor-row">
                      <input
                        type="checkbox"
                        aria-label={t('contextEdit.removeMessage', {
                          number: row.index + 1,
                          role: row.role,
                        })}
                        checked={removed.has(row.index)}
                        disabled={busy || pairedOnly}
                        onChange={() => toggle(row.index)}
                      />
                      <small>
                        {row.index + 1} · {row.role}
                      </small>
                      <span className="context-editor-preview">
                        {row.preview || t('contextEdit.noText')}
                      </span>
                      <strong>~{row.tokens.toLocaleString()}</strong>
                    </label>
                    {!removed.has(row.index) &&
                      messageTexts(snapshot.messages[row.index] ?? {}).length > 0 && (
                        <button
                          type="button"
                          className="button secondary small"
                          disabled={busy}
                          aria-expanded={trimming === row.index}
                          onClick={() =>
                            setTrimming((current) => (current === row.index ? null : row.index))
                          }
                        >
                          {trimming === row.index
                            ? t('contextEdit.closeText')
                            : t('contextEdit.trimText')}
                        </button>
                      )}
                    {trimming === row.index &&
                      !removed.has(row.index) &&
                      messageTexts(snapshot.messages[row.index] ?? {}).map((target) => {
                        const id = `${row.index}:${target.blockIndex ?? ''}`;
                        return (
                          <div key={id} className="context-editor-trim">
                            <textarea
                              readOnly
                              aria-label={
                                target.blockIndex === undefined
                                  ? t('contextEdit.textOf', { number: row.index + 1 })
                                  : t('contextEdit.textOfBlock', {
                                      number: row.index + 1,
                                      block: target.blockIndex + 1,
                                    })
                              }
                              ref={(element) => {
                                if (element) trimAreas.current.set(id, element);
                                else trimAreas.current.delete(id);
                              }}
                              value={target.text}
                              rows={Math.min(12, Math.max(3, target.text.split('\n').length))}
                            />
                            <button
                              type="button"
                              className="button secondary small"
                              disabled={busy}
                              onClick={() => trimSelection(row.index, target.blockIndex)}
                            >
                              {t('contextEdit.removeSelected')}
                            </button>
                          </div>
                        );
                      })}
                    {activeRanges
                      .filter((range) => range.messageIndex === row.index)
                      .map((range) => (
                        <small
                          key={`${range.blockIndex ?? ''}:${range.start}`}
                          className="field-help"
                        >
                          {t('contextEdit.cut', { count: range.end - range.start })}
                          {messageTexts(snapshot.messages[row.index] ?? {})
                            .find((target) => target.blockIndex === range.blockIndex)
                            ?.text.slice(range.start, Math.min(range.end, range.start + 80))}
                          {range.end - range.start > 80 ? '…' : ''}
                          {t('contextEdit.cutEnd')}{' '}
                          <button
                            type="button"
                            className="button secondary small"
                            disabled={busy}
                            onClick={() =>
                              setRanges((current) => current.filter((item) => item !== range))
                            }
                          >
                            {t('contextEdit.keep')}
                          </button>
                        </small>
                      ))}
                    {pairedOnly && <small className="field-help">{t('contextEdit.paired')}</small>}
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
              <section
                className="context-editor-validation"
                aria-label={t('contextEdit.validation')}
              >
                {current['ok'] === true ? (
                  <p role="status">
                    {t('contextEdit.valid', {
                      summary: metricsSummary(current, (metrics) =>
                        t('contextEdit.metrics', { ...metrics }),
                      ),
                    })}
                  </p>
                ) : (
                  <p role="alert">
                    {conflict['message'] ? String(conflict['message']) : t('contextEdit.refused')}
                  </p>
                )}
                {entries(current['validationErrors']).map((item) => (
                  <p key={String(item['path']) + String(item['code'])}>{String(item['message'])}</p>
                ))}
                {repair['changed'] === true && (
                  <p>
                    {t('contextEdit.repair', {
                      toolUses: count(repair['removedToolUses']),
                      toolResults: count(repair['removedToolResults']),
                      messages: Number(repair['removedMessages'] ?? 0),
                    })}
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
          <RefreshCw size={13} /> {t('contextEdit.reload')}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy || !editing}
          onClick={() => {
            setChosen(new Set());
            setRanges([]);
          }}
        >
          {t('contextEdit.clearSelection')}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy || running || !editing}
          onClick={() => void run('validate')}
        >
          {t('contextEdit.check')}
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy || running || current?.['ok'] !== true}
          onClick={() => void run('apply')}
        >
          {removed.size > 0 &&
            (removed.size === 1
              ? t('contextEdit.removeMessageOne')
              : t('contextEdit.removeMessages', { count: removed.size }))}
          {removed.size > 0 && activeRanges.length > 0 && t('contextEdit.and')}
          {activeRanges.length > 0 &&
            t(activeRanges.length === 1 ? 'contextEdit.cutPart' : 'contextEdit.cutParts', {
              count: activeRanges.length,
              verb: removed.size ? t('contextEdit.verbCutAfter') : t('contextEdit.verbCut'),
            })}
          {!editing && t('contextEdit.nothingSelected')}
        </button>
      </footer>
    </Modal>
  );
}
