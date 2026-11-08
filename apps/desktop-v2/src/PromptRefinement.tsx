import { Check, LoaderCircle, RefreshCw, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { AttachmentPreview } from './ComposerAttachments';
import type { ComposerAttachment } from './composer-attachments';
import { refinementText, type SubmitMode } from './composer-model';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { MarkdownContent } from './MarkdownContent';
import { Modal } from './Modal';
import { ProfileModelPicker } from './ProfileModelPicker';
import { RefineCountdown } from './RefineCountdown';
import { RefinementComparison } from './RefinementComparison';
import { countdownSeconds, readRefineCountdownMs } from './refine-countdown';
import { type RefinementDraft, refinementDraftResult } from './refinement-draft';
import { preferredRefinementVariant } from './refinement-policy-model';
import { type RefinerTarget, refinementRecovery } from './refinement-recovery';
import { surfaceI18n } from './surface-i18n';
import './composer-dialog.css';

export function PromptRefinement({
  original,
  mode,
  command,
  state,
  onClose,
  onApply,
  onSend,
  fileReferences = [],
  attachments = [],
  restored,
  onReview,
  countdown = false,
}: {
  original: string;
  mode: SubmitMode;
  command: EngineCommand;
  state: EngineState;
  onClose: () => void;
  onApply: (text: string) => void;
  onSend: (text: string, mode: SubmitMode) => Promise<void>;
  fileReferences?: readonly string[];
  attachments?: readonly ComposerAttachment[];
  /**
   * A review saved earlier; one with a reply is shown again without a new refiner request, one
   * still pending (interrupted by a restart) runs the request again.
   */
  restored?: Pick<RefinementDraft, 'result' | 'variant' | 'edited'> | undefined;
  /**
   * Receives the reviewable state whenever the reply, chosen version or edits change, and a
   * pending state (no reply yet) when a first request starts.
   */
  onReview?:
    | ((review: Pick<RefinementDraft, 'result' | 'variant' | 'edited' | 'pending'>) => void)
    | undefined;
  /**
   * An automatic refinement (the composer's review-on-submit): it waits this computer's refine
   * countdown first, during which the prompt can still be sent as written.
   */
  countdown?: boolean;
}) {
  const { t } = useDesktopText();
  const [graceSeconds] = useState(() =>
    countdown && !restored?.result ? countdownSeconds(readRefineCountdownMs()) : 0,
  );
  const [waiting, setWaiting] = useState(graceSeconds > 0);
  const [result, setResult] = useState<Record<string, unknown>>(restored?.result ?? {}),
    [busy, setBusy] = useState(!restored?.result && graceSeconds === 0),
    [sending, setSending] = useState(false),
    [error, setError] = useState(''),
    [variant, setVariant] = useState<'original' | 'refined' | 'english'>(
      restored?.variant ?? 'refined',
    ),
    [feedback, setFeedback] = useState(''),
    [provider, setProvider] = useState(''),
    [model, setModel] = useState(''),
    [picker, setPicker] = useState(false),
    [pickerBusy, setPickerBusy] = useState(false),
    [failure, setFailure] = useState<ReturnType<typeof refinementRecovery> | null>(null),
    [edited, setEdited] = useState<string | null>(restored?.edited ?? null),
    [edit, setEdit] = useState(restored?.edited != null),
    [compare, setCompare] = useState(false),
    [stopped, setStopped] = useState(false);
  const generation = useRef(0);
  const refine = async (
    previous?: Record<string, unknown>,
    target?: RefinerTarget,
    timeoutOverride?: number,
  ) => {
    const own = ++generation.current;
    setBusy(true);
    // Recorded before the request, so a restart while waiting can offer to run it again.
    if (!previous)
      reviewRef.current?.({ result: null, variant: 'refined', edited: null, pending: true });
    setStopped(false);
    setError('');
    setFailure(null);
    try {
      const chosenProvider = target?.provider ?? provider.trim(),
        chosenModel = target?.model ?? model.trim();
      if (!!chosenProvider !== !!chosenModel) throw Error(t('refineDialog.bothFields'));
      const timeoutMs = timeoutOverride ?? (previous ? 180000 : 90000);
      const reply = await command(
        'model.refine',
        {
          text: original,
          timeoutMs,
          ...(chosenProvider ? { provider: chosenProvider, model: chosenModel } : {}),
          ...(previous
            ? {
                previousRefined: previous['refined'],
                previousEnglish: previous['english'],
                ...(feedback.trim() ? { retryFeedback: feedback.trim() } : {}),
              }
            : {}),
        },
        ['model.refine_result'],
        { timeoutMs: timeoutMs + 15000 },
      );
      if (own !== generation.current) return;
      refinementText(reply, 'refined', original);
      setResult(reply);
      setVariant(
        preferredRefinementVariant(state.results['prefs.updated']?.['enhanceLanguage'], reply),
      );
      setEdited(null);
      setEdit(false);
    } catch (e) {
      if (own === generation.current) {
        const recovery = refinementRecovery(e);
        setError(recovery.message);
        setFailure(recovery);
      }
    } finally {
      if (own === generation.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (!restored?.result && !waiting) void refine();
    return () => {
      generation.current++;
    };
  }, []);
  const reviewRef = useRef(onReview);
  reviewRef.current = onReview;
  useEffect(() => {
    const kept = refinementDraftResult(result);
    if (kept) reviewRef.current?.({ result: kept, variant, edited });
  }, [result, variant, edited]);
  let text = original;
  try {
    text = edited ?? refinementText(result, variant, original);
  } catch {
    text = original;
  }
  const ready = variant === 'original' || typeof result[variant] === 'string';
  const send = async (value = text) => {
    setSending(true);
    setError('');
    setFailure(null);
    setStopped(false);
    try {
      await onSend(value, mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };
  if (picker)
    return (
      <Modal
        title={t('refineDialog.chooseRefiner')}
        onClose={() => {
          if (!pickerBusy) setPicker(false);
        }}
      >
        <ProfileModelPicker
          session={{ ...state, provider: provider || state.provider, model }}
          title={t('refineDialog.chooseRefiner')}
          providerLabel={t('refineDialog.providerLabel')}
          searchLabel={t('refineDialog.searchLabel')}
          description={t('refineDialog.pickerDescription')}
          onPick={(provider, model) => {
            setProvider(provider);
            setModel(model);
          }}
          onClose={() => setPicker(false)}
          onBusy={setPickerBusy}
        />
      </Modal>
    );
  return (
    <Modal
      onClose={() => {
        if (!sending) onClose();
      }}
    >
      <div className="composer-dialog refine-dialog">
        <header>
          <div>
            <span className="eyebrow">{t('refineDialog.eyebrow')}</span>
            <h2 id="dialog-title">
              <Sparkles size={20} /> {t('refineDialog.title')}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t('refineDialog.back')}
            disabled={sending}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <p>
          <Trans
            i18n={surfaceI18n}
            ns="desktop"
            i18nKey="refineDialog.intro"
            values={{
              mode: t(
                `refineDialog.mode.${mode === 'btw' ? 'btw' : mode === 'queue' ? 'queue' : 'steer'}`,
              ),
            }}
            components={{ strong: <strong /> }}
          />
        </p>
        {fileReferences.length > 0 && (
          <section className="composer-reference-chips" aria-label={t('refineDialog.files')}>
            {fileReferences.map((path) => (
              <span key={path}>{path}</span>
            ))}
          </section>
        )}
        {attachments.length > 0 && (
          <section aria-label={t('refineDialog.attachments')}>
            <p>{t('refineDialog.attachmentsBody')}</p>
            <AttachmentPreview items={attachments} interactive={false} />
          </section>
        )}
        <fieldset className="refine-versions" aria-label={t('refineDialog.versions')}>
          {(['original', 'refined', 'english'] as const).map((key) => (
            <button
              type="button"
              key={key}
              aria-pressed={variant === key}
              disabled={sending || (key !== 'original' && typeof result[key] !== 'string')}
              onClick={() => {
                setVariant(key);
                setEdited(null);
              }}
            >
              {t(`refineDialog.version.${key}`)}
            </button>
          ))}
        </fieldset>
        {waiting && (
          <RefineCountdown
            seconds={graceSeconds}
            disabled={sending || state.hydrating}
            onStart={() => {
              setWaiting(false);
              void refine();
            }}
            onSendAsIs={() => {
              setWaiting(false);
              setVariant('original');
              void send(original);
            }}
          />
        )}
        {busy && (
          <p className="refine-progress" role="status">
            <LoaderCircle size={15} className="spin" /> {t('refineDialog.refining')}
            <button
              type="button"
              className="button secondary small"
              onClick={() => {
                // The engine has no refinement cancel; a late reply is ignored by generation.
                generation.current++;
                setBusy(false);
                setFailure(null);
                setStopped(true);
                setError(t('refineDialog.stopped'));
              }}
            >
              {t('refineDialog.stopWaiting')}
            </button>
          </p>
        )}
        {error && (
          <section role="alert" className="composer-error refine-recovery">
            <p>
              {(() => {
                const message = failure ? t(`refineDialog.recovery.${failure.kind}`) : error;
                const kept = t('refineDialog.kept');
                return message.endsWith(kept) ? message : `${message} ${kept}`;
              })()}
            </p>
            {stopped && !busy && (
              <button
                type="button"
                className="button secondary"
                disabled={sending}
                onClick={() => void refine(Object.keys(result).length ? result : undefined)}
              >
                {t('refineDialog.tryAgain')}
              </button>
            )}
            {failure && (
              <details>
                <summary>{t('refineDialog.errorDetails')}</summary>
                <p>{error}</p>
              </details>
            )}
            {failure && (
              <button
                type="button"
                className="button secondary"
                disabled={busy || sending}
                onClick={() =>
                  void refine(
                    Object.keys(result).length ? result : undefined,
                    undefined,
                    failure.retryTimeoutMs,
                  )
                }
              >
                {t('refineDialog.retryWindow', {
                  seconds: Math.ceil(failure.retryTimeoutMs / 1000),
                })}
              </button>
            )}
            {failure?.fallback && (
              <button
                type="button"
                className="button secondary"
                disabled={busy || sending}
                onClick={() => {
                  const target = failure.fallback!;
                  setProvider(target.provider);
                  setModel(target.model);
                  void refine(
                    Object.keys(result).length ? result : undefined,
                    target,
                    failure.retryTimeoutMs,
                  );
                }}
              >
                {t('refineDialog.retryWith', {
                  target: `${failure.fallback.provider}/${failure.fallback.model}`,
                })}
              </button>
            )}
          </section>
        )}
        <label className="refine-edit-toggle">
          <input type="checkbox" checked={edit} onChange={(e) => setEdit(e.target.checked)} />{' '}
          {t('refineDialog.edit')}
        </label>
        <label className="refine-edit-toggle">
          <input
            type="checkbox"
            checked={compare}
            disabled={variant === 'original' && edited === null}
            onChange={(e) => setCompare(e.target.checked)}
          />{' '}
          {t('refineDialog.compare')}
        </label>
        {edited !== null && <p className="field-help">{t('refineDialog.edited')}</p>}
        {compare && <RefinementComparison original={original} text={text} />}
        {edit ? (
          <textarea
            aria-label={t('refineDialog.editLabel')}
            className="refine-editor"
            value={text}
            onChange={(e) => setEdited(e.target.value)}
          />
        ) : (
          <section className="refine-preview" aria-label={t('refineDialog.preview')}>
            <MarkdownContent text={text} />
          </section>
        )}
        <details className="refine-options">
          <summary>{t('refineDialog.options')}</summary>
          <p>{t('refineDialog.optionsBody')}</p>
          <button
            type="button"
            className="button secondary"
            disabled={busy || sending}
            onClick={() => setPicker(true)}
          >
            {t('refineDialog.chooseModel')}
          </button>
          {(provider || model) && (
            <button
              type="button"
              className="button secondary"
              disabled={busy || sending}
              onClick={() => {
                setProvider('');
                setModel('');
              }}
            >
              {t('refineDialog.useConfigured')}
            </button>
          )}
          <div>
            <label>
              {t('refineDialog.providerId')}
              <input
                aria-label={t('refineDialog.providerField')}
                value={provider}
                disabled={busy || sending}
                onChange={(e) => setProvider(e.target.value)}
                placeholder={state.provider}
              />
            </label>
            <label>
              {t('refineDialog.modelId')}
              <input
                aria-label={t('refineDialog.modelField')}
                value={model}
                disabled={busy || sending}
                onChange={(e) => setModel(e.target.value)}
                placeholder={state.model}
              />
            </label>
          </div>
          <label>
            {t('refineDialog.improve')}
            <input
              aria-label={t('refineDialog.feedback')}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder={t('refineDialog.feedbackPlaceholder')}
            />
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={busy || sending}
            onClick={() => void refine(Object.keys(result).length ? result : undefined)}
          >
            <RefreshCw size={13} /> {t('refineDialog.retry')}
          </button>
        </details>
        {typeof result['refinedWith'] === 'object' && (
          <small className="composer-effort-hint">
            {t('refineDialog.refinedWith', {
              provider: String((result['refinedWith'] as Record<string, unknown>)['provider']),
              model: String((result['refinedWith'] as Record<string, unknown>)['model']),
            })}
          </small>
        )}
        <footer>
          <button type="button" className="button secondary" disabled={sending} onClick={onClose}>
            {t('refineDialog.keepOriginal')}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={sending || !ready || !text.trim()}
            onClick={() => onApply(text)}
          >
            {t('refineDialog.useInComposer')}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={sending || !ready || !text.trim() || state.hydrating}
            title={state.hydrating ? t('refineDialog.syncWait') : undefined}
            onClick={() => void send()}
          >
            <Check size={14} />{' '}
            {sending
              ? t('refineDialog.sending')
              : state.hydrating
                ? t('refineDialog.syncing')
                : t('refineDialog.approve')}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
