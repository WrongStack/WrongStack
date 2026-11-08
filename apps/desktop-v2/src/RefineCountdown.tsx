import { Send, Sparkles, Timer } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';

/**
 * The grace period before an automatic refinement starts, as the WebUI's refine panel counts it
 * down: the refinement begins when it ends or on "Refine now", and "Send as written" skips it.
 */
export function RefineCountdown({
  seconds,
  disabled,
  onStart,
  onSendAsIs,
}: {
  seconds: number;
  disabled: boolean;
  onStart: () => void;
  onSendAsIs: () => void;
}) {
  const { t } = useDesktopText();
  const [left, setLeft] = useState(seconds);
  // Held in a ref so a re-render of the dialog does not restart the countdown.
  const start = useRef(onStart);
  start.current = onStart;
  useEffect(() => {
    let remaining = seconds;
    const timer = setInterval(() => {
      remaining -= 1;
      setLeft(Math.max(0, remaining));
      if (remaining <= 0) {
        clearInterval(timer);
        start.current();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [seconds]);
  return (
    <section className="refine-countdown" aria-label={t('refineDialog.countdown.label')}>
      <p role="status">
        <Timer size={15} /> {t('refineDialog.countdown.status', { count: left })}
      </p>
      <p className="field-help">{t('refineDialog.countdown.hint')}</p>
      <div className="sdd-actions">
        <button
          type="button"
          className="button secondary small"
          disabled={disabled}
          onClick={() => onSendAsIs()}
        >
          <Send size={13} /> {t('refineDialog.countdown.sendAsIs')}
        </button>
        <button
          type="button"
          className="button primary small"
          disabled={disabled}
          onClick={() => onStart()}
        >
          <Sparkles size={13} /> {t('refineDialog.countdown.startNow')}
        </button>
      </div>
    </section>
  );
}
