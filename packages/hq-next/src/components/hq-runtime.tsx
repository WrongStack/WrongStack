'use client';

/**
 * Browser boot for both HQ surfaces.
 *
 * The order is the same contract the Vite entry kept, and it matters:
 *  1. consume a one-time `#bootstrap=` code (it mints this tab's cookie), so
 *     it must run before any socket opens;
 *  2. scrub `?token=` from the address bar;
 *  3. mint a cookie for a stored token, then ask the server whether this
 *     browser is signed in — password-only visitors stop at the gate without
 *     producing guaranteed 401 noise;
 *  4. connect the data plane only when authenticated.
 *
 * Boot runs once per page load, not once per mount: StrictMode and route
 * changes must not open a second socket or replay a consumed bootstrap code.
 */
import {
  exchangeBootstrapIfNeeded,
  hasAuthenticatedHqBrowserSession,
  scrubTokenFromUrl,
  upgradeStoredTokenToCookie,
} from '@hq/data/auth/index';
import { useHqStore } from '@hq/data/store/index';
import { connectHqDataPlane } from '@hq/data/wire';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

export type HqSurface = 'desktop' | 'mobile';

let boot: Promise<void> | null = null;

function bootOnce(surface: HqSurface): Promise<void> {
  boot ??= (async () => {
    await exchangeBootstrapIfNeeded().catch(() => undefined);
    scrubTokenFromUrl();
    await upgradeStoredTokenToCookie();
    const authenticated = await hasAuthenticatedHqBrowserSession({
      passwordOnly: surface === 'mobile',
    });
    if (authenticated) connectHqDataPlane();
    else useHqStore.getState().markAuthRequired();
  })();
  return boot;
}

export function HqRuntime({
  surface,
  children,
}: {
  surface: HqSurface;
  children: ReactNode;
}): ReactNode {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void bootOnce(surface).finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [surface]);

  if (!ready) {
    return (
      <div className="grid h-full place-items-center" aria-busy="true">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="size-2 animate-pulse bg-primary" />
          Connecting to HQ…
        </div>
      </div>
    );
  }
  return children;
}
