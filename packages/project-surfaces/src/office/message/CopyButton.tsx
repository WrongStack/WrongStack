import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { useAppTranslation } from '../../lib/i18n';
import { cn } from '../../lib/utils';

/** Copies text; a refused clipboard says so on the button instead of looking like success. */
export function CopyButton({
  text,
  className,
  label,
}: {
  text: string;
  className?: string | undefined;
  label?: string | undefined;
}) {
  const { t } = useAppTranslation();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const labelText = label ?? t('common:action.copy');
  return (
    <button
      type="button"
      data-copied={state === 'copied'}
      onClick={async (ev) => {
        ev.stopPropagation();
        const ok = await navigator.clipboard.writeText(text).then(
          () => true,
          () => false,
        );
        setState(ok ? 'copied' : 'failed');
        setTimeout(() => setState('idle'), 1400);
      }}
      className={cn(
        'ws-copy-feedback inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors',
        className,
      )}
      title={labelText}
    >
      {state === 'copied' ? (
        <>
          <Check className="h-3 w-3 text-success" />
          <span>{t('common:action.copied')}</span>
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" />
          <span>{state === 'failed' ? t('common:action.copyFailed') : labelText}</span>
        </>
      )}
    </button>
  );
}
