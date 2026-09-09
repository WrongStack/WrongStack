/** Mobile HQ is a separate surface mounted below the shared HQ origin. */
export function isHqMobilePath(pathname: string): boolean {
  return pathname === '/mobile' || pathname.startsWith('/mobile/');
}
