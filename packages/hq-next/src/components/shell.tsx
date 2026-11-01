'use client';

/**
 * The HQ desktop shell: a section rail, a header with the section's tabs, the
 * global banners, and the content area.
 *
 * Owns the things no surface may duplicate: theme application, the global
 * keyboard map, the auth gate, and the bridge that turns a legacy
 * `setActiveView()` call into a real navigation.
 */
import { AppearanceMenu } from '@hq/components/hq/appearance-menu';
import { ConnectionBanner, PeerLifecycleBanner } from '@hq/components/hq/banners';
import { CommandPalette } from '@hq/components/hq/command-palette';
import { OperatorContext } from '@hq/components/hq/operator-context';
import { ToastOverlay } from '@hq/components/hq/toast-overlay';
import { TokenGate } from '@hq/components/hq/token-gate';
import { authorizedFetch } from '@hq/data/api';
import { clearHqToken, resolveHqToken } from '@hq/data/auth/index';
import { useHqLocalPrefs } from '@hq/data/local-prefs';
import { unreadMailboxCount } from '@hq/data/selectors';
import { type HqViewId, useHqStore } from '@hq/data/store/index';
import { applyPalette, applyTheme, watchSystemTheme } from '@hq/lib/theme';
import { LogOut, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ScopePicker } from '@/components/scope-picker';
import { useAttentionQueue } from '@/features/attention/use-attention-queue';
import { UpdateNoticeChip } from '@/features/update/update-notice';
import { cn } from '@/lib/cn';
import {
  HQ_SECTIONS,
  type HqSectionId,
  hrefForView,
  normalizePath,
  sectionForPath,
  tabForPath,
} from '@/lib/sections';

const WIDE_VIEWPORT = 1280;

function useAppearance(): void {
  const { theme, palette } = useHqLocalPrefs().appearance;
  useEffect(() => {
    const root = document.documentElement;
    applyTheme(root, theme);
    if (theme !== 'system') return;
    return watchSystemTheme(() => applyTheme(root, theme));
  }, [theme]);
  useEffect(() => {
    applyPalette(document.documentElement, palette);
  }, [palette]);
}

/**
 * Legacy views navigate by writing `activeView`. Translate every such write
 * into a router push, so a "open fleet" button inside an old surface lands on
 * `/fleet/` like any link would.
 */
function useLegacyNavigationBridge(): void {
  const router = useRouter();
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  useEffect(
    () =>
      useHqStore.subscribe((state, previous) => {
        if (state.activeView === previous.activeView) return;
        const href = hrefForView(state.activeView);
        if (normalizePath(pathRef.current) !== href) router.push(href);
      }),
    [router],
  );
}

export function HqShell({ children }: { children: ReactNode }): ReactNode {
  const authRequired = useHqStore((state) => state.authRequired);
  useAppearance();
  if (authRequired) return <TokenGate hadToken={resolveHqToken() !== null} />;
  return <AuthenticatedShell>{children}</AuthenticatedShell>;
}

