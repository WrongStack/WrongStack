'use client';

/**
 * The phone shell: a compact header, the shared screens, and a bottom tab bar
 * within thumb reach. It runs under `/mobile/`, the installed app's scope.
 *
 * Sign-in is password-only here and yields a deliberately narrow session
 * (`control.enqueue` + `control.approve.once`): send, steer, interrupt and
 * answer a prompt once — never standing approval rules or account changes.
 * The screens read the credential's capabilities and offer only what it may
 * do; the server re-checks every request regardless.
 */
import { ConnectionBanner, PeerLifecycleBanner } from '@hq/components/hq/banners';
import { ToastOverlay } from '@hq/components/hq/toast-overlay';
import { TokenGate } from '@hq/components/hq/token-gate';
import { authorizedFetch } from '@hq/data/api';
import { clearHqToken, resolveHqToken } from '@hq/data/auth/index';
import { useHqLocalPrefs } from '@hq/data/local-prefs';
import { unreadMailboxCount } from '@hq/data/selectors';
import { useHqStore } from '@hq/data/store/index';
import { applyPalette, applyTheme, watchSystemTheme } from '@hq/lib/theme';
import {
  Bell,
  BellRing,
  Columns3,
  Inbox,
  LogOut,
  Mail,
  MessagesSquare,
  Monitor,
  Network,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ScopePicker } from '@/components/scope-picker';
import { useAttentionQueue } from '@/features/attention/use-attention-queue';
import { cn } from '@/lib/cn';
import { SurfaceProvider } from '@/lib/surface';

const TABS = [
  { href: '/mobile/', label: 'Now', icon: Inbox, badge: 'attention' },
  { href: '/mobile/chat/', label: 'Chat', icon: MessagesSquare, badge: null },
  { href: '/mobile/board/', label: 'Board', icon: Columns3, badge: null },
  { href: '/mobile/mail/', label: 'Mail', icon: Mail, badge: 'unread' },
  { href: '/mobile/fleet/', label: 'Fleet', icon: Network, badge: null },
] as const;

function normalize(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

function useAppearance(): void {
  const { theme, palette } = useHqLocalPrefs().appearance;
  useEffect(() => {
    const root = document.documentElement;
    applyTheme(root, theme);
    if (theme !== 'system') return;
    return watchSystemTheme(() => applyTheme(root, theme));
  }, [theme]);
  useEffect(() => applyPalette(document.documentElement, palette), [palette]);
}

/**
 * Installs the offline shell and, once the operator opts in, raises a system
 * notification when the attention count grows while the app is hidden. The
 * notification names a count, never content: lock screens are public.
 */
function usePhoneNotifications(count: number): {
  permission: NotificationPermission | 'unsupported';
  enable: () => void;
} {
  const supported =
    typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator;
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    'unsupported',
  );
  const previous = useRef(count);

  useEffect(() => {
    if (!supported) return;
    setPermission(Notification.permission);
    if (window.isSecureContext) {
      void navigator.serviceWorker.register('/mobile-sw.js', { scope: '/mobile' }).catch(() => {
        // Installation is an enhancement; live HQ stays usable without it.
      });
    }
  }, [supported]);

  useEffect(() => {
    const before = previous.current;
    previous.current = count;
    if (permission !== 'granted' || count <= before || !document.hidden) return;
    void navigator.serviceWorker.ready
      .then((registration) =>
        registration.showNotification('WrongStack HQ needs you', {
          body: `${count} item${count === 1 ? '' : 's'} waiting`,
          icon: '/wrongstack.svg',
          badge: '/wrongstack.svg',
          tag: 'wrongstack-hq-attention',
        }),
      )
      .catch(() => undefined);
  }, [count, permission]);

  return {
    permission,
    enable: () => {
      if (!supported || Notification.permission !== 'default') return;
      void Notification.requestPermission()
        .then(setPermission)
        .catch(() => undefined);
    },
  };
}

