import { Timer } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { AUTO_CONTINUE_SECONDS } from './autonomy-model';
import { useDesktopText } from './desktop-i18n';
import './next-steps.css';

/** An opted-in continuation gets a full grace period only while its choices are on screen. */
export function AutoContinue({
  stepKey,
  text,
  visibilityRoot,
  onSubmit,
}: {
  /** Identifies the turn's suggestions; one countdown per set. */
  stepKey: string;
  text: string;
  visibilityRoot: RefObject<HTMLDivElement | null>;
  onSubmit: (text: string) => void;
}) {
  const { t } = useDesktopText();
  const [remaining, setRemaining] = useState(AUTO_CONTINUE_SECONDS),
    [cancelled, setCancelled] = useState(''),
    [visible, setVisible] = useState(false);
  const submitted = useRef('');
  const eligible = useRef(false);
  // Parent callbacks change during streaming and preference updates, not the countdown.
  const submit = useRef(onSubmit);
  submit.current = onSubmit;
  useEffect(() => {
    const root = visibilityRoot.current;
    if (!root) return;
    let inView = false;
    const update = () => {
      eligible.current =
        inView &&
        document.visibilityState === 'visible' &&
        root.querySelector('details.next-steps-panel')?.hasAttribute('open') === true;
      setVisible(eligible.current);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = !!entry?.isIntersecting && entry.intersectionRatio >= 0.99;
        update();
      },
      { threshold: [0, 0.99, 1] },
    );
    observer.observe(root);
    document.addEventListener('visibilitychange', update);
    root.addEventListener('toggle', update, true);
    return () => {
      eligible.current = false;
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      root.removeEventListener('toggle', update, true);
    };
  }, [visibilityRoot, stepKey]);
  useEffect(() => {
    setRemaining(AUTO_CONTINUE_SECONDS);
    if (!visible || cancelled === stepKey || submitted.current === stepKey) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (!eligible.current || document.visibilityState !== 'visible') return;
      const left = AUTO_CONTINUE_SECONDS - Math.floor((Date.now() - started) / 1000);
      setRemaining(Math.max(0, left));
      if (left <= 0) {
        clearInterval(timer);
        submitted.current = stepKey;
        submit.current(text);
      }
    }, 250);
    return () => clearInterval(timer);
  }, [stepKey, text, cancelled, visible]);
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
