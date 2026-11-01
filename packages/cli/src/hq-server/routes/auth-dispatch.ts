/**
 * The `/api/auth*`, `/api/login*` and `/api/logout` routes, split out of
 * `routes.ts` (the HQ router) so the router stays one screen of dispatch.
 * Behaviour is unchanged: the router's origin guard and auth gate run first,
 * then this dispatch, which reports whether it handled the request.
 *
 * @module hq-server/routes/auth-dispatch
 */
import type * as http from 'node:http';
import type { HqBootstrapCodeStore } from '@wrongstack/hq';
import { authenticateBrowserRequest } from '../auth.js';
import type { LoginAttemptStore } from '../login-attempt-store.js';
import type { HqRouterMutableAuth, HqSessionEntry } from '../types.js';
import {
  type ApplyHqAuthFile,
  callerCanAdministerAuth,
  handleApiAuthAudit,
  handleApiAuthSessions,
  handleApiAuthSessionsRevoke,
  handleApiAuthStatus,
  handleApiBootstrap,
  handleApiLogin,
  handleApiLoginVerify,
  handleApiLogout,
  handleApiPassword,
  handleApiTokenUpgrade,
  handleApiTotpDisable,
  handleApiTotpEnable,
  handleApiTotpSetup,
} from './auth-handlers.js';

export interface HqAuthDispatchDeps {
  mutableAuth: HqRouterMutableAuth;
  sessions: Map<string, HqSessionEntry>;
  loginAttempts: LoginAttemptStore;
  dataDir: string;
  requireBrowserAuth: boolean | undefined;
  trustedPublicOrigins: Set<string>;
  secureCookies: boolean | undefined;
  trustedProxyHops: number;
  bootstrapStore?: HqBootstrapCodeStore | undefined;
  applyAuthFile: ApplyHqAuthFile;
}

/** True when the request was an auth route (handled or refused). */
export async function dispatchHqAuthRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: HqAuthDispatchDeps,
): Promise<boolean> {
  const {
    mutableAuth,
    sessions,
    loginAttempts,
    dataDir,
    requireBrowserAuth,
    trustedPublicOrigins,
    secureCookies,
    trustedProxyHops,
    bootstrapStore,
    applyAuthFile,
  } = deps;

  if (url.pathname === '/api/auth/status' && req.method === 'GET') {
    await handleApiAuthStatus(
      req,
      res,
      url,
      mutableAuth,
      sessions,
      requireBrowserAuth,
      trustedPublicOrigins,
      secureCookies,
    );
    return true;
  }

  // WS-102: the account-security surface (session list/revoke, auth audit,
  // TOTP enrollment) is gated on `auth.admin`, not merely on "authenticated".
  // The gate above proves a credential; this proves the credential is
  // allowed to change how HQ authenticates.
  if (
    (url.pathname === '/api/auth/audit' && req.method === 'GET') ||
    (url.pathname.startsWith('/api/auth/sessions') &&
      (req.method === 'GET' || req.method === 'DELETE')) ||
    (url.pathname.startsWith('/api/auth/totp/') && req.method === 'POST')
  ) {
    const auth = authenticateBrowserRequest(req, url, mutableAuth, sessions);
    if (auth !== undefined && !callerCanAdministerAuth(auth)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'AUTH_ADMIN_REQUIRED',
            message: "This endpoint requires the 'auth.admin' capability.",
          },
        }),
      );
      return true;
    }
  }

  if (url.pathname === '/api/auth/audit' && req.method === 'GET') {
    handleApiAuthAudit(req, res, dataDir);
    return true;
  }

  if (url.pathname === '/api/auth/sessions' && req.method === 'GET') {
    handleApiAuthSessions(req, res, mutableAuth, sessions);
    return true;
  }

  if (url.pathname.startsWith('/api/auth/sessions') && req.method === 'DELETE') {
    await handleApiAuthSessionsRevoke(req, res, url, sessions);
    return true;
  }

  if (
    (url.pathname === '/api/login' || url.pathname === '/api/mobile/login') &&
    req.method === 'POST'
  ) {
    await handleApiLogin(
      req,
      res,
      mutableAuth,
      sessions,
      loginAttempts,
      secureCookies,
      trustedProxyHops,
      dataDir,
      // Least privilege for the phone: send and steer, plus ONE-SHOT
      // answers to pending prompts (see `credentialMayAnswer`) — never
      // persistent approval policy, never account administration.
      url.pathname === '/api/mobile/login'
        ? ['control.enqueue', 'control.approve.once']
        : undefined,
    );
    return true;
  }

  if (url.pathname === '/api/auth/bootstrap' && req.method === 'POST') {
    if (bootstrapStore) {
      await handleApiBootstrap(req, res, mutableAuth, sessions, secureCookies, bootstrapStore);
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'BOOTSTRAP_UNAVAILABLE',
            message: 'Bootstrap exchange is not enabled on this HQ server.',
          },
        }),
      );
    }
    return true;
  }

  // WS-065: deliberately NOT in the gate's exemption list above — the gate
  // authenticating the Bearer token is exactly the proof this route needs.
  if (url.pathname === '/api/auth/upgrade' && req.method === 'POST') {
    await handleApiTokenUpgrade(req, res, url, mutableAuth, sessions, secureCookies);
    return true;
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    await handleApiLogout(req, res, mutableAuth, sessions, secureCookies);
    return true;
  }

  if (
    (url.pathname === '/api/login/verify' || url.pathname === '/api/mobile/login/verify') &&
    req.method === 'POST'
  ) {
    await handleApiLoginVerify(
      req,
      res,
      url,
      mutableAuth,
      sessions,
      loginAttempts,
      dataDir,
      secureCookies,
      applyAuthFile,
      trustedProxyHops,
    );
    return true;
  }

  if (url.pathname === '/api/auth/totp/setup' && req.method === 'POST') {
    await handleApiTotpSetup(req, res, mutableAuth, sessions, dataDir, applyAuthFile);
    return true;
  }

  if (url.pathname === '/api/auth/totp/enable' && req.method === 'POST') {
    await handleApiTotpEnable(req, res, mutableAuth, sessions, dataDir, applyAuthFile);
    return true;
  }

  if (url.pathname === '/api/auth/totp/disable' && req.method === 'POST') {
    await handleApiTotpDisable(
      req,
      res,
      mutableAuth,
      sessions,
      loginAttempts,
      dataDir,
      applyAuthFile,
      trustedProxyHops,
    );
    return true;
  }

  if (url.pathname === '/api/auth/password' && (req.method === 'POST' || req.method === 'DELETE')) {
    await handleApiPassword(
      req,
      res,
      mutableAuth,
      sessions,
      dataDir,
      secureCookies,
      requireBrowserAuth,
      applyAuthFile,
      loginAttempts,
      trustedProxyHops,
    );
    return true;
  }

  return false;
}
