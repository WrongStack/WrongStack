import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useAppTranslation } from '@/i18n';
import { useConfigStore } from '@/stores';
import { Loader2, RotateCcw, WifiOff, X } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Prominent connection-lost banner. The ActivityBar's status dot is easy
 * to miss when the user is heads-down on the chat; this banner stretches
 * across the top, blocks the visual flow, and offers a "retry now"
 * button. Auto-hides as soon as the socket comes back open.
 *
 * Dismissable for the current outage (X button) — once dismissed, only
 * comes back if the socket recovers and then drops again. The ActivityBar
 * dot still reflects the live state so the user isn't fully blind after
 * dismissing.
 */
export function ConnectionBanner() {
  const { t } = useAppTranslation();
  const wsStatus = useConfigStore((s) => s.wsStatus);
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const [dismissed, setDismissed] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Live retry countdown while reconnecting.
  useEffect(() => {
    if (wsStatus.state !== 'reconnecting') return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [wsStatus.state]);

  // Reset the dismissal flag every time the socket recovers — so the *next*
  // disconnection re-shows the banner. Without this the user would have to
  // refresh after dismissing to ever see the banner again.
  useEffect(() => {
    if (wsStatus.state === 'open') setDismissed(false);
  }, [wsStatus.state]);

  if (wsStatus.state === 'open' || wsStatus.state === 'connecting') return null;
  if (dismissed) return null;

  const retry = () => getWSClient(wsUrl).retryNow();
  const isReconnecting = wsStatus.state === 'reconnecting';
  const errorText =
    wsStatus.state === 'closed'
      ? wsStatus.error
      : wsStatus.state === 'reconnecting'
        ? wsStatus.lastError
        : undefined;
  const remaining = isReconnecting
    ? Math.max(0, Math.ceil((wsStatus.nextRetryAt - now) / 1000))
    : 0;

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-2 border-b text-sm',
        isReconnecting
          ? 'bg-warning/10 text-warning border-warning/30'
          : 'bg-destructive/10 text-destructive border-destructive/30',
      )}
    >
      {isReconnecting ? (
        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
      ) : (
        <WifiOff className="h-4 w-4 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="font-medium">
          {isReconnecting
            ? t('activity:connection.reconnecting', { attempt: wsStatus.attempt, remaining })
            : t('activity:connection.disconnected')}
        </div>
        {errorText && <div className="text-xs opacity-80 truncate">{errorText}</div>}
      </div>
      <button
        type="button"
        onClick={retry}
        className={cn(
          'inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs font-medium',
          'hover:bg-background/30 transition-colors shrink-0',
          isReconnecting ? 'border-warning/40' : 'border-destructive/40',
        )}
        title={t('activity:connection.retryTitle')}
      >
        <RotateCcw className="h-3 w-3" />
        {t('activity:connection.retry')}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="text-current/60 hover:text-current shrink-0"
        title={t('activity:connection.dismissTitle')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
