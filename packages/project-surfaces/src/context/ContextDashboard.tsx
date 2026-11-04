/**
 * ContextDashboard — a full-page context-window telemetry dashboard.
 *
 * Mirrors the TUI `/context window` panel: pressure bar, source breakdown,
 * threshold map, compaction engine, per-agent footprints, token metrics.
 *
 * The application feeds it (`ContextFeed`): the conversation's token use, model and modes,
 * its agents' footprints, the engine's `context.debug` breakdown and its own memory panels.
 */

import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSurfaceHost } from '../host';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { Button } from '../ui/button';
import { PageMotif } from '../ui/PageMotif';
import { fmtDuration, zoneFor } from './context-dashboard-primitives';
import { ResidencySection } from './context-dashboard-residency';
import {
  AgentFootprintSection,
  CompactionSection,
  CompositionSection,
  MetricsSection,
  PressureSection,
  SessionSection,
  ThresholdSection,
} from './context-dashboard-sections';
import type { ContextDebugPayload } from './context-host';
import { useContextFeed } from './feed';

const NO_CONNECTION_KEY = () => '';

/** Stagger entrance animation indices for section cards. */
const staggerDelay = (i: number) => ({
  animation: `fadeInUp 0.4s ease-out ${i * 0.08}s both`,
});

export function ContextDashboard() {
  const { t } = useAppTranslation();
  const host = useSurfaceHost();
  const feed = useContextFeed();
  const session = feed.useSession();
  const sessionId = feed.useSessionId();
  const connectionKey = (feed.useConnectionKey ?? NO_CONNECTION_KEY)();
  const agents = feed.useAgents();
  const MemoryPanels = feed.Memory;

  const [debugData, setDebugData] = useState<ContextDebugPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [debugError, setDebugError] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  // A newer request (refresh, another conversation) cancels the one before it, so a late
  // reply never overwrites the breakdown on screen.
  const fetchDebug = useCallback(() => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true);
    setDebugError(null);
    feed.requestDebug(controller.signal).then(
      (payload) => {
        if (controller.signal.aborted) return;
        setDebugData(payload);
        setLoading(false);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setDebugError(error instanceof Error ? error.message : String(error));
      },
    );
  }, [feed]);

  // Read again when the foreground conversation or the connection changes: the page stays
  // mounted between conversations and would otherwise keep the previous one's breakdown.
  useEffect(() => {
    setDebugData(null);
    fetchDebug();
    return () => {
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [fetchDebug, sessionId, connectionKey]);

  const { lastInputTokens, maxContext, mode, contextMode, iteration } = session;
  const model = session.model || '—';
  const provider = session.provider || '—';
  const pct = maxContext > 0 ? Math.min(100, (lastInputTokens / maxContext) * 100) : 0;
  const uptime = fmtDuration(session.startTime);
  const iterText = iteration ? `${iteration.index} / ${iteration.max}` : '—';
  const zone = zoneFor(pct);

  return (
    <div
      ref={host.useScrollRestore<HTMLDivElement>('context')}
      className="ws-page flex-1 min-h-0 overflow-y-auto overscroll-contain"
      data-workbench-view="context"
    >
      {/* Inject fadeInUp keyframes once */}
      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      {/* Header bar. It stays on top while the page scrolls, so it is opaque; the zone tint is
          its own layer (a translucent background alone let the cards show through). */}
      <div
        className="ws-page-header sticky top-0 z-10 flex items-center gap-3 px-4 py-2 border-b border-l-2 bg-background"
        style={{ borderLeftColor: zone.cssColor }}
      >
        <span aria-hidden className={cn('pointer-events-none absolute inset-0 -z-10', zone.bg)} />
        <PageMotif kind="chart" />
        {feed.back && (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={feed.back}
            aria-label={t('common:action.back')}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="ws-page-icon text-lg">{zone.emoji}</span>
          <div className="min-w-0">
            <h1>{t('activity:ctxDash.contextDashboard')}</h1>
            <span
              className={cn(
                'mt-1 inline-flex px-1.5 py-0.5 font-mono text-[10px]',
                zone.bg,
                zone.text,
              )}
            >
              {t(zone.labelKey)}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={fetchDebug}
          className="p-1 rounded hover:bg-accent transition-colors"
          title={t('activity:ctxDash.refreshDebugData')}
          aria-label={t('activity:ctxDash.refreshDebugData')}
        >
          <RefreshCw
            className={cn('h-3.5 w-3.5 text-muted-foreground', loading && 'animate-spin')}
          />
        </button>
      </div>

      {/* Dashboard grid */}
      <div className="p-4 space-y-4">
        {/* Top row: session + pressure */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4" style={staggerDelay(0)}>
          <div className="lg:col-span-2">
            <PressureSection pct={pct} tokens={lastInputTokens} maxTokens={maxContext} />
          </div>
          <div style={staggerDelay(1)}>
            <SessionSection
              model={model}
              provider={provider}
              mode={mode}
              uptime={uptime}
              projectName={session.projectName}
              cwd={session.cwd}
              contextMode={contextMode}
            />
          </div>
        </div>

        {/* Middle row: composition + threshold + compaction */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4" style={staggerDelay(2)}>
          <CompositionSection data={debugData} loading={loading} />
          <ThresholdSection pct={pct} />
          <CompactionSection pct={pct} maxTokens={maxContext} />
        </div>

        {/* What of the context is cached, written or live, and what compaction keeps */}
        <div style={staggerDelay(3)}>
          <ResidencySection residency={debugData?.residency} retention={debugData?.retention} />
        </div>

        {/* Fleet footprint */}
        <div style={staggerDelay(3)}>
          <AgentFootprintSection agents={agents} />
        </div>

        {MemoryPanels && (
          <div style={staggerDelay(4)}>
            <MemoryPanels />
          </div>
        )}

        {/* Bottom row: metrics */}
        <div style={staggerDelay(6)}>
          <MetricsSection
            tokens={lastInputTokens}
            maxTokens={maxContext}
            pct={pct}
            model={model}
            provider={provider}
            mode={mode}
            uptime={uptime}
            iteration={iterText}
            contextMode={contextMode}
          />
        </div>

        {/* Error banner */}
        {debugError && (
          <div
            className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive"
            style={staggerDelay(7)}
          >
            {debugError}
          </div>
        )}
      </div>
    </div>
  );
}
