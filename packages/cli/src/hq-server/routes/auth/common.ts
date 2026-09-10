import type * as http from 'node:http';
import { type HqAuthFile, isLoopbackHost, mutateHqAuthFile } from '@wrongstack/core/hq';
import { verifyTotpCounter } from '@wrongstack/core/security';
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

/** Outcome of {@link consumeTotpCode}. */
export type TotpConsumeResult = 'ok' | 'invalid' | 'replayed';

/**
 * Verify a TOTP code AND burn it, so it cannot be presented a second time.
 *
 * A TOTP code stays valid for its whole time step plus the verification
 * window — roughly 90 seconds. Without a single-use record, one observed code
 * can be replayed at a *different* endpoint for as long as that window lasts.
 * That is not theoretical here: `/api/login/verify` advanced
 * `totpLastUsedCounter` and the other two verification sites
 * (`totp/disable`, `auth/password`) called the counter-less `verifyTotp`, so a
 * code already spent on a login replayed into removing 2FA outright or
 * rotating the password and cookie secret.
 *
 * Kept in this module for the same reason as {@link recordVerifyFailure}: the
 * property only holds if EVERY site that verifies a code shares one counter.
 * A route that verifies a TOTP code by any other means is a bug —
 * `hq-totp-single-use.test.ts` enumerates the call sites to keep it that way.
 *
 * The counter is advanced in memory first and persisted best-effort, matching
 * the pre-existing behaviour at `/api/login/verify`: a failed write must not
 * turn a consumed code back into an unconsumed one for this process.
 */
export async function consumeTotpCode(
  code: string,
  mutableAuth: HqRouterMutableAuth,
  dataDir: string,
  applyAuthFile: ApplyHqAuthFile,
): Promise<TotpConsumeResult> {
  if (!mutableAuth.totpSecret) return 'invalid';
  const matchedCounter = verifyTotpCounter(code, mutableAuth.totpSecret);
  if (matchedCounter === undefined) return 'invalid';
  if (
    mutableAuth.totpLastUsedCounter !== undefined &&
    matchedCounter <= mutableAuth.totpLastUsedCounter
  ) {
    return 'replayed';
  }
  mutableAuth.totpLastUsedCounter = matchedCounter;
  try {
    const next = await mutateHqAuthFile(dataDir, (current) => ({
      ...current,
      totpLastUsedCounter: matchedCounter,
    }));
    applyAuthFile(next);
  } catch {
    // Best-effort write — mutableAuth already updated in memory.
  }
  return 'ok';
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
