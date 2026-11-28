import { Check, ChevronDown, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import './composer-access.css';
import { useDetailsDismiss } from './useDetailsDismiss';

const LEVELS = [
  { id: 'off', patch: { yolo: false, yoloPlus: false }, Icon: ShieldCheck },
  { id: 'on', patch: { yolo: true, yoloPlus: false }, Icon: ShieldAlert },
  { id: 'plus', patch: { yolo: true, yoloPlus: true }, Icon: ShieldOff },
] as const;

/**
 * How freely the conversation acts, as its own chip beside the model: approvals on, YOLO or
 * YOLO+, tinted amber and red as the prompts fall away. Saved with `prefs.update` as `/yolo`
 * saves it; the same level is also in the session settings.
 */
export function ComposerAccessChip({
  prefs,
  command,
  disabled,
}: {
  prefs: Record<string, unknown> | undefined;
  command: EngineCommand;
  disabled: boolean;
}) {
  const { t } = useDesktopText();
  const dismiss = useDetailsDismiss();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const level = prefs?.['yoloPlus'] === true ? 'plus' : prefs?.['yolo'] === true ? 'on' : 'off';
  const current = LEVELS.find((entry) => entry.id === level) ?? LEVELS[0];
  return (
    <details className={`composer-access level-${level}`} ref={dismiss}>
      <summary
        className="composer-access-trigger"
        aria-label={`${t('autonomyControl.yoloLabel')}: ${t(`autonomyControl.yolo.${level}`)}`}
        title={error || t(`autonomyControl.yolo.${level}Title`)}
      >
        <current.Icon size={13} aria-hidden="true" />
        <span>{t(`autonomyControl.yolo.${level}`)}</span>
        <ChevronDown size={11} aria-hidden="true" className="composer-access-chevron" />
      </summary>
      <div className="composer-access-panel">
        {LEVELS.map(({ id, patch, Icon }) => (
          <button
            key={id}
            type="button"
            className={`composer-access-option level-${id}`}
            aria-pressed={id === level}
            disabled={disabled || busy}
            onClick={(event) => {
              if (id === level) return;
              const details = event.currentTarget.closest('details');
              setBusy(true);
              setError('');
              void command('prefs.update', patch, ['key.operation_result'])
                .then(() => details?.removeAttribute('open'))
                .catch((failure) =>
                  setError(failure instanceof Error ? failure.message : String(failure)),
                )
                .finally(() => setBusy(false));
            }}
          >
            <Icon size={14} aria-hidden="true" />
            <span className="composer-access-copy">
              <strong>{t(`autonomyControl.yolo.${id}`)}</strong>
              <small>{t(`autonomyControl.yolo.${id}Title`)}</small>
            </span>
            {id === level && (
              <Check size={13} aria-hidden="true" className="composer-access-check" />
            )}
          </button>
        ))}
        {error && (
          <p role="alert" className="composer-access-error">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
