import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { useWebSocket } from '@/hooks/useWebSocket';
import { Shield, Square, Terminal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';

// ── Types ──────────────────────────────────────────────────────────────────

interface TrackedProcess {
  pid: number;
  command: string;
  tool: string;
  startedAt: number;
  status: 'running' | 'exited' | 'killed';
  protected?: boolean | undefined;
}

// ── Component ──────────────────────────────────────────────────────────────

export interface ProcessMonitorProps {
  open: boolean;
  onClose: () => void;
  className?: string | undefined;
}

export function ProcessMonitor({
  open,
  onClose,
  className,
}: ProcessMonitorProps): React.ReactElement | null {
  const { t } = useAppTranslation();
  const [processes, setProcesses] = useState<TrackedProcess[]>([]);
  const ws = useWebSocket();
  const offRef = useRef<(() => void) | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll the process registry via WS while open
  useEffect(() => {
    if (!open || !ws.client?.isConnected) return;

    ws.client.send?.({ type: 'process.list' });

    offRef.current =
      ws.client.on?.('process.list', (msg: unknown) => {
        const payload = (msg as { payload?: { processes?: TrackedProcess[] } })?.payload;
        if (payload?.processes) setProcesses(payload.processes);
      }) ?? null;

    pollRef.current = setInterval(() => {
      ws.client.send?.({ type: 'process.list' });
    }, 3000);

    return () => {
      offRef.current?.();
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [open, ws.client]);

  const handleKill = useCallback(
    (pid: number) => {
      ws.client.send?.({ type: 'process.kill', payload: { pid } });
    },
    [ws.client],
  );

  const handleKillAll = useCallback(() => {
    ws.client.send?.({ type: 'process.killAll' });
  }, [ws.client]);

  const running = processes.filter((p) => p.status === 'running');

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        className={cn('max-w-lg gap-0 p-0 overflow-hidden flex flex-col max-h-[75dvh] pt-[10dvh]', className)}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{t('activity:process.heading')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('activity:process.subtitle', { active: running.length, total: processes.length })}
        </DialogDescription>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-warning/10 text-warning">
              <Terminal className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">{t('activity:process.heading')}</h2>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {t('activity:process.subtitle', { active: running.length, total: processes.length })}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {running.length > 0 && (
              <button
                type="button"
                onClick={handleKillAll}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-destructive hover:bg-destructive/10 transition-colors font-medium"
              >
                <Square className="h-3 w-3 fill-current" />
                {t('activity:process.killAll')}
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {processes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
              <Terminal className="h-10 w-10 opacity-15" />
              <p className="text-sm font-medium">{t('activity:process.emptyTitle')}</p>
              <p className="text-xs text-center max-w-xs">{t('activity:process.emptyBody')}</p>
            </div>
          ) : (
            <div className="divide-y">
              {processes.map((proc) => {
                const elapsed =
                  proc.status === 'running'
                    ? Math.floor((Date.now() - proc.startedAt) / 1000)
                    : null;
                const elapsedStr = elapsed
                  ? elapsed < 60
                    ? `${elapsed}s`
                    : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
                  : null;

                const isProtected = proc.protected === true;

                return (
                  <div
                    key={proc.pid}
                    className={cn(
                      'flex items-center justify-between px-4 py-3 text-xs transition-colors',
                      proc.status === 'running'
                        ? 'bg-background hover:bg-muted/30'
                        : 'bg-muted/20 text-muted-foreground',
                    )}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <span
                        className={cn(
                          'led shrink-0',
                          proc.status === 'running'
                            ? isProtected
                              ? 'text-info'
                              : 'text-[hsl(var(--success))] led-pulse'
                            : 'text-muted-foreground',
                        )}
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                            {t('activity:process.pidLabel', { pid: proc.pid })}
                          </span>
                          <span className="font-medium truncate">{proc.tool}</span>
                          {isProtected && (
                            <span
                              className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] bg-info/10 text-info font-medium shrink-0"
                              title={t('activity:process.protectedTitle')}
                            >
                              <Shield className="h-2.5 w-2.5" />
                              {t('activity:process.protected')}
                            </span>
                          )}
                        </div>
                        <code className="text-[10px] text-muted-foreground/70 truncate block mt-0.5 font-mono">
                          {proc.command}
                        </code>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-3">
                      {elapsedStr && (
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {elapsedStr}
                        </span>
                      )}
                      {proc.status === 'running' && !isProtected && (
                        <button
                          type="button"
                          onClick={() => handleKill(proc.pid)}
                          className="p-1.5 rounded-md hover:bg-destructive/10 hover:text-destructive transition-colors"
                          title={t('activity:process.killTitle', { pid: proc.pid })}
                        >
                          <Square className="h-3.5 w-3.5 fill-current" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
