import { useCallback, useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { record } from './engine-values';
import { ModelDraftSummary } from './ModelDraftNotice';
import { modelDraftKey } from './model-draft-key';
import {
  type ModelDraftSnapshot,
  type ModelEditorDraftStore,
  type ModelEditorState,
  parseModelEditor,
} from './model-editor-draft';
import { request } from './platform';

export function LegacyModelDraftNotice({
  providerId,
  profileName,
  controller,
  onCopied,
}: {
  providerId: string;
  profileName: string;
  controller: ModelEditorDraftStore;
  onCopied: () => void;
}) {
  const { t } = useDesktopText();
  const [saved, setSaved] = useState<{
    snapshot: ModelDraftSnapshot;
    editor: ModelEditorState;
  } | null>(null);
  const [error, setError] = useState(''),
    [review, setReview] = useState(false),
    [busy, setBusy] = useState(false);
  const read = useCallback(async () => {
    const formKey = await modelDraftKey(providerId);
    const snapshot = await request<ModelDraftSnapshot>('profile-draft.get', { formKey });
    if (snapshot.value === null) return null;
    if (record(snapshot.value)['profileId'] !== undefined) throw Error(t('modelDraft.ownerExists'));
    const editor = parseModelEditor(snapshot.value, providerId);
    if (!editor) return null;
    return { snapshot, editor };
  }, [providerId, t]);
  useEffect(() => {
    let active = true;
    void read()
      .then((value) => {
        if (active) setSaved(value);
      })
      .catch((error) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [read]);
  const act = async (choice: 'copy' | 'discard') => {
    if (busy || !saved) return;
    setBusy(true);
    setError('');
    try {
      const current = await read();
      if (!current || current.snapshot.revision !== saved.snapshot.revision) {
        setSaved(current);
        throw Error(t('modelDraft.legacyChanged'));
      }
      if (choice === 'copy') {
        await controller.load();
        if (
          controller.snapshot().value ||
          controller.snapshot().review ||
          controller.snapshot().dirty
        )
          throw Error(t('modelDraft.finishFirst'));
        await controller.prepare();
        controller.edit(current.editor);
        await controller.flush();
        await controller.prepare(current.editor);
        setReview(false);
        onCopied();
      } else {
        const reply = await request<{ revision: number }>('profile-draft.save', {
          formKey: await modelDraftKey(providerId),
          value: null,
          expectedRevision: current.snapshot.revision,
        });
        if (reply.revision !== current.snapshot.revision + 1)
          throw Error(t('modelDraft.notAcknowledged'));
        setSaved(null);
        setReview(false);
      }
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  if (!saved && !error) return null;
  return (
    <section className="model-draft-notice" aria-label={t('modelDraft.legacyLabel')}>
      <h3>{t('modelDraft.legacyTitle')}</h3>
      <p>{t('modelDraft.legacyIntro', { profile: profileName })}</p>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {saved &&
        (!review ? (
          <button type="button" className="button secondary small" onClick={() => setReview(true)}>
            {t('modelDraft.legacyReview')}
          </button>
        ) : (
          <>
            <ModelDraftSummary value={saved.editor} />
            <div className="model-tier-actions">
              <button
                type="button"
                className="button secondary small"
                disabled={busy}
                onClick={() => {
                  void act('copy');
                }}
              >
                {t('modelDraft.legacyCopy')}
              </button>
              <button
                type="button"
                className="button secondary small"
                disabled={busy}
                onClick={() => {
                  void act('discard');
                }}
              >
                {t('modelDraft.legacyDiscard')}
              </button>
              <button
                type="button"
                className="button secondary small"
                disabled={busy}
                onClick={() => setReview(false)}
              >
                {t('modelDraft.legacyKeep')}
              </button>
            </div>
          </>
        ))}
    </section>
  );
}
