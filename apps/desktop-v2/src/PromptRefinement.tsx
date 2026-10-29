import { Check, LoaderCircle, RefreshCw, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AttachmentPreview } from './ComposerAttachments';
import type { ComposerAttachment } from './composer-attachments';
import { refinementText, type SubmitMode } from './composer-model';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { MarkdownContent } from './MarkdownContent';
import { Modal } from './Modal';
import { ProfileModelPicker } from './ProfileModelPicker';
import { type RefinementDraft, refinementDraftResult } from './refinement-draft';
import { preferredRefinementVariant } from './refinement-policy-model';
import { type RefinerTarget, refinementRecovery } from './refinement-recovery';

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
  /** A completed review saved earlier; it is shown again without a new refiner request. */
  restored?: Pick<RefinementDraft, 'result' | 'variant' | 'edited'> | undefined;
  /** Receives the reviewable state whenever the reply, chosen version or edits change. */
  onReview?: ((review: Pick<RefinementDraft, 'result' | 'variant' | 'edited'>) => void) | undefined;
}) {
  const [result, setResult] = useState<Record<string, unknown>>(restored?.result ?? {}),
    [busy, setBusy] = useState(!restored),
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
    [edit, setEdit] = useState(restored?.edited != null);
  const generation = useRef(0);
  const refine = async (
    previous?: Record<string, unknown>,
    target?: RefinerTarget,
    timeoutOverride?: number,
  ) => {
    const own = ++generation.current;
    setBusy(true);
    setError('');
    setFailure(null);
    try {
      const chosenProvider = target?.provider ?? provider.trim(),
        chosenModel = target?.model ?? model.trim();
      if (!!chosenProvider !== !!chosenModel)
        throw Error(
          'Enter both a provider and model, or leave both empty to use your configured refiner.',
        );
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
    if (!restored) void refine();
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
  const send = async () => {
    setSending(true);
    setError('');
    setFailure(null);
    try {
      await onSend(text, mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };
  if (picker)
    return (
      <Modal
        title="Choose a refiner"
        onClose={() => {
          if (!pickerBusy) setPicker(false);
        }}
      >
        <ProfileModelPicker
          session={{ ...state, provider: provider || state.provider, model }}
          title="Choose a refiner"
          providerLabel="Refiner model provider"
          searchLabel="Search refiner models"
          description="Choose a model for the next refinement retry. Your chat model and profile defaults stay unchanged. Selecting does not run a request."
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
            <span className="eyebrow">REVIEW BEFORE SENDING</span>
            <h2 id="dialog-title">
              <Sparkles size={20} /> Refine your prompt
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Back to draft"
            disabled={sending}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <p>
          Your original draft stays intact. Approve a version, edit it, or return to the composer.
          Delivery mode:{' '}
          <strong>
            {mode === 'btw' ? 'Message / BTW' : mode === 'queue' ? 'Queue' : 'Stop & steer'}
          </strong>
          .
        </p>
        {fileReferences.length > 0 && (
          <section
            className="composer-reference-chips"
            aria-label="Files retained through refinement"
          >
            {fileReferences.map((path) => (
              <span key={path}>{path}</span>
            ))}
          </section>
        )}
        {attachments.length > 0 && (
          <section aria-label="Attachments retained through refinement">
            <p>
              Refinement changes the text only. These files stay attached to the approved message.
            </p>
            <AttachmentPreview items={attachments} interactive={false} />
          </section>
        )}
        <fieldset className="refine-versions" aria-label="Prompt versions">
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
              {key === 'original' ? 'Original' : key === 'refined' ? 'Refined' : 'English'}
            </button>
          ))}
        </fieldset>
        {busy && (
          <p className="refine-progress" role="status">
            <LoaderCircle size={15} className="spin" /> Refining with your configured model…
          </p>
        )}
        {error && (
          <section role="alert" className="composer-error refine-recovery">
            <p>
              {(() => {
                const message = failure?.guidance ?? error;
                return message.endsWith('Your draft is kept.')
                  ? message
                  : `${message} Your draft is kept.`;
              })()}
            </p>
            {failure && (
              <details>
                <summary>Error details</summary>
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
                Retry with {Math.ceil(failure.retryTimeoutMs / 1000)}s window
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
                Retry with {failure.fallback.provider}/{failure.fallback.model}
              </button>
            )}
          </section>
        )}
        <label className="refine-edit-toggle">
          <input type="checkbox" checked={edit} onChange={(e) => setEdit(e.target.checked)} /> Edit
          this version
        </label>
        {edit ? (
          <textarea
            aria-label="Edit refined prompt"
            className="refine-editor"
            value={text}
            onChange={(e) => setEdited(e.target.value)}
          />
        ) : (
          <section className="refine-preview" aria-label="Prompt preview">
            <MarkdownContent text={text} />
          </section>
        )}
        <details className="refine-options">
          <summary>Refiner model & retry</summary>
          <p>
            Empty fields use the configured refiner and fallback policy. This selection does not
            change the chat model.
          </p>
          <button
            type="button"
            className="button secondary"
            disabled={busy || sending}
            onClick={() => setPicker(true)}
          >
            Choose refiner model
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
              Use configured refiner
            </button>
          )}
          <div>
            <label>
              Provider ID
              <input
                aria-label="Refiner provider"
                value={provider}
                disabled={busy || sending}
                onChange={(e) => setProvider(e.target.value)}
                placeholder={state.provider}
              />
            </label>
            <label>
              Model ID
              <input
                aria-label="Refiner model"
                value={model}
                disabled={busy || sending}
                onChange={(e) => setModel(e.target.value)}
                placeholder={state.model}
              />
            </label>
          </div>
          <label>
            What should improve?
            <input
              aria-label="Refinement feedback"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Keep it shorter, preserve constraints…"
            />
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={busy || sending}
            onClick={() => void refine(Object.keys(result).length ? result : undefined)}
          >
            <RefreshCw size={13} /> Retry refinement
          </button>
        </details>
        {typeof result['refinedWith'] === 'object' && (
          <small className="composer-effort-hint">
            Refined with {String((result['refinedWith'] as Record<string, unknown>)['provider'])} /{' '}
            {String((result['refinedWith'] as Record<string, unknown>)['model'])}
          </small>
        )}
        <footer>
          <button type="button" className="button secondary" disabled={sending} onClick={onClose}>
            Keep original draft
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={sending || !ready || !text.trim()}
            onClick={() => onApply(text)}
          >
            Use in composer
          </button>
          <button
            type="button"
            className="button primary"
            disabled={sending || !ready || !text.trim() || state.hydrating}
            title={state.hydrating ? 'Waiting for the session history to sync' : undefined}
            onClick={() => void send()}
          >
            <Check size={14} />{' '}
            {sending ? 'Sending…' : state.hydrating ? 'Syncing history…' : 'Approve & send'}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
