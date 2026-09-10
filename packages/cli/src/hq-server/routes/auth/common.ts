import type * as http from 'node:http';
import { type HqAuthFile, isLoopbackHost } from '@wrongstack/core/hq';
import { authenticateBrowserRequest, type HqBrowserAuthResult } from '../../auth.js';
import type { LoginAttemptStore } from '../../login-attempt-store.js';
import type { HqRouterMutableAuth, HqSessionEntry } from '../../types.js';

/**
 * Record a failed second-factor confirmation and return the new failure count.
 *
 * Shared by every route that verifies a factor outside `/api/login`
 * (totp/disable, password change). Kept here rather than copied per route: the
 * whole point is that each of those routes feeds the SAME per-IP counter, so a
 * attacker cannot get a fresh budget by switching endpoints.
 */
export function recordVerifyFailure(loginAttempts: LoginAttemptStore, clientIp: string): number {
  const prev = loginAttempts.get(clientIp);
  const count = (prev?.count ?? 0) + 1;
  loginAttempts.recordFailure(clientIp);
  return count;
}

export function isLoopbackRequest(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  return address !== undefined && isLoopbackHost(address);
}

export const HQ_AUTH_ADMIN_CAPABILITY = 'auth.admin';

export function callerCanAdministerAuth(auth: HqBrowserAuthResult): boolean {
  if (auth === undefined) return false;
  // Full desktop password sessions and legacy unrestricted tokens carry no
  // capability list. Mobile password sessions deliberately do, despite also
  // having no tokenId, so capability presence must take precedence over the
  // old "password cookie means admin" shortcut.
  if (auth.capabilities === undefined) return true;
  return auth.capabilities.includes(HQ_AUTH_ADMIN_CAPABILITY);
}

export function writeAuthAdminRequired(res: http.ServerResponse): void {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: {
        code: 'AUTH_ADMIN_REQUIRED',
        message: `This endpoint requires the '${HQ_AUTH_ADMIN_CAPABILITY}' capability.`,
      },
    }),
  );
}

export function authorizeAuthAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
): HqBrowserAuthResult {
  const auth = authenticateBrowserRequest(
    req,
    new URL(req.url ?? '/', 'http://localhost'),
    mutableAuth,
    sessions,
  );
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } }),
    );
    return undefined;
  }
  if (!callerCanAdministerAuth(auth)) {
    writeAuthAdminRequired(res);
    return undefined;
  }
  return auth;
}

export type ApplyHqAuthFile = (next: HqAuthFile) => void;
