import { createContext, useContext } from 'react';

/**
 * Where the shared dialogs mount. Unset means `document.body`, as in the WebUI; an app that
 * applies the surface theme only inside a container provides a portal root within that theme.
 */
export const SurfacePortalContext = createContext<HTMLElement | null>(null);

export function useSurfacePortal(): HTMLElement | undefined {
  return useContext(SurfacePortalContext) ?? undefined;
}
