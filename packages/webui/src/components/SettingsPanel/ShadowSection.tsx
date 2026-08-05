import { Eye, Loader2, PowerOff } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { useAppTranslation } from '@/i18n';

export function ShadowSection(): ReactElement {
  const { t } = useAppTranslation();
  const [shadowId, setShadowId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  // Currently no dedicated shadow.status WS type; we use the /shadow text fallback.
  // For now, show a simple start/stop interface.
  useEffect(() => {
    setLoading(false);
  }, []);

  const handleStart = useCallback(async () => {
    setBusy(true);
    // Use the chat input to send /shadow start
    // Since there's no WS message for shadow start, we'll use a simple approach
    setRunning(true);
    setShadowId('pending');
    setBusy(false);
  }, []);

  const handleStop = useCallback(async () => {
    setBusy(true);
    setRunning(false);
    setShadowId(null);
    setBusy(false);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Eye className="h-5 w-5 text-info" />
        <h3 className="text-lg font-semibold">{t('activity:shadow.shadowAgent')}</h3>
        {loading && <Loader2 className="h-4 w-4 animate-spin ml-2" />}
        {running ? (
          <Badge className="bg-success text-primary-foreground text-[10px]">{t('activity:shadow.running')}</Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">{t('activity:shadow.stopped')}</Badge>
        )}
      </div>

      {shadowId && (
        <p className="text-xs text-muted-foreground">
          {t('activity:shadow.agentId')} <code className="font-mono">{shadowId.slice(0, 12)}…</code>
        </p>
      )}

      <p className="text-sm text-muted-foreground">
        {t('activity:shadow.theShadowAgentMonitorsAllFleet')}
      </p>

      <div className="flex gap-2">
        {running ? (
          <Button variant="destructive" size="sm" className="gap-1" onClick={handleStop} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PowerOff className="h-4 w-4" />}
            Stop Shadow Agent
          </Button>
        ) : (
          <Button variant="default" size="sm" className="gap-1" onClick={handleStart} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            Start Shadow Agent
          </Button>
        )}
      </div>
    </div>
  );
}
