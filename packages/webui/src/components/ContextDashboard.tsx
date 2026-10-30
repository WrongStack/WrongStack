/**
 * ContextDashboard — a full-page context-window telemetry dashboard for the WebUI.
 *
 * Mirrors the TUI `/context window` panel: pressure bar, source breakdown,
 * threshold map, compaction engine, per-agent footprints, token metrics.
 *
 * Data sources:
 *   - session-store: lastInputTokens, maxContext, mode, model, uptime, iteration
 *   - fleet-store:  per-agent ctxPct/ctxTokens for per-agent footprint
 *   - context.debug WS: detailed breakdown (system prompt, tools, messages)
 */

import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { useAppTranslation } from '@/i18n';
import { agentBelongsToSession } from '@/lib/agent-session';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import {
  useActiveSessionId,
  useConfigStore,
  useFleetStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import { ContextMemoryMonitor } from './ContextMemoryMonitor';
import { ResidencySection } from './context-dashboard-residency.js';
import type { ContextDebugPayload } from './context-dashboard-sections.js';
import {
  AgentFootprintSection,
  CompactionSection,
  CompositionSection,
  fmtDuration,
  MetricsSection,
  PressureSection,
  SessionSection,
  ThresholdSection,
  zoneFor,
} from './context-dashboard-sections.js';
import { MemoryLifecycleTrace } from './MemoryManager/MemoryLifecycleTrace';
import { PageMotif } from './PageMotif';

// ── Main component ────────────────────────────────────────────────────

export function ContextDashboard() {
  const { t } = useAppTranslation();
  const setCurrentView = useUIStore((s) => s.setCurrentView);

  // Session data
  const {
    lastInputTokens,
    maxContext,
    mode,
    contextMode,
    startTime,
    session,
    iteration,
    projectName,
    cwd,
  } = useSessionStore(
    useShallow((s) => ({
      lastInputTokens: s.lastInputTokens,
      maxContext: s.maxContext,
      mode: s.mode,
      contextMode: s.contextMode,
      startTime: s.startTime,
      session: s.session,
      iteration: s.iteration,
      projectName: s.projectName,
      cwd: s.cwd,
    })),
  );

  // Fleet data — useShallow stabilizes derived array reference
  // Session-scoped: this dashboard describes THIS tab's context window, so
  // the footprint must not count other tabs' agents — their tokens and cost
  // belong to their own sessions' dashboards.
  const activeSessionId = useActiveSessionId();
  const fleetAgents = useFleetStore(
    useShallow((s) =>
      [...s.agents.values()].filter((a) => agentBelongsToSession(a.sessionId, activeSessionId)),
    ),
  );

  // Debug data from context.debug WS
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const [debugData, setDebugData] = useState<ContextDebugPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [debugError, setDebugError] = useState<string | null>(null);
  const debugGenRef = useRef(0);
  const debugUnsubRef = useRef<(() => void) | null>(null);

  const fetchDebug = () => {
    // Clean up any previous in-flight request to prevent listener leaks
    // when the user clicks refresh multiple times in rapid succession.
    debugUnsubRef.current?.();
    debugUnsubRef.current = null;

    const ws = getWSClient(wsUrl);
    if (!ws?.send) {
      setDebugError('WebSocket not connected');
      return;
    }
    const gen = ++debugGenRef.current;
    setLoading(true);
    setDebugError(null);

    // Addressed at the tab on screen. Unaddressed, the server answers from
    // whichever session it is pointing at, so this panel showed another tab's
    // breakdown — and a reply meant for another tab overwrote it.
    const askedFor = ws.withSession({}).sessionId;
    ws.send({ type: 'context.debug', payload: ws.withSession({}) }, { echoToChat: false });
    // Cancelled flag prevents the timeout from overwriting a successful response
    // and the response handler from acting on a stale timeout. The first
    // completion (response or timeout) sets it; the other becomes a no-op.
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const handler = (msg: { type: string; payload?: unknown }) => {
      if (cancelled) return;
      if (msg.type !== 'context.debug') return;
      if (debugGenRef.current !== gen) return;
      const replyFor = (msg.payload as { sessionId?: string } | undefined)?.sessionId;
      if (askedFor !== undefined && replyFor !== undefined && replyFor !== askedFor) return;
      cancelled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      setDebugData(msg.payload as ContextDebugPayload);
      setLoading(false);
      unsub();
    };
    const unsub = ws.on('context.debug', handler);
    debugUnsubRef.current = unsub;

    timeoutId = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      if (debugGenRef.current === gen) {
        setLoading(false);
        setDebugError('No response from server');
        unsub();
      }
    }, 5000);
  };

  // Refetch when the foreground moves, not only when the socket changes: the
  // panel is not unmounted between tabs, so without this it kept showing the
  // previous tab's breakdown until the user pressed refresh.
  const debugSessionId = activeSessionId;
  useEffect(() => {
    setDebugData(null);
    fetchDebug();
    return () => {
      // Invalidate any in-flight request and clean up the WS listener
      // so stale state mutations cannot reach unmounted components.
      debugGenRef.current++;
      debugUnsubRef.current?.();
      debugUnsubRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl, debugSessionId]);

  // Derived values
  const model = session?.model ?? '—';
  const provider = session?.provider ?? '—';
  const pct = maxContext > 0 ? Math.min(100, (lastInputTokens / maxContext) * 100) : 0;
  const uptime = fmtDuration(startTime);
  const iterText = iteration ? `${iteration.index} / ${iteration.max}` : '—';
  const zone = zoneFor(pct);

  // Stagger entrance animation indices for section cards
  const staggerDelay = (i: number) => ({
    animation: `fadeInUp 0.4s ease-out ${i * 0.08}s both`,
  });

  return (
    <div
      ref={useScrollPosition('context')}
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
      {/* Header bar */}
      <div
        className={cn(
          'ws-page-header sticky top-0 z-10 flex items-center gap-3 px-4 py-2 border-b border-l-2',
          zone.bg,
        )}
        style={{ borderLeftColor: zone.cssColor }}
      >
        <PageMotif kind="chart" />
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={() => setCurrentView('chat')}
          aria-label={t('common:action.back')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
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
              projectName={projectName ?? ''}
              cwd={cwd ?? ''}
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
          <AgentFootprintSection agents={fleetAgents} />
        </div>

        <div style={staggerDelay(4)}>
          <ContextMemoryMonitor />
        </div>
        <div style={staggerDelay(5)}>
          <MemoryLifecycleTrace />
        </div>

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
