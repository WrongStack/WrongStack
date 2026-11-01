/**
 * Desktop routes and their phone twins. Pure, so it is tested without React.
 *
 * Longest prefix wins; a route with no twin stays a desktop route (it opens
 * outside the installed app, which is the honest place for a full screen).
 */
export type HqSurface = 'desktop' | 'mobile';

export const MOBILE_ROUTES: readonly (readonly [desktop: string, mobile: string])[] = [
  ['/fleet/console/', '/mobile/chat/'],
  ['/fleet/machines/', '/mobile/fleet/'],
  ['/work/mailbox/', '/mobile/mail/'],
  ['/work/', '/mobile/board/'],
  ['/inbox/', '/mobile/'],
  ['/', '/mobile/'],
];

export function surfaceHref(surface: HqSurface, href: string): string {
  if (surface === 'desktop') return href;
  const queryAt = href.search(/[?#]/);
  const path = queryAt === -1 ? href : href.slice(0, queryAt);
  const rest = queryAt === -1 ? '' : href.slice(queryAt);
  const normalized = path.endsWith('/') ? path : `${path}/`;
  for (const [desktop, mobile] of MOBILE_ROUTES) {
    // `/` only maps itself; every other entry maps its whole subtree's root.
    if (desktop === '/' ? normalized === '/' : normalized === desktop) return `${mobile}${rest}`;
  }
  return href;
}