function AuthenticatedShell({ children }: { children: ReactNode }): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const section = sectionForPath(pathname);
  const tab = tabForPath(pathname);
  const mainRef = useRef<HTMLElement>(null);

  const { snapshot, connected } = useHqStore(
    useShallow((state) => ({ snapshot: state.snapshot, connected: state.connected })),
  );
  const { items: attention, outside } = useAttentionQueue();

  const [railOpen, setRailOpen] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useLegacyNavigationBridge();

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${WIDE_VIEWPORT - 1}px)`);
    const apply = (matches: boolean): void => {
      setNarrow(matches);
      setRailOpen(!matches);
    };
    apply(query.matches);
    const onChange = (event: MediaQueryListEvent): void => apply(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    document.title =
      section.id === 'overview' ? 'WrongStack HQ' : `${tab.label} · ${section.label} · HQ`;
    mainRef.current?.scrollTo({ top: 0 });
    if (narrow) setRailOpen(false);
  }, [section, tab, narrow]);

  const navigateToView = useCallback(
    (view: HqViewId): void => router.push(hrefForView(view)),
    [router],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"]',
        )
      )
        return;
      if (meta && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setRailOpen((open) => !open);
        return;
      }
      if (event.altKey && /^[1-6]$/.test(event.key)) {
        const next = HQ_SECTIONS.find((candidate) => candidate.shortcut === Number(event.key));
        if (next !== undefined) {
          event.preventDefault();
          router.push(next.tabs[0]!.href);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [router]);

  const badges: Partial<Record<HqSectionId, number>> = {
    inbox: attention.length,
    work: unreadMailboxCount(snapshot),
  };
  const machines = snapshot?.machines?.length ?? 0;
  const clients = snapshot?.clients?.filter((client) => client.connected).length ?? 0;

  const logout = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await authorizedFetch('/api/logout', { method: 'POST' });
    } finally {
      clearHqToken();
      window.location.reload();
    }
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      {/* First in the DOM, so the first Tab offers it before the whole rail. */}
      <a
        href="#hq-main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-card focus:px-4 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>
      {narrow && railOpen && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Close navigation"
          onClick={() => setRailOpen(false)}
          className="fixed inset-0 z-30 bg-background/70 backdrop-blur-[2px]"
        />
      )}

      <aside
        aria-label="HQ sections"
        className={cn(
          'z-40 h-full w-60 shrink-0 flex-col border-r border-border bg-card',
          narrow && 'fixed inset-y-0 left-0 shadow-xl',
          railOpen ? 'flex' : 'hidden',
        )}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
          <span aria-hidden className="brand-rule size-3 shrink-0" />
          <span className="font-display text-[15px] font-semibold tracking-tight">
            WrongStack HQ
          </span>
          <button
            type="button"
            onClick={() => setRailOpen(false)}
            aria-label="Collapse navigation"
            title="Collapse navigation (Ctrl+B)"
            className="ml-auto grid size-8 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <PanelLeftClose className="size-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {HQ_SECTIONS.map((candidate) => {
            const Icon = candidate.icon;
            const active = candidate.id === section.id;
            const badge = badges[candidate.id] ?? 0;
            return (
              <Link
                key={candidate.id}
                href={candidate.tabs[0]!.href}
                aria-current={active ? 'page' : undefined}
                title={`${candidate.summary} (Alt+${candidate.shortcut})`}
                className={cn(
                  'group flex h-10 items-center gap-3 px-3 text-sm transition-colors',
                  active
                    ? 'bg-accent/70 font-semibold text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'opacity-80')} />
                <span className="flex-1">{candidate.label}</span>
                {badge > 0 && (
                  <span className="tabular min-w-6 bg-primary px-1.5 py-0.5 text-center text-xs font-semibold text-primary-foreground">
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                'size-2 shrink-0',
                connected ? 'bg-success' : 'animate-pulse bg-warning',
              )}
            />
            <span className="font-medium">{connected ? 'Live' : 'Reconnecting'}</span>
            <span className="ml-auto text-xs text-muted-foreground tabular">
              {machines} {machines === 1 ? 'machine' : 'machines'} · {clients}{' '}
              {clients === 1 ? 'client' : 'clients'}
            </span>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col" inert={narrow && railOpen}>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
          {!railOpen && (
            <button
              type="button"
              onClick={() => setRailOpen(true)}
              aria-label="Open navigation"
              title="Open navigation (Ctrl+B)"
              className="grid size-8 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <PanelLeftOpen className="size-4" />
            </button>
          )}
          <h1 className="font-display text-lg font-semibold tracking-tight">{section.label}</h1>

          {section.tabs.length > 1 && (
            <nav
              aria-label={`${section.label} views`}
              className="flex h-full min-w-0 items-stretch overflow-x-auto"
            >
              {section.tabs.map((candidate) => {
                const active = candidate.href === tab.href;
                return (
                  <Link
                    key={candidate.href}
                    href={candidate.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center whitespace-nowrap border-b-2 px-3 text-sm transition-colors',
                      active
                        ? 'border-primary font-medium text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {candidate.label}
                  </Link>
                );
              })}
            </nav>
          )}

          <div className="ml-auto">
            <ScopePicker outside={outside.length} />
          </div>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-keyshortcuts="Control+K"
            className="flex h-9 items-center gap-2 border border-border px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Search className="size-4" />
            <span className="sr-only md:not-sr-only">Jump to…</span>
            <kbd className="hidden font-mono text-xs md:inline">Ctrl K</kbd>
          </button>
          <UpdateNoticeChip />
          <AppearanceMenu />
          <button
            type="button"
            onClick={() => void logout()}
            disabled={loggingOut}
            aria-label="Log out of HQ"
            title="Log out"
            className="grid size-9 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <LogOut className="size-4" />
          </button>
        </header>

        <ConnectionBanner />
        <PeerLifecycleBanner />
        {/* The Overview states the fleet context itself; elsewhere this bar anchors the selection. */}
        {section.id !== 'overview' && <OperatorContext />}

        <main
          id="hq-main"
          ref={mainRef}
          tabIndex={-1}
          aria-label={tab.label}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {children}
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onSelect={navigateToView} />
      <ToastOverlay />
    </div>
  );
}
