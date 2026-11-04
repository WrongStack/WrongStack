import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { KitValue } from './KitParameterForm';
import { type KitParameterDraft, kitSchemaFingerprint } from './kit-parameter-draft';
import type { KitSchema } from './project-kit-model';
import { useKitParameterDraft } from './useKitParameterDraft';

/**
 * Keeps a kit's unsent parameters on this device. Values typed against the
 * current input contract come back automatically; values saved for an older
 * contract are only shown until the person chooses to use or discard them.
 */
export function useKitParameterBinding(
  projectId: string,
  kit: string,
  schema: KitSchema | null,
  setInput: (value: unknown) => void,
) {
  const draft = useKitParameterDraft(projectId, kit);
  const [fingerprint, setFingerprint] = useState('');
  const [restored, setRestored] = useState<number | null>(null);
  const [stale, setStale] = useState<KitParameterDraft | null>(null);
  const owner = useRef(0);
  const { controller } = draft;
  useEffect(() => {
    const own = ++owner.current;
    setFingerprint('');
    setRestored(null);
    setStale(null);
    if (!kit || !schema) return;
    void (async () => {
      const print = await kitSchemaFingerprint(schema);
      await controller.load();
      if (own !== owner.current) return;
      const saved = controller.snapshot().value;
      if (saved?.schema === print) {
        setInput(saved.input);
        setRestored(controller.snapshot().updatedAt ?? 0);
      } else if (saved) setStale(saved);
      setFingerprint(print);
    })();
  }, [controller, kit, schema, setInput]);
  const ready = !!fingerprint && draft.state.ready && !stale;
  const edit = useCallback(
    (input: unknown) => {
      if (ready) controller.edit({ kit, schema: fingerprint, input });
    },
    [ready, controller, kit, fingerprint],
  );
  return {
    draft,
    fingerprint,
    restored,
    stale,
    edit,
    /** Adopt values saved for an older contract; validation shows what no longer fits. */
    useStale: () => {
      if (!stale) return;
      setInput(stale.input);
      setStale(null);
      controller.edit({ kit, schema: fingerprint, input: stale.input });
    },
    discard: (initial: unknown) => {
      setStale(null);
      setRestored(null);
      setInput(initial);
      if (draft.state.ready) controller.edit(null);
    },
    /** Remove the parked values only when nothing changed after they were submitted. */
    settle: (submitted: KitParameterDraft | null) =>
      submitted ? controller.clear(submitted) : Promise.resolve(true),
  };
}

export function KitParameterDraftNotice({
  binding,
  initial,
  onUseSaved,
}: {
  binding: ReturnType<typeof useKitParameterBinding>;
  initial: unknown;
  onUseSaved: (input: unknown) => void;
}) {
  const { t } = useDesktopText();
  const { draft, restored, stale } = binding;
  const review = draft.state.review;
  if (!draft.active) return null;
  return (
    <>
      {draft.state.error && (
        <p className="composer-error" role="alert">
          {draft.state.error}
        </p>
      )}
      {review && (
        <section className="kit-draft-notice" aria-label={t('kitDraft.conflictLabel')}>
          <p>{t('kitDraft.conflictBody')}</p>
          <div className="kit-draft-compare">
            <div>
              <strong>{t('kitDraft.savedElsewhere')}</strong>
              {review.value ? (
                <KitValue value={review.value.input} />
              ) : (
                <p>{t('kitDraft.noSaved')}</p>
              )}
            </div>
            <div>
              <strong>{t('kitDraft.thisWindow')}</strong>
              {draft.state.value ? (
                <KitValue value={draft.state.value.input} />
              ) : (
                <p>{t('kitDraft.defaults')}</p>
              )}
            </div>
          </div>
          <div className="kit-actions">
            <button
              type="button"
              className="button secondary small"
              onClick={() => void draft.controller.resolve('local')}
            >
              {t('kitDraft.keepLocal')}
            </button>
            <button
              type="button"
              className="button secondary small"
              onClick={() => {
                const saved = review.value;
                void draft.controller.resolve('saved').then((ok) => {
                  if (ok && saved?.schema === binding.fingerprint) onUseSaved(saved.input);
                });
              }}
            >
              {t('kitDraft.useSaved')}
            </button>
          </div>
        </section>
      )}
      {stale && (
        <section className="kit-draft-notice" aria-label={t('kitDraft.staleLabel')}>
          <p>{t('kitDraft.staleBody')}</p>
          <KitValue value={stale.input} />
          <div className="kit-actions">
            <button type="button" className="button secondary small" onClick={binding.useStale}>
              {t('kitDraft.useStale')}
            </button>
            <button
              type="button"
              className="button secondary small"
              onClick={() => binding.discard(initial)}
            >
              {t('kitDraft.discard')}
            </button>
          </div>
        </section>
      )}
      {restored !== null && !stale && !review && draft.state.value && (
        <p className="kit-draft-status" role="status">
          {restored
            ? t('kitDraft.restoredAt', { at: new Date(restored).toLocaleString() })
            : t('kitDraft.restored')}
          .{' '}
          <button
            type="button"
            className="button secondary small"
            onClick={() => binding.discard(initial)}
          >
            {t('kitDraft.reset')}
          </button>
        </p>
      )}
      {draft.state.saving && (
        <small className="field-help" role="status">
          {t('kitDraft.saving')}
        </small>
      )}
    </>
  );
}
