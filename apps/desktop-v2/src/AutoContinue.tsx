import { Timer } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AUTO_CONTINUE_SECONDS } from './autonomy-model';
import { useDesktopText } from './desktop-i18n';
import './next-steps.css';

/**
 * The countdown before a finished turn continues with a suggested step. Cancelling, typing in
 * the composer or any change of the turn's suggestions stops it; it never changes the
 * conversation's autonomy mode.
 */
export function AutoContinue({
  stepKey,
  text,
  onSubmit,
}: {
  /** Identifies the turn's suggestions; one countdown per set. */
  stepKey: string;
  text: string;
  onSubmit: (text: string) => void;
}) {
  const { t } = useDesktopText();
  const [remaining, setRemaining] = useState(AUTO_CONTINUE_SECONDS),
    [cancelled, setCancelled] = useState('');
  const submitted = useRef('');
  // The parent re-renders often; the countdown must not restart because its callback changed.
  const submit = useRef(onSubmit);
  submit.current = onSubmit;
  useEffect(() => {
    setRemaining(AUTO_CONTINUE_SECONDS);
    if (cancelled === stepKey || submitted.current === stepKey) return;
    const started = Date.now();
    const timer = setInterval(() => {
      const left = AUTO_CONTINUE_SECONDS - Math.floor((Date.now() - started) / 1000);
      setRemaining(Math.max(0, left));
      if (left <= 0) {
        clearInterval(timer);
        submitted.current = stepKey;
        submit.current(text);
      }
    }, 250);
    return () => clearInterval(timer);
  }, [stepKey, text, cancelled]);
  if (cancelled === stepKey || submitted.current === stepKey) return null;
  return (
    <div className="auto-continue" role="status">
      <Timer size={14} />
      <span>
        {t('shellText.continuingIn', { seconds: remaining })} <strong>{text}</strong>
      </span>
      <button
        type="button"
        className="button secondary small"
        onClick={() => setCancelled(stepKey)}
      >
        {t('shellText.cancel')}
      </button>
    </div>
  );
}
