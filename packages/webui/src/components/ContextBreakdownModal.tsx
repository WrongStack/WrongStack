import { getWSClient } from '@/lib/ws-client';
import { useConfigStore, useSessionStore } from '@/stores';
import { fmtTok } from '@/components/ChatView/utils';
import { AlertTriangle, FileText, MessageSquare, RefreshCw, Wrench, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppTranslation, i18n } from '@/i18n';

/** Debug payload from context.debug WS response. */
interface ContextDebugPayload {
  total: number;
  mode?: string | undefined;
  policy?: unknown | undefined;
  systemPrompt: number;
  tools: { total: number; count: number; breakdown: Array<{ name: string; tokens: number }> };
  messages: {
    total: number;
    count: number;
    breakdown: Array<{ index: number; role: string; tokens: number; preview: string }>;
  };
}

interface ContextBreakdownModalProps {
  open: boolean;
  onClose: () => void;
}

export function ContextBreakdownModal({ open, onClose }: ContextBreakdownModalProps) {
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const { lastInputTokens, maxContext } = useSessionStore(
    useShallow((s) => ({ lastInputTokens: s.lastInputTokens, maxContext: s.maxContext })),
  );
  const { t } = useAppTranslation();

  const [data, setData] = useState<ContextDebugPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch debug data when modal opens
  useEffect(() => {
    if (!open) {
      setData(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    setData(null);

    const ws = getWSClient(wsUrl);
    if (!ws?.send) {
      setError(i18n.t('activity:context.wsNotConnected'));
      setLoading(false);
      return;
    }

    ws.send({ type: 'context.debug' });

    // Listen for context.debug response
    const handler = (msg: { type: string; payload?: unknown }) => {
      if (msg.type === 'context.debug') {
        setData(msg.payload as ContextDebugPayload);
        setLoading(false);
      }
    };

    const unsubscribe = ws.on('context.debug', handler);

    // Fallback timeout
    const timeout = setTimeout(() => {
      if (loading) {
        setLoading(false);
        setError(i18n.t('activity:context.noData'));
      }
    }, 5000);

    return () => {
      clearTimeout(timeout);
      unsubscribe();
    };
  }, [open, wsUrl]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const ctxPct =
    maxContext > 0 && lastInputTokens > 0
      ? Math.min(100, Math.round((lastInputTokens / maxContext) * 100))
      : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10dvh] bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[80dvh] overflow-y-auto rounded-xl border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b sticky top-0 bg-card z-10">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-[hsl(var(--warning))]" />
            {t('activity:context.title')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Quick summary */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded bg-muted/30 px-3 py-2">
              <span className="text-[10px] text-muted-foreground">{t('activity:context.windowUsage')}</span>
              <span className="block text-sm font-mono font-medium">
                {fmtTok(lastInputTokens)} / {fmtTok(maxContext)} ({ctxPct}%)
              </span>
            </div>
            <div className="rounded bg-muted/30 px-3 py-2">
              <span className="text-[10px] text-muted-foreground">{t('activity:context.contextMode')}</span>
              <span className="block text-sm font-mono font-medium">
                {data?.mode ?? '—'}
              </span>
            </div>
          </div>

          {/* Loading / Error / Data */}
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <RefreshCw className="h-4 w-4 animate-spin" />
              {t('activity:context.fetching')}
            </div>
          ) : error ? (
            <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
              {error}
            </div>
          ) : data ? (
            <>
              {/* Token totals */}
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded bg-muted/30 px-3 py-2">
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <FileText className="h-3 w-3" />
                    {t('activity:context.systemPrompt')}
                  </span>
                  <span className="block text-sm font-mono font-medium">
                    {fmtTok(data.systemPrompt)}
                  </span>
                </div>
                <div className="rounded bg-muted/30 px-3 py-2">
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Wrench className="h-3 w-3" />
                    {t('activity:context.tools')}
                  </span>
                  <span className="block text-sm font-mono font-medium">
                    {fmtTok(data.tools.total)} ({data.tools.count})
                  </span>
                </div>
                <div className="rounded bg-muted/30 px-3 py-2">
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <MessageSquare className="h-3 w-3" />
                    {t('activity:context.messages')}
                  </span>
                  <span className="block text-sm font-mono font-medium">
                    {fmtTok(data.messages.total)} ({data.messages.count})
                  </span>
                </div>
              </div>

              {/* Visual breakdown bar */}
              <div>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  {t('activity:context.tokenAllocation')}
                </span>
                <div className="mt-1.5 h-3 w-full overflow-hidden rounded-full bg-muted flex">
                  {data.total > 0 && (
                    <>
                      <span
                        className="h-full bg-info/70 transition-all"
                        style={{ width: `${(data.systemPrompt / data.total) * 100}%` }}
                        title={t('activity:context.systemTitle', { tokens: fmtTok(data.systemPrompt) })}
                      />
                      <span
                        className="h-full bg-warning/70 transition-all"
                        style={{ width: `${(data.tools.total / data.total) * 100}%` }}
                        title={t('activity:context.toolsTitle', { tokens: fmtTok(data.tools.total) })}
                      />
                      <span
                        className="h-full bg-success/70 transition-all"
                        style={{ width: `${(data.messages.total / data.total) * 100}%` }}
                        title={t('activity:context.messagesTitle', { tokens: fmtTok(data.messages.total) })}
                      />
                    </>
                  )}
                </div>
                <div className="flex gap-3 mt-1 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-info/70" /> {t('activity:context.system')}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-warning/70" /> {t('activity:context.tools')}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-success/70" /> {t('activity:context.messages')}
                  </span>
                </div>
              </div>

              {/* Tool breakdown */}
              {data.tools.breakdown.length > 0 && (
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    {t('activity:context.toolBreakdown')}
                  </span>
                  <div className="mt-1 space-y-0.5">
                    {data.tools.breakdown.map((t) => (
                      <div key={t.name} className="flex items-center justify-between text-xs py-0.5">
                        <span className="font-mono">{t.name}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {t.tokens.toLocaleString()} tok
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Message breakdown */}
              <div>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  {t('activity:context.messagesSummary', { count: data.messages.count, total: fmtTok(data.messages.total) })}
                </span>
                <div className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                  {data.messages.breakdown.slice(0, 20).map((m) => (
                    <div key={m.index} className="flex items-center gap-2 text-xs py-0.5">
                      <span className="text-muted-foreground font-mono w-6 text-right">
                        {m.index}
                      </span>
                      <span className="text-muted-foreground font-mono w-14">{m.role}</span>
                      <span className="tabular-nums text-muted-foreground w-14">
                        {m.tokens.toLocaleString()} tok
                      </span>
                      <span className="text-muted-foreground/70 truncate flex-1">
                        {m.preview.slice(0, 80)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
