import type * as http from 'node:http';
import { type HqAuthFile, isLoopbackHost } from '@wrongstack/core/hq';
import { authenticateBrowserRequest, type HqBrowserAuthResult } from '../../auth.js';
import type { HqRouterMutableAuth, HqSessionEntry } from '../../types.js';

export function isLoopbackRequest(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  return address !== undefined && isLoopbackHost(address);
}

export const HQ_AUTH_ADMIN_CAPABILITY = 'auth.admin';

export function callerCanAdministerAuth(auth: HqBrowserAuthResult): boolean {
  if (auth === undefined) return false;
  if (auth.kind === 'cookie' && auth.tokenId === undefined) return true;
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
