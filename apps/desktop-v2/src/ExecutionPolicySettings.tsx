import { LockKeyhole, ShieldCheck } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import {
  confirmationKinds,
  confirmationMap,
  type ExecutionMode,
  executionMode,
  executionModeValues,
  lockedConfirmationKinds,
} from './execution-policy-model';
import './execution-policy.css';

export function ExecutionPolicySettings({
  draft,
  change,
}: {
  draft: Record<string, unknown>;
  change: (key: string, value: unknown) => void;
}) {
  const { t } = useDesktopText();
  const mode = executionMode(draft),
    map = confirmationMap(draft['yoloConfirm']);
  return (
    <section className="execution-policy" aria-label={t('execPolicy.label')}>
      <article className="execution-mode-card">
        <header>
          <ShieldCheck size={21} />
          <div>
            <span className="eyebrow">{t('execPolicy.eyebrow')}</span>
            <h3>{t('execPolicy.title')}</h3>
          </div>
        </header>
        <p>{t('execPolicy.intro')}</p>
        <label>
          {t('execPolicy.modeLabel')}
          <select
            aria-label={t('execPolicy.title')}
            value={mode}
            onChange={(event) => {
              const next = executionModeValues(event.target.value as ExecutionMode);
              change('yolo', next.yolo);
              change('yoloPlus', next.yoloPlus);
            }}
          >
            <option value="standard">{t('execPolicy.mode.standard')}</option>
            <option value="yolo">{t('execPolicy.mode.yolo')}</option>
            <option value="yolo-plus">{t('execPolicy.mode.yolo-plus')}</option>
          </select>
        </label>
        <p role="status" className="execution-mode-note">
          {t(`execPolicy.note.${mode}`)}
        </p>
      </article>
      <article className="execution-confirm-card">
        <h3>{t('execPolicy.confirmTitle')}</h3>
        <p>{mode === 'yolo' ? t('execPolicy.checkedYolo') : t('execPolicy.savedShown')}</p>
        <div className="execution-kind-list">
          {confirmationKinds.map(({ kind, label: english, description }) => {
            const label = t(`execPolicy.kind.${kind}.label`, { defaultValue: english });
            return (
              <label key={kind} className="execution-kind">
                <span>
                  <strong>{label}</strong>
                  <small>
                    {t(`execPolicy.kind.${kind}.description`, { defaultValue: description })}
                  </small>
                  {lockedConfirmationKinds.has(kind) && (
                    <em>
                      <LockKeyhole size={11} />
                      {t('execPolicy.required')}
                    </em>
                  )}
                </span>
                <input
                  type="checkbox"
                  aria-label={t('execPolicy.confirmKind', { label })}
                  checked={map[kind] === true}
                  disabled={mode !== 'yolo' || lockedConfirmationKinds.has(kind)}
                  onChange={(event) =>
                    change('yoloConfirm', { ...map, [kind]: event.target.checked })
                  }
                />
              </label>
            );
          })}
        </div>
        <p className="execution-protection-note">{t('execPolicy.protection')}</p>
      </article>
    </section>
  );
}
