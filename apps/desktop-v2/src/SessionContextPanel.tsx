import { Gauge, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ContextEditorDialog } from './ContextEditorDialog';
import { ContextModes } from './ContextModes';
import { ContextResidency } from './ContextResidency';
import { ContextUsageSummary } from './ContextUsageSummary';
import { type CompactionOutcome, compactionOutcome, reductionLabels } from './compaction-outcome';
import type { ContextUsage } from './context-usage';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { contentText, entries, record } from './engine-values';
import { MarkdownContent } from './MarkdownContent';
import { Modal } from './Modal';
import type { MemoryContext, MemoryInjectorRun } from './memory-injections';
import { SessionMemoryInjections } from './SessionMemoryInjections';
import './composer-dialog.css';

export function SessionContextPanel({
  command,
  running,
  usage,
  maxContext = usage?.max ?? 0,
  initialAction,
  onClose,
  memoryRuns = [],
  memoryContext = null,
}: {
  command: EngineCommand;
  running: boolean;
  /** The model's context window; the reported usage's window when not given. */
  maxContext?: number;
  initialAction?: 'compact' | 'compact-aggressive' | 'repair' | 'clear' | undefined;
  onClose: () => void;
  /** SAGE injector runs and the latest request's memories, as the engine reported them. */
  memoryRuns?: MemoryInjectorRun[] | undefined;
  memoryContext?: MemoryContext | null | undefined;
  /** The usage the engine reported live, shown before the estimated breakdown loads. */
  usage?: ContextUsage | undefined;
}) {
  const { t } = useDesktopText();
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
        setError(t('contextPanel.waitTurn'));
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
        // A compaction's result section and the live summary already state what it saved; a
        // notice repeating it made the dialog say the same thing three times.
        setNotice(outcome ? '' : String(result['message'] ?? t('contextPanel.done')));
        setConfirmClear(false);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [command, refresh, running, t],
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
            <span className="eyebrow">{t('contextPanel.eyebrow')}</span>
            <h2 id="dialog-title">
              <Gauge size={20} /> {t('contextPanel.title')}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t('contextPanel.close')}
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <p>{t('contextPanel.body')}</p>
        {error && (
          <p className="composer-error" role="alert">
            {error}
          </p>
        )}
        {compaction && (
          <section className="compaction-outcome" aria-label={t('contextPanel.result')}>
            {compaction.request && (
              <p>
                {t('contextPanel.fullRequest', {
                  before: compaction.request.before.toLocaleString(),
                  after: compaction.request.after.toLocaleString(),
                })}
              </p>
            )}
            {compaction.reductions.length > 0 ? (
              <ul>
                {compaction.reductions.map((reduction) => (
                  <li key={reduction.phase}>
                    {t('contextPanel.reduction', {
                      label: t(`contextPanel.phase.${reduction.phase}`, {
                        defaultValue: reductionLabels[reduction.phase] ?? reduction.phase,
                      }),
                      saved: reduction.saved.toLocaleString(),
                    })}
                  </li>
                ))}
              </ul>
            ) : (
              compaction.saved === 0 && <p>{t('contextPanel.nothing')}</p>
            )}
            {compaction.quality && !compaction.quality.ok && (
              <p role="alert">
                {t('contextPanel.qualityFlag', { issues: compaction.quality.issues.join('; ') })}
              </p>
            )}
            {compaction.digest && (
              <details>
                <summary>{t('contextPanel.digest')}</summary>
                <pre>{compaction.digest}</pre>
                {compaction.digestTruncated && <small>{t('contextPanel.digestShort')}</small>}
              </details>
            )}
          </section>
        )}
        {notice && (
          <p className="composer-notice" role="status">
            {notice}
          </p>
        )}
        {usage && <ContextUsageSummary usage={usage} />}
        {loading ? (
          <p role="status">
            <LoaderCircle size={14} className="spin" /> {t('contextPanel.reading')}
          </p>
        ) : !snapshot ? (
          <p>{t('contextPanel.unavailable')}</p>
        ) : (
          <>
            <div className="context-summary">
              <div>
                <strong>{total.toLocaleString()}</strong>
                <span>{t('contextPanel.currentTokens')}</span>
              </div>
              <div>
                <strong>
                  {maxContext > 0 ? maxContext.toLocaleString() : t('contextPanel.notReported')}
                </strong>
                <span>{t('contextPanel.window')}</span>
              </div>
              <div>
                <strong>{String(snapshot['mode'] ?? t('contextPanel.defaultMode'))}</strong>
                <span>{t('contextPanel.mode')}</span>
              </div>
            </div>
            <section aria-label={t('contextPanel.sections')}>
              {[
                [t('contextPanel.section.system'), Number(snapshot['systemPrompt'] ?? 0)],
                [t('contextPanel.section.tools'), Number(tools['total'] ?? 0)],
                [t('contextPanel.section.messages'), Number(messages['total'] ?? 0)],
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
              <summary>
                {t('contextPanel.section.tools')} · {String(tools['count'] ?? 0)}
              </summary>
              <div className="context-entries">
                {entries(tools['breakdown']).map((tool, i) => (
                  <div key={i}>
                    <span>{String(tool['name'] ?? t('contextPanel.toolFallback'))}</span>
                    <strong>
                      ~{Number(tool['tokens'] ?? tool['total'] ?? 0).toLocaleString()}
                    </strong>
                  </div>
                ))}
              </div>
            </details>
            <details>
              <summary>
                {t('contextPanel.section.messages')} · {String(messages['count'] ?? 0)}
              </summary>
              <div className="context-entries">
                {entries(messages['breakdown']).map((message, i) => (
                  <div key={i}>
                    <span>
                      <small>{String(message['role'] ?? t('contextPanel.messageFallback'))}</small>{' '}
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
                {t('contextPanel.readInstructions')}
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                {t('contextPanel.edit')}
              </button>
              {instructions !== null && (
                <div className="context-instructions">
                  <MarkdownContent text={instructions || t('contextPanel.noInstructions')} />
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
            <RefreshCw size={13} /> {t('contextPanel.refresh')}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || running}
            onClick={() => void mutate('repair')}
          >
            {t('contextPanel.repair')}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || running}
            onClick={() => void mutate('compact')}
          >
            {t('contextPanel.compact')}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || running}
            onClick={() => void mutate('compact-aggressive')}
          >
            {t('contextPanel.compactAggressive')}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || running}
            onClick={() => setConfirmClear(true)}
          >
            {t('contextPanel.clear')}
          </button>
        </footer>
        {confirmClear && (
          <div className="context-clear-confirm">
            <h3>{t('contextPanel.clearTitle')}</h3>
            <p>{t('contextPanel.clearBody')}</p>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirmClear(false)}
            >
              {t('contextPanel.keep')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy || running}
              onClick={() => void mutate('clear')}
            >
              {t('contextPanel.confirmClear')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
