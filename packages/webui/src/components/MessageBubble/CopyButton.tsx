import { cn } from '@/lib/utils';
import { Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { copyToClipboard } from './utils.js';

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
  const [copied, setCopied] = useState(false);
  const labelText = label ?? t('common:action.copy');
  return (
    <button
      type="button"
      onClick={async (ev) => {
        ev.stopPropagation();
        const ok = await copyToClipboard(text);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }
      }}
      className={cn(
        'inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors',
        className,
      )}
      title={labelText}
    >
      {copied ? (
        <>
          <Check className="h-3 w-3 text-success" />
          <span>{t('common:action.copied')}</span>
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" />
          <span>{labelText}</span>
        </>
      )}
    </button>
  );
}
