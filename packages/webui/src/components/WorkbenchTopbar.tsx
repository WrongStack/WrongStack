import {
  Bot,
  Building2,
  Check,
  Command,
  Menu,
  Monitor,
  Moon,
  MoreVertical,
  Palette,
  Radio,
  Route,
  Settings,
  Sparkles,
  Sun,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback } from 'react';
import { useIsFullChrome } from '@/hooks/useChromeLevel';
import { useHqStatus, useWrongProxyStatus } from '@/hooks/useIntegrationStatus';
import { useAppTranslation } from '@/i18n';
import { getPalette, PALETTES } from '@/lib/palettes';
import { cn } from '@/lib/utils';
import { useConfigStore, useSessionStore, useUIStore } from '@/stores';
import { CronTrigger } from './CronTrigger';
import { InspectorTrigger } from './InspectorPanel';
import { NotificationMenu } from './NotificationMenu';
import { formatCompactBytes, SystemHealthChip, useServerProcessMetrics } from './SystemHealthChip';
import { useTheme } from './ThemeProvider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

// ── Helpers ─────────────────────────────────────────────────────────────────

export function viewLabel(view: string): string {
  return view
    .split('-')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

// ── WorkbenchTopbar ─────────────────────────────────────────────────────────

function VersionBadge({
  version,
  latestVersion,
  updatePending,
}: {
  version: string;
  latestVersion: string;
  updatePending: boolean;
}) {
  if (!version) return null;
  return (
    <span
      data-testid="topbar-version"
      className={cn(
        'inline-flex max-w-full shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums',
        updatePending
          ? 'border-warning/40 bg-warning/10 text-warning'
          : 'border-primary/30 bg-primary/10 text-foreground',
      )}
      title={
        updatePending
          ? `Update available: v${version} → v${latestVersion} — run wstack update`
          : `WrongStack v${version}`
      }
    >
      <span className="shrink-0">v{version}</span>
      {updatePending && <span className="truncate text-[10px]">→ v{latestVersion}</span>}
    </span>
  );
}

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
  const wrongProxy = useWrongProxyStatus();
  const hq = useHqStatus();
  const agentRosterActiveTab = useUIStore((s) => s.agentRosterActiveTab);
  const officeMapActive = currentView === 'roster' && agentRosterActiveTab === 'officemap';
  const openOfficeMap = () => {
    const ui = useUIStore.getState();
    ui.setAgentRosterActiveTab('officemap');
    ui.setSidebarOpen(false);
    ui.setCurrentView('roster');
  };
  const openIntegrations = () => {
    useUIStore.getState().setSettingsActiveTab('integrations');
    onSettings();
  };

  const wrongProxyTooltip =
    wrongProxy.status === 'connected'
      ? `WrongProxy: Connected${wrongProxy.latencyMs != null ? ` (${wrongProxy.latencyMs}ms)` : ''} · ${wrongProxy.url}`
      : wrongProxy.status === 'error'
        ? `WrongProxy: Unreachable · ${wrongProxy.url}${wrongProxy.error ? ` (${wrongProxy.error})` : ''}`
        : wrongProxy.status === 'checking'
          ? `WrongProxy: Checking · ${wrongProxy.url}`
          : 'WrongProxy: Disabled';

  const hqTooltip =
    hq.status === 'connected'
      ? `HQ: Connected${hq.latencyMs != null ? ` (${hq.latencyMs}ms)` : ''} · ${hq.url}`
      : hq.status === 'error'
        ? `HQ: Unreachable · ${hq.url}${hq.error ? ` (${hq.error})` : ''}`
        : hq.status === 'checking'
          ? `HQ: Checking · ${hq.url}`
          : 'HQ: Disabled';

  const serverProcess = useServerProcessMetrics();
  // Calm chrome (default) folds RAM / Index / dropped-tools / WrongProxy / HQ /
  // WS into SystemHealthChip and combines the appearance controls.
  const fullChrome = useIsFullChrome();
  const updatePending = Boolean(updateAvailable && latestVersion && latestVersion !== appVersion);
  const officeMapButton = (
    <button
      type="button"
      onClick={openOfficeMap}
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border hover:bg-accent/60',
        officeMapActive
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border/70 bg-background/60 text-muted-foreground hover:text-foreground',
      )}
      title={`${t('activity:agentRoster.tabOfficeMap')} (F11)`}
      aria-label={t('activity:agentRoster.tabOfficeMap')}
      aria-pressed={officeMapActive}
      data-testid="topbar-office-map"
    >
      <Building2 className="h-4 w-4" aria-hidden="true" />
    </button>
  );
  const paletteItems = PALETTES.map((option) => (
    <DropdownMenuItem key={option.id} onSelect={() => setPalette(option.id)} className="gap-2">
      <span
        aria-hidden
        className="h-4 w-4 shrink-0 rounded-[3px] border border-border/70"
        style={{
          background: `linear-gradient(90deg, ${option.swatch} 0 50%, ${option.swatchSecondary} 50% 100%)`,
        }}
      />
      <span className="flex-1">{t(option.labelKey)}</span>
      {palette === option.id ? <Check className="h-3.5 w-3.5 text-primary" aria-hidden /> : null}
    </DropdownMenuItem>
  ));
  const heapLoad = serverProcess ? serverProcess.memoryUsage.heapUsed / serverProcess.heapLimit : 0;
  const indexServer = serverProcess?.codebaseIndexServer;
  const indexHealth = indexServer?.health;
  const indexMetrics = indexHealth?.server;

  return (
    <>
      {/* ── Mobile Compact Header (<md) ── */}
      <div className="ws-topbar flex shrink-0 items-center justify-between gap-1.5 border-b border-border/70 bg-card/85 px-2.5 py-1.5 shadow-sm backdrop-blur-xl md:hidden">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={toggleSidebar}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            aria-label={t('activity:topbar.toggleNavigationMenu', 'Toggle navigation menu')}
            title={t('activity:topbar.toggleNavigation', 'Toggle navigation')}
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                {projectName || 'WrongStack'}
              </span>
              {isLoading && (
                <span className="inline-flex items-center gap-0.5 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                  <Bot className="h-3 w-3 animate-pulse text-primary" />
                </span>
              )}
            </div>
            <span className="block truncate font-mono text-[10px] text-muted-foreground">
              {t(`activity:topbar.view.${currentView}`, { defaultValue: viewLabel(currentView) })}
            </span>
            {appVersion && (
              <div className="mt-0.5 flex min-w-0">
                <VersionBadge
                  version={appVersion}
                  latestVersion={latestVersion}
                  updatePending={updatePending}
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {officeMapButton}
          {/* AGENTS entry — shared top bar, present on every tab/view (icon +
              badge only at this width; the label expands in on lg screens). */}
          <InspectorTrigger />
          <NotificationMenu />
          <button
            type="button"
            onClick={toggleTheme}
            className="hidden h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground min-[480px]:inline-flex"
            title={
              effectiveTheme === 'dark'
                ? t('activity:topbar.switchToLight', 'Switch to light theme')
                : t('activity:topbar.switchToDark', 'Switch to dark theme')
            }
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
                title={t('activity:topbar.moreOptions', 'More options')}
                aria-label={t('activity:topbar.moreOptions', 'More options')}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={toggleTheme} className="gap-2 min-[480px]:hidden">
                {effectiveTheme === 'dark' ? (
                  <Sun className="h-4 w-4" />
                ) : (
                  <Moon className="h-4 w-4" />
                )}
                <span>
                  {effectiveTheme === 'dark'
                    ? t('activity:topbar.switchToLight', 'Switch to light theme')
                    : t('activity:topbar.switchToDark', 'Switch to dark theme')}
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onPalette} className="gap-2">
                <Command className="h-4 w-4" />
                <span>{t('activity:topbar.command')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onSettings} className="gap-2">
                <Settings className="h-4 w-4" />
                <span>{t('activity:topbar.settings')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={openOfficeMap} className="gap-2">
                <Building2 className="h-4 w-4" />
                <span>{t('activity:agentRoster.tabOfficeMap')}</span>
              </DropdownMenuItem>
              <div className="border-t border-border/60 my-1 px-2 py-1 space-y-1 text-[11px] text-muted-foreground">
                <div className="flex items-center justify-between">
                  <span>Backend WS</span>
                  <span
                    className={cn(
                      'font-mono font-medium',
                      wsConnected ? 'text-success' : 'text-warning',
                    )}
                  >
                    {wsConnected
                      ? t('activity:topbar.status.connected', 'Connected')
                      : t('activity:topbar.status.offline', 'Offline')}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>WrongProxy</span>
                  <span
                    className={cn(
                      'font-mono font-medium',
                      wrongProxy.status === 'connected'
                        ? 'text-success'
                        : wrongProxy.status !== 'disabled'
                          ? 'text-destructive'
                          : 'text-muted-foreground',
                    )}
                  >
                    {wrongProxy.status === 'connected'
                      ? t('activity:topbar.status.connected', 'Connected')
                      : wrongProxy.status === 'checking'
                        ? t('activity:topbar.status.checking', 'Checking')
                        : wrongProxy.status === 'error'
                          ? t('activity:topbar.status.offline', 'Offline')
                          : t('activity:topbar.status.disabled', 'Disabled')}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>HQ</span>
                  <span
                    className={cn(
                      'font-mono font-medium',
                      hq.status === 'connected'
                        ? 'text-success'
                        : hq.status !== 'disabled'
                          ? 'text-destructive'
                          : 'text-muted-foreground',
                    )}
                  >
                    {hq.status === 'connected'
                      ? t('activity:topbar.status.connected', 'Connected')
                      : hq.status === 'checking'
                        ? t('activity:topbar.status.checking', 'Checking')
                        : hq.status === 'error'
                          ? t('activity:topbar.status.offline', 'Offline')
                          : t('activity:topbar.status.disabled', 'Disabled')}
                  </span>
                </div>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ── Desktop Full Header (>=md) ── */}
      <div className="ws-topbar hidden shrink-0 border-b border-border/70 bg-card/85 px-3 py-2 shadow-sm backdrop-blur-xl md:block">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                {/* Typographic anchor for the workbench: the one 700-weight,
                    largest-type element on the screen. The session/project you
                    are working inside is the one thing an operator must never
                    lose across a long session, so it outranks the sibling
                    status chips (11px/500) instead of competing with them. */}
                <span className="truncate text-base font-bold">{projectName || 'WrongStack'}</span>
                <VersionBadge
                  version={appVersion}
                  latestVersion={latestVersion}
                  updatePending={updatePending}
                />
                <span className="rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {t(`activity:topbar.view.${currentView}`, {
                    defaultValue: viewLabel(currentView),
                  })}
                </span>
                {/* Calm: only a running agent earns a status chip — "Ready" is the
                    resting state, and the iteration count lives in the chat. */}
                {fullChrome || isLoading ? (
                  <span
                    data-testid="topbar-run-status"
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
                    {isLoading
                      ? t('activity:topbar.statusRunning')
                      : t('activity:topbar.statusReady')}
                    {fullChrome && iteration ? (
                      <span className="tabular">
                        {iteration.index}
                        {iteration.max > 0 ? `/${iteration.max}` : ''}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {/* AGENTS entry — lives in the shared top bar so it stays on
                    screen across every tab and main view, with the running
                    subagent count for the active session always visible. */}
                <InspectorTrigger showCountWhenZero />
                {fullChrome && serverProcess ? (
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
                {fullChrome && indexServer ? (
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
                {fullChrome && droppedTools > 0 ? (
                  <span
                    className="rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-warning"
                    title={`${droppedTools} tool(s) dropped from provider requests due to maxTools limit`}
                  >
                    -{droppedTools} tools
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {sessionLabel || t('activity:topbar.noNamedSession')}
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
            {fullChrome ? (
              <>
                <button
                  type="button"
                  onClick={toggleTheme}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  title={
                    effectiveTheme === 'dark'
                      ? t('activity:topbar.switchToLight', 'Switch to light theme')
                      : t('activity:topbar.switchToDark', 'Switch to dark theme')
                  }
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
                    {paletteItems}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              /* Calm: light/dark/system and the colour palette share one menu. */
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    data-testid="topbar-appearance-menu"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                    title={t('activity:topbar.appearance', 'Appearance')}
                    aria-label={t('activity:topbar.appearance', 'Appearance')}
                  >
                    {effectiveTheme === 'dark' ? (
                      <Moon className="h-3.5 w-3.5" />
                    ) : (
                      <Sun className="h-3.5 w-3.5" />
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>{t('activity:topbar.theme', 'Theme')}</DropdownMenuLabel>
                  {(
                    [
                      ['light', t('activity:topbar.themeLight', 'Light'), Sun],
                      ['dark', t('activity:topbar.themeDark', 'Dark'), Moon],
                      ['system', t('activity:topbar.themeSystem', 'System'), Monitor],
                    ] as const
                  ).map(([value, label, Icon]) => (
                    <DropdownMenuItem
                      key={value}
                      onSelect={() => setTheme(value)}
                      className="gap-2"
                    >
                      <Icon className="h-4 w-4" aria-hidden />
                      <span className="flex-1">{label}</span>
                      {theme === value ? (
                        <Check className="h-3.5 w-3.5 text-primary" aria-hidden />
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{t('settings:general.paletteHeading')}</DropdownMenuLabel>
                  {paletteItems}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <CronTrigger />
            <NotificationMenu />
            {fullChrome ? (
              <>
                {/* WrongProxy Status */}
                <button
                  type="button"
                  onClick={openIntegrations}
                  className={cn(
                    'inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background/60 transition-colors',
                    wrongProxy.status === 'connected'
                      ? 'border-border/70 text-success hover:bg-accent/60'
                      : wrongProxy.status !== 'disabled'
                        ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
                        : 'border-border/50 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent/60',
                  )}
                  title={wrongProxyTooltip}
                  aria-label={wrongProxyTooltip}
                  data-testid="wrongproxy-status-button"
                >
                  <Route className="h-3.5 w-3.5" />
                </button>

                {/* HQ Status */}
                <button
                  type="button"
                  onClick={openIntegrations}
                  className={cn(
                    'inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background/60 transition-colors',
                    hq.status === 'connected'
                      ? 'border-border/70 text-success hover:bg-accent/60'
                      : hq.status !== 'disabled'
                        ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
                        : 'border-border/50 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent/60',
                  )}
                  title={hqTooltip}
                  aria-label={hqTooltip}
                  data-testid="hq-status-button"
                >
                  <Radio className="h-3.5 w-3.5" />
                </button>

                {/* Backend WS Status */}
                <span
                  role="status"
                  aria-label={
                    wsConnected
                      ? t('activity:topbar.status.connected', 'Connected')
                      : t('activity:topbar.status.disconnected', 'Disconnected')
                  }
                  className={cn(
                    'inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60',
                    wsConnected ? 'text-success' : 'text-warning',
                  )}
                  title={
                    wsConnected
                      ? t('activity:topbar.status.connected', 'Connected')
                      : t('activity:topbar.status.disconnected', 'Disconnected')
                  }
                  data-testid="ws-status-indicator"
                >
                  {wsConnected ? (
                    <Wifi className="h-3.5 w-3.5" />
                  ) : (
                    <WifiOff className="h-3.5 w-3.5" />
                  )}
                </span>
              </>
            ) : (
              <SystemHealthChip
                wsConnected={wsConnected}
                server={serverProcess}
                droppedTools={droppedTools}
                wrongProxy={wrongProxy}
                hq={hq}
                appVersion={appVersion}
                onOpenIntegrations={openIntegrations}
              />
            )}
            <button
              type="button"
              onClick={onSettings}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              title={t('activity:topbar.settings')}
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
            {officeMapButton}
          </div>
        </div>
      </div>
    </>
  );
}
