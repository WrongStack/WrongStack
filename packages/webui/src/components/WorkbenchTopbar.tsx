import {
  Bot,
  Check,
  Command,
  Menu,
  Moon,
  MoreVertical,
  Palette,
  Settings,
  Sparkles,
  Sun,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { getPalette, PALETTES } from '@/lib/palettes';
import { cn } from '@/lib/utils';
import { useConfigStore, useSessionStore, useUIStore } from '@/stores';
import { CronTrigger } from './CronTrigger';
import { InspectorTrigger } from './InspectorPanel';
import { NotificationMenu } from './NotificationMenu';
import { useTheme } from './ThemeProvider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

// ── Helpers ─────────────────────────────────────────────────────────────────

export function viewLabel(view: string): string {
  return view
    .split('-')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

export interface ServerProcessMetrics {
  pid: number;
  memoryUsage: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  heapLimit: number;
  codebaseIndexServer?:
    | {
        status:
          | 'unavailable'
          | 'offline'
          | 'connecting'
          | 'connected'
          | 'degraded'
          | 'unresponsive'
          | 'error'
          | 'stopping';
        connected: boolean;
        pid?: number | undefined;
        health?:
          | {
              status: 'healthy' | 'degraded' | 'unresponsive';
              latencyMs: number | null;
              missedHeartbeats: number;
              server?:
                | {
                    uptimeMs: number;
                    memory: { rss: number; heapUsed: number; heapTotal: number };
                    clients: number;
                    activeRequests: number;
                    queuedWrites: number;
                    pendingExternalFiles: number;
                    watchingExternal: boolean;
                    watchingClients?: number | undefined;
                    clientLeaseTimeoutMs?: number | undefined;
                    oldestClientIdleMs?: number | undefined;
                  }
                | undefined;
            }
          | undefined;
      }
    | undefined;
}

export function formatCompactBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

export function useServerProcessMetrics(): ServerProcessMetrics | null {
  const [metrics, setMetrics] = useState<ServerProcessMetrics | null>(null);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch('/debug/system', { cache: 'no-store' });
        if (!response.ok) return;
        const next = (await response.json()) as ServerProcessMetrics;
        if (!disposed && Number.isFinite(next.memoryUsage?.rss)) setMetrics(next);
      } catch {
        // Keep the rest of the workbench usable if diagnostics are unavailable.
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  return metrics;
}

// ── WorkbenchTopbar ─────────────────────────────────────────────────────────

export function WorkbenchTopbar({
  currentView,
  projectName,
  sessionLabel,
  isLoading,
  iteration,
  onPalette,
  onSettings,
}: {
  currentView: string;
  projectName?: string | undefined;
  sessionLabel?: string | undefined;
  isLoading: boolean;
  iteration: { index: number; max: number } | null;
  onPalette: () => void;
  onSettings: () => void;
}) {
  const { t } = useAppTranslation();
  const { theme, setTheme, palette, setPalette } = useTheme();
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const appVersion = useSessionStore((s) => s.appVersion);
  const latestVersion = useSessionStore((s) => s.latestVersion);
  const updateAvailable = useSessionStore((s) => s.updateAvailable);
  const droppedTools = useSessionStore((s) => s.droppedTools);
  const effectiveTheme =
    theme === 'system'
      ? typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  const toggleTheme = useCallback(() => {
    setTheme(effectiveTheme === 'dark' ? 'light' : 'dark');
  }, [effectiveTheme, setTheme]);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const serverProcess = useServerProcessMetrics();
  const heapLoad = serverProcess ? serverProcess.memoryUsage.heapUsed / serverProcess.heapLimit : 0;
  const indexServer = serverProcess?.codebaseIndexServer;
  const indexHealth = indexServer?.health;
  const indexMetrics = indexHealth?.server;

  return (
    <>
      {/* ── Mobile Compact Header (<md) ── */}
      <div className="flex shrink-0 items-center justify-between border-b border-border/70 bg-card/85 px-2.5 py-1.5 shadow-sm backdrop-blur-xl md:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={toggleSidebar}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            aria-label="Toggle navigation menu"
            title="Toggle navigation"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-semibold">{projectName || 'WrongStack'}</span>
              <span className="rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground font-mono">
                {viewLabel(currentView)}
              </span>
              {isLoading && (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-primary">
                  <Bot className="h-3 w-3 animate-pulse" />
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* AGENTS entry — shared top bar, present on every tab/view (icon +
              badge only at this width; the label expands in on lg screens). */}
          <InspectorTrigger />
          <NotificationMenu />
          <button
            type="button"
            onClick={toggleTheme}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            title={effectiveTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {effectiveTheme === 'dark' ? (
              <Sun className="h-3.5 w-3.5" />
            ) : (
              <Moon className="h-3.5 w-3.5" />
            )}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                title="More options"
                aria-label="More options"
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={onPalette} className="gap-2">
                <Command className="h-4 w-4" />
                <span>{t('activity:topbar.command')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onSettings} className="gap-2">
                <Settings className="h-4 w-4" />
                <span>{t('activity:topbar.settings')}</span>
              </DropdownMenuItem>
              <div className="border-t border-border/60 my-1 px-2 py-1 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Status</span>
                <span
                  className={cn(
                    'font-mono font-medium',
                    wsConnected ? 'text-success' : 'text-warning',
                  )}
                >
                  {wsConnected ? 'Connected' : 'Offline'}
                </span>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ── Desktop Full Header (>=md) ── */}
      <div className="hidden shrink-0 border-b border-border/70 bg-card/85 px-3 py-2 shadow-sm backdrop-blur-xl md:block">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-semibold">
                  {projectName || 'WrongStack'}
                </span>
                {appVersion ? (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
                      updateAvailable && latestVersion && latestVersion !== appVersion
                        ? 'border-warning/40 bg-warning/10 text-warning'
                        : 'border-border/70 bg-muted/50 text-muted-foreground',
                    )}
                    title={
                      updateAvailable && latestVersion && latestVersion !== appVersion
                        ? `Update available: v${appVersion} → v${latestVersion} — run wstack update`
                        : `WrongStack v${appVersion}`
                    }
                  >
                    v{appVersion}
                    {updateAvailable && latestVersion && latestVersion !== appVersion ? (
                      <span className="text-[10px] opacity-80">→ v{latestVersion}</span>
                    ) : null}
                  </span>
                ) : null}
                <span className="rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {viewLabel(currentView)}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
                    isLoading ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {isLoading ? (
                    <Bot className="h-3 w-3 animate-pulse" />
                  ) : (
                    <Sparkles className="h-3 w-3" />
                  )}
                  {isLoading ? 'Running' : 'Ready'}
                  {iteration ? (
                    <span className="tabular">
                      {iteration.index}
                      {iteration.max > 0 ? `/${iteration.max}` : ''}
                    </span>
                  ) : null}
                </span>
                {/* AGENTS entry — lives in the shared top bar so it stays on
                    screen across every tab and main view, with the running
                    subagent count for the active session always visible. */}
                <InspectorTrigger showCountWhenZero />
                {serverProcess ? (
                  <span
                    className={cn(
                      'rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
                      heapLoad >= 0.85
                        ? 'text-destructive'
                        : heapLoad >= 0.6
                          ? 'text-warning'
                          : 'text-success',
                    )}
                    title={`WebUI server PID ${serverProcess.pid} · heap ${formatCompactBytes(serverProcess.memoryUsage.heapUsed)} / ${formatCompactBytes(serverProcess.heapLimit)}`}
                  >
                    RAM {formatCompactBytes(serverProcess.memoryUsage.rss)}
                  </span>
                ) : null}
                {indexServer ? (
                  <span
                    className={cn(
                      'rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
                      indexServer.status === 'connected'
                        ? 'text-success'
                        : indexServer.status === 'unresponsive' || indexServer.status === 'error'
                          ? 'text-destructive'
                          : indexServer.status === 'degraded' ||
                              indexServer.status === 'connecting' ||
                              indexServer.status === 'stopping'
                            ? 'text-warning'
                            : 'text-muted-foreground',
                    )}
                    title={[
                      `Codebase index: ${indexHealth?.status ?? indexServer.status}`,
                      indexServer.pid ? `PID ${indexServer.pid}` : null,
                      indexHealth?.latencyMs != null ? `RTT ${indexHealth.latencyMs}ms` : null,
                      indexMetrics ? `RAM ${formatCompactBytes(indexMetrics.memory.rss)}` : null,
                      indexHealth?.missedHeartbeats
                        ? `missed ${indexHealth.missedHeartbeats}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  >
                    Index {indexHealth?.status ?? indexServer.status}
                  </span>
                ) : null}
                {droppedTools > 0 ? (
                  <span
                    className="rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-warning"
                    title={`${droppedTools} tool(s) dropped from provider requests due to maxTools limit`}
                  >
                    -{droppedTools} tools
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {sessionLabel || 'No named session'}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onPalette}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background/60 px-2 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              title={t('activity:topbar.commandPalette')}
            >
              <Command className="h-3.5 w-3.5" />
              {t('activity:topbar.command')}
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              title={effectiveTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {effectiveTheme === 'dark' ? (
                <Sun className="h-3.5 w-3.5" />
              ) : (
                <Moon className="h-3.5 w-3.5" />
              )}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  title={`${t('settings:general.paletteSwitcherTitle')}: ${t(getPalette(palette).labelKey)}`}
                  aria-label={`${t('settings:general.paletteSwitcherTitle')}: ${t(getPalette(palette).labelKey)}`}
                >
                  <Palette className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>{t('settings:general.paletteHeading')}</DropdownMenuLabel>
                {PALETTES.map((option) => (
                  <DropdownMenuItem
                    key={option.id}
                    onSelect={() => setPalette(option.id)}
                    className="gap-2"
                  >
                    <span
                      aria-hidden
                      className="h-4 w-4 shrink-0 rounded-[3px] border border-border/70"
                      style={{
                        background: `linear-gradient(90deg, ${option.swatch} 0 50%, ${option.swatchSecondary} 50% 100%)`,
                      }}
                    />
                    <span className="flex-1">{t(option.labelKey)}</span>
                    {palette === option.id ? (
                      <Check className="h-3.5 w-3.5 text-primary" aria-hidden />
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <CronTrigger />
            <NotificationMenu />
            <span
              role="status"
              aria-label={wsConnected ? 'Connected' : 'Disconnected'}
              className={cn(
                'inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60',
                wsConnected ? 'text-success' : 'text-warning',
              )}
              title={wsConnected ? 'Connected' : 'Disconnected'}
            >
              {wsConnected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            </span>
            <button
              type="button"
              onClick={onSettings}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              title={t('activity:topbar.settings')}
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