export function MobileShell({ children }: { children: ReactNode }): ReactNode {
  const authRequired = useHqStore((state) => state.authRequired);
  useAppearance();
  useEffect(() => {
    document.title = 'WrongStack HQ Mobile';
  }, []);
  if (authRequired) return <TokenGate hadToken={resolveHqToken() !== null} passwordOnly />;
  return (
    <SurfaceProvider surface="mobile">
      <SignedInShell>{children}</SignedInShell>
    </SurfaceProvider>
  );
}

function SignedInShell({ children }: { children: ReactNode }): ReactNode {
  const pathname = normalize(usePathname());
  const connected = useHqStore((state) => state.connected);
  const unread = useHqStore((state) => unreadMailboxCount(state.snapshot));
  // Badges and phone notifications count the whole fleet, whatever the scope:
  // narrowing the view must never hide what needs the operator.
  const { items, outside } = useAttentionQueue();
  const attention = items.length + outside.length;
  const notifications = usePhoneNotifications(attention + Number(unread > 0));
  const counts = { attention, unread };

  const logout = async (): Promise<void> => {
    try {
      await authorizedFetch('/api/logout', { method: 'POST' });
    } finally {
      clearHqToken();
      window.location.reload();
    }
  };

  return (
    <>
      <div data-testid="hq-mobile" className="flex h-dvh flex-col bg-background">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <img src="/wrongstack.svg" alt="" aria-hidden="true" className="size-5" />
          <span className="font-display text-base font-semibold">HQ</span>
          <span
            className={cn(
              'flex items-center gap-1.5 text-xs',
              connected ? 'text-success' : 'text-warning',
            )}
            aria-live="polite"
          >
            <span className={cn('size-2', connected ? 'bg-success' : 'animate-pulse bg-warning')} />
            {connected ? 'Live' : 'Reconnecting'}
          </span>
          <span className="ml-auto flex items-center gap-1">
            {notifications.permission === 'default' && (
              <button
                type="button"
                onClick={notifications.enable}
                className="grid size-10 place-items-center text-muted-foreground hover:text-foreground"
                aria-label="Notify me when something needs me"
              >
                <Bell className="size-5" />
              </button>
            )}
            {notifications.permission === 'granted' && (
              <span
                className="grid size-10 place-items-center text-muted-foreground"
                title="Notifications on"
              >
                <BellRing className="size-5" aria-label="Notifications on" />
              </span>
            )}
            <a
              href="/"
              className="grid size-10 place-items-center text-muted-foreground hover:text-foreground"
              aria-label="Open the desktop dashboard"
            >
              <Monitor className="size-5" />
            </a>
            <button
              type="button"
              onClick={() => void logout()}
              className="grid size-10 place-items-center text-muted-foreground hover:text-foreground"
              aria-label="Sign out"
            >
              <LogOut className="size-5" />
            </button>
          </span>
        </header>
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
          <span>Showing</span>
          <ScopePicker outside={outside.length} compact />
        </div>
        <ConnectionBanner />
        <PeerLifecycleBanner />
        <main id="hq-main" className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>
        <nav
          aria-label="Sections"
          className="grid shrink-0 grid-cols-5 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]"
        >
          {TABS.map((tab) => {
            // Fleet holds two lists; its tab stays lit on both.
            const active =
              pathname === tab.href ||
              (tab.href === '/mobile/fleet/' && pathname.startsWith(tab.href));
            const count = tab.badge === null ? 0 : counts[tab.badge];
            const Icon = tab.icon;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex h-16 flex-col items-center justify-center gap-1 text-xs',
                  active ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {active && <span className="absolute inset-x-6 top-0 h-0.5 bg-primary" />}
                <Icon className="size-5" />
                {tab.label}
                {count > 0 && (
                  <span className="tabular absolute right-[calc(50%-1.5rem)] top-2 min-w-5 bg-primary px-1 text-center text-[11px] font-semibold text-primary-foreground">
                    {count}
                    <span className="sr-only"> waiting</span>
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>
      <ToastOverlay />
    </>
  );
}
