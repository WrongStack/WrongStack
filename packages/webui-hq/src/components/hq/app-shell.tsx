/**
 * The HQ workbench shell: nav rail, top bar, banners, router.
 *
 * The shell owns three things no view should duplicate:
 *  - applying theme + palette to <html> (the only place that knows about
 *    `.dark` and `data-palette`)
 *  - the global keyboard map (Ctrl+K palette, Ctrl+B rail, Alt+digit jump)
 *  - the auth gate, so a rejected credential replaces the whole surface
 *    rather than leaving twelve views to each render an empty pane
 */
import {
  ArrowUpCircle,
  LogOut,
  PanelLeftOpen,
  Search,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type * as React from 'react';
import { Suspense, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { authorizedFetch, fetchJson } from '../../data/api.js';
import { clearHqToken, resolveHqToken } from '../../data/auth/index.js';
import { useHqLocalPrefs } from '../../data/local-prefs.js';
import { attentionCount, unreadMailboxCount } from '../../data/selectors.js';
import { type HqViewId, useHqStore } from '../../data/store/index.js';
import { useToastStore } from '../../data/toast-store.js';
import { applyPalette, applyTheme, watchSystemTheme } from '../../lib/theme.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { Skeleton } from '../ui/skeleton.js';
import { TooltipProvider } from '../ui/tooltip.js';
import { AppearanceMenu } from './appearance-menu.js';
import { ConnectionBanner, PeerLifecycleBanner } from './banners.js';
import { CommandPalette } from './command-palette.js';
import { NavSidebar } from './nav-sidebar.js';
import { ToastOverlay } from './toast-overlay.js';
import { TokenGate } from './token-gate.js';
import { ViewErrorBoundary } from './view-error-boundary.js';
import { HQ_VIEW_COMPONENTS } from './view-router.js';
import { getHqView, HQ_VIEWS } from './views.js';

/** Six hours: an update notice is advisory, not something to poll for. */
const UPDATE_POLL_MS = 6 * 60 * 60 * 1000;
const WIDE_VIEWPORT = 1180;

interface HqUpdateStatus {
  current: string;
  latest: string;
  outdated: boolean;
  checkFailed: boolean;
  packageName: 'wrongstack' | '@wrongstack/cli';
  command: string;
}

function ViewSkeleton(): React.ReactElement {
  return (
    <div className="space-y-3 p-4">
      <Skeleton className="h-5 w-48" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
    </div>
  );
}

/** Apply appearance preferences to the document element. */
function useAppearance(): void {
  const { theme, palette } = useHqLocalPrefs().appearance;

  useEffect(() => {
    const root = document.documentElement;
    applyTheme(root, theme);
    if (theme !== 'system') return;
    // Only follow the OS while the user actually asked us to.
    return watchSystemTheme(() => applyTheme(root, theme));
  }, [theme]);

  useEffect(() => {
    applyPalette(document.documentElement, palette);
  }, [palette]);
}

/** Toast on transport transitions — but never on the very first connect. */
function useConnectionToasts(connected: boolean): void {
  const [everConnected, setEverConnected] = useState(false);

  useEffect(() => {
    if (connected) {
      if (everConnected) {
        useToastStore.getState().addToast('Reconnected to HQ server', 'success', 3_000);
      }
      setEverConnected(true);
      return;
    }
    if (everConnected) {
      useToastStore
        .getState()
        .addToast('Connection lost — reconnecting with backoff…', 'warning', 4_000);
    }
  }, [connected, everConnected]);
}

function useUpdateStatus(): HqUpdateStatus | null {
  const [status, setStatus] = useState<HqUpdateStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      fetchJson<HqUpdateStatus>('/api/system/update')
        .then((value) => {
          if (!cancelled) setStatus(value);
        })
        .catch(() => {
          // Advisory only — an update check must never block the command center.
        });
    };
    load();
    const timer = window.setInterval(load, UPDATE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return status;
}

export function AppShell(): React.ReactElement {
  const { snapshot, alerts, commandStatuses, activeView, authRequired, connected } = useHqStore(
    useShallow((state) => ({
      snapshot: state.snapshot,
      alerts: state.alerts,
      commandStatuses: state.commandStatuses,
      activeView: state.activeView,
      authRequired: state.authRequired,
      connected: state.connected,
    })),
  );

  const [navOpen, setNavOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= WIDE_VIEWPORT,
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useAppearance();
  useConnectionToasts(connected);
  const update = useUpdateStatus();

  // Narrowing the window turns the rail into an overlay; leaving it open would
  // bury the content behind a scrim the operator never asked for.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(`(max-width: ${WIDE_VIEWPORT - 1}px)`);
    const onChange = (event: MediaQueryListEvent): void => {
      if (event.matches) setNavOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const navigate = (view: HqViewId): void => {
    useHqStore.getState().setActiveView(view);
    if (window.innerWidth < WIDE_VIEWPORT) setNavOpen(false);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (meta && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setNavOpen((open) => !open);
        return;
      }
      if (event.altKey && /^\d$/.test(event.key)) {
        const target = HQ_VIEWS.find((view) => view.shortcut === Number(event.key));
        if (target !== undefined) {
          event.preventDefault();
          useHqStore.getState().setActiveView(target.id);
        }
        return;
      }
      if (event.key === 'Escape' && navOpen && window.innerWidth < WIDE_VIEWPORT) {
        setNavOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navOpen]);

  const logout = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await authorizedFetch('/api/logout', { method: 'POST' });
    } finally {
      // Clear regardless: a failed logout call must not leave a token behind.
      clearHqToken();
      window.location.reload();
    }
  };

  if (authRequired) return <TokenGate hadToken={resolveHqToken() !== null} />;

  const current = getHqView(activeView);
  const CurrentIcon = current.icon;
  const ActiveView = HQ_VIEW_COMPONENTS[activeView];
  const attention = attentionCount(snapshot, alerts, commandStatuses);

  return (
    <TooltipProvider delayDuration={400}>
      <div data-testid="hq-workbench" className="flex h-full w-full overflow-hidden">
        <NavSidebar
          open={navOpen}
          activeView={activeView}
          unreadCount={unreadMailboxCount(snapshot)}
          attentionCount={attention}
          onNavigate={navigate}
          onClose={() => setNavOpen(false)}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="brand-rule h-0.5 w-full shrink-0" />

          <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
            {!navOpen && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setNavOpen(true)}
                aria-label="Open HQ navigation"
                title="Open navigation (Ctrl+B)"
              >
                <PanelLeftOpen className="size-3.5" />
              </Button>
            )}

            <CurrentIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="text-[9px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                {current.eyebrow}
              </span>
              <h1 className="truncate font-display text-sm font-semibold">{current.label}</h1>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => setPaletteOpen(true)}
              className="ml-auto gap-2 text-muted-foreground"
              aria-label="Open command palette"
            >
              <Search className="size-3" />
              <span className="hidden sm:inline">Search views</span>
              <kbd className="hidden text-[9px] sm:inline">Ctrl K</kbd>
            </Button>

            {update?.outdated === true && (
              <a
                href="https://github.com/WrongStack/WrongStack/releases"
                target="_blank"
                rel="noreferrer"
                data-testid="update-notice"
                title={`${update.current} → ${update.latest}. Update with: ${update.command}`}
                className="hidden items-center gap-1 border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning md:inline-flex"
              >
                <ArrowUpCircle className="size-3" />
                {update.latest}
              </a>
            )}

            <span
              data-testid="connection-chip"
              data-connected={connected}
              title={connected ? 'Live telemetry' : 'Reconnecting'}
              className={cn(
                'inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px]',
                connected
                  ? 'border-success/35 bg-success/10 text-success'
                  : 'border-warning/35 bg-warning/10 text-warning',
              )}
            >
              {connected ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
              <span className="hidden sm:inline">{connected ? 'Live' : 'Offline'}</span>
            </span>

            <AppearanceMenu />

            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void logout()}
              disabled={loggingOut}
              aria-label="Log out of HQ"
              title="Log out"
            >
              <LogOut className="size-3.5" />
            </Button>
          </header>

          <ConnectionBanner />
          <PeerLifecycleBanner />

          <main className="min-h-0 flex-1 overflow-y-auto">
            <ViewErrorBoundary view={activeView}>
              <Suspense fallback={<ViewSkeleton />}>
                <ActiveView />
              </Suspense>
            </ViewErrorBoundary>
          </main>
        </div>

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onSelect={navigate} />
        <ToastOverlay />
      </div>
    </TooltipProvider>
  );
}
