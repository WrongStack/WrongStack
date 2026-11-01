'use client';

/**
 * Which surface a screen is rendered in, and where its links lead there.
 *
 * The phone surface lives under `/mobile/` because that is the installed app's
 * scope: a link that leaves it opens the browser instead of staying in the
 * app. Screens are shared between surfaces, so every in-app link goes through
 * `useSurfaceHref`, which maps a desktop route to its phone twin when one
 * exists and leaves it alone when it does not.
 */
import { createContext, type ReactNode, useCallback, useContext } from 'react';
import { type HqSurface, surfaceHref } from './surface-routes';

const SurfaceContext = createContext<HqSurface>('desktop');

export function SurfaceProvider({
  surface,
  children,
}: {
  surface: HqSurface;
  children: ReactNode;
}) {
  return <SurfaceContext.Provider value={surface}>{children}</SurfaceContext.Provider>;
}

export function useSurface(): HqSurface {
  return useContext(SurfaceContext);
}

/** Maps a desktop route (with its query) to the current surface. */
export function useSurfaceHref(): (href: string) => string {
  const surface = useSurface();
  return useCallback((href: string) => surfaceHref(surface, href), [surface]);
}
