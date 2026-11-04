import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { Modal } from './Modal';
import { providerDisabled, providerVisibilityPatch } from './model-visibility';

export function ProviderVisibilityControl({
  provider,
  draft,
  change,
}: {
  provider: string;
  draft: Record<string, unknown>;
  change: (key: string, value: unknown) => void;
}) {
  const { t } = useDesktopText();
  const [review, setReview] = useState(false);
  if (!provider) return null;
  const off = providerDisabled(draft['disabledProviders'], provider);
  return (
    <section className="provider-visibility-control" aria-label={t('providerVisibility.label')}>
      <div className="provider-visibility-copy">
        <strong>{provider}</strong>
        <p>{off ? t('providerVisibility.disabledNote') : t('providerVisibility.availableNote')}</p>
        <p className="field-help">{t('providerVisibility.retained')}</p>
      </div>
      <button type="button" className="button secondary" onClick={() => setReview(true)}>
        {off ? t('providerVisibility.enable') : t('providerVisibility.disable')}
      </button>
      {review && (
        <Modal onClose={() => setReview(false)}>
          <h2 id="dialog-title">
            {off ? t('providerVisibility.enableTitle') : t('providerVisibility.disableTitle')}
          </h2>
          <p>
            <strong>{provider}</strong>
          </p>
          <p>{off ? t('providerVisibility.enableBody') : t('providerVisibility.disableBody')}</p>
          <p className="field-help">{t('providerVisibility.draftNote')}</p>
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={() => setReview(false)}>
              {t('providerVisibility.keep')}
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => {
                const patch = providerVisibilityPatch(draft, provider, !off);
                change('disabledProviders', patch.disabledProviders);
                setReview(false);
              }}
            >
              {t('providerVisibility.apply')}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
