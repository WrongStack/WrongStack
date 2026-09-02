/**
 * ApiKeyDisplay — consistent display for masked API keys with a copy action.
 *
 * Shows the masked key in a monospace container and provides a one-click
 * copy button. The full key is never available client-side — the `maskedKey`
 * from the server is the canonical preview.
 */

import { Check, Copy } from 'lucide-react';
import { useCallback, useState } from 'react';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';

interface ApiKeyDisplayProps {
  maskedKey: string;
  className?: string;
}

export function ApiKeyDisplay({ maskedKey, className }: ApiKeyDisplayProps) {
  const { t } = useAppTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(maskedKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [maskedKey]);

  return (
    <div
      className={cn(
        'group flex items-center gap-1.5 rounded-md border border-border/50 bg-background/50 px-2 py-1 font-mono text-xs text-muted-foreground',
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate tracking-wide">{maskedKey}</span>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 rounded p-0.5 text-muted-foreground/50 opacity-0 transition-all hover:text-foreground group-hover:opacity-100 focus:opacity-100"
        title={copied ? 'Copied' : 'Copy key preview'}
        aria-label={t('activity:apikeydisplay.copyApiKeyToClipboard')}
      >
        {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}
