import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';

export function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useDesktopText();
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    setStatus('idle');
  }, [text]);
  useEffect(() => {
    if (status === 'idle') return;
    const timer = setTimeout(() => setStatus('idle'), 2500);
    return () => clearTimeout(timer);
  }, [status]);
  return (
    <button
      type="button"
      className="copy-button"
      aria-label={label}
      title={label}
      onClick={() => {
        void (
          navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('Clipboard unavailable'))
        ).then(
          () => setStatus('copied'),
          () => setStatus('failed'),
        );
      }}
    >
      {status === 'copied' ? <Check size={12} /> : <Copy size={12} />}
      <span role="status">
        {status === 'copied'
          ? t('copy.copied')
          : status === 'failed'
            ? t('copy.failed')
            : t('copy.copy')}
      </span>
    </button>
  );
}
