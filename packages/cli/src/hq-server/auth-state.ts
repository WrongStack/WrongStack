import type { HqAuthFile, HqSnapshot, HqToken } from '@wrongstack/core/hq';
import {
  DEFAULT_HQ_REDACTION_POLICY,
  hqAuthContentHash,
  hqTokenKey,
  isTokenExpired,
  logHqAuthAudit,
} from '@wrongstack/core/hq';
import type { HqRouterMutableAuth } from './types.js';

const TOKEN_EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;

export interface HqAuthState {
  mutableAuth: HqRouterMutableAuth;
  apply(next: HqAuthFile): void;
  tokenStats(): NonNullable<HqSnapshot['totals']['tokenStats']>;
}

export interface HqAuthStateOptions {
  /**
   * Invoked after every {@link HqAuthState.apply}, with the freshly projected
   * `mutableAuth`. The server wires this to the WS-010 exposure re-assessment
   * so `requireAuthFloor` is re-latched by EVERY path that changes the live
   * credential set — not just the `fs.watch` reload.
   *
   * WS-101: the in-process mutation routes (`DELETE /api/auth/password`, the
   * TOTP endpoints, recovery-code consumption) used to run their own copy of
   * this projection and never touched the floor, so removing the last
   * credential on a non-loopback bind dropped HQ into open mode until the
   * watcher happened to fire. Routing every mutation through `apply` is what
   * makes the latch unconditional.
   */
  onApplied?: ((mutableAuth: HqRouterMutableAuth) => void) | undefined;
}

function liveTokens<T extends { expiresAt?: string }>(list: T[] | undefined): T[] {
  return (list ?? []).filter((token) => !isTokenExpired(token));
}

/**
 * Project an `auth.json` document onto the live `mutableAuth` used by every
 * HQ gate. THE single projection — `HqAuthState.apply` is its only caller and
 * every mutation path goes through that, so there is exactly one place where
 * "which tokens are live" is decided.
 *
 * Expired tokens are dropped from BOTH scopes here. The browser scope is also
 * re-checked at the request boundary (`authenticateBrowserRequest`), but the
 * `/ws/client` upgrade gate is a bare set-membership test, so for client
 * tokens this filter is the only expiry enforcement there is.
 */
export function projectAuthFile(mutableAuth: HqRouterMutableAuth, next: HqAuthFile): void {
  mutableAuth.operatorPolicy = {
    ...DEFAULT_HQ_REDACTION_POLICY,
    ...(next.redactionPolicy ?? {}),
  };
  mutableAuth.operatorPolicyOverride = next.redactionPolicy;
  // WS-011: reload rebuilt the live sets from the raw file without filtering
  // expired entries and without carrying `expiresAt` forward, so an expired
  // token was re-admitted on every reload and could never be re-checked.
  // WS-044: keyed on the verifier, so a hashed file and a legacy cleartext
  // one both authenticate through `hqTokenKey`.
  mutableAuth.browserTokens = new Set(liveTokens(next.browserTokens).map(hqTokenKey));
  mutableAuth.clientTokens = new Set(liveTokens(next.clientTokens).map(hqTokenKey));
  mutableAuth.browserTokenObjs = browserTokenMap(next.browserTokens);
  mutableAuth.clientTokenObjs = new Map(
    liveTokens(next.clientTokens).map((token) => [hqTokenKey(token), token]),
  );
  mutableAuth.passwordHash = next.passwordHash;
  mutableAuth.cookieSecret = next.cookieSecret;
  mutableAuth.totpSecret = next.totpSecret;
  mutableAuth.totpPendingSecret = next.totpPendingSecret;
  mutableAuth.totpRecoveryCodes = next.totpRecoveryCodes;
  mutableAuth.totpLastUsedCounter = next.totpLastUsedCounter;
  mutableAuth.alertRules = next.alertRules;
}

/** Owns the live auth projection, expiry statistics, and reload audit diff. */
export function createHqAuthState(
  authFile: HqAuthFile,
  dataDir: string,
  opts: HqAuthStateOptions = {},
): HqAuthState {
  let rawBrowserTokens: readonly HqToken[] = authFile.browserTokens ?? [];
  let rawClientTokens: readonly HqToken[] = authFile.clientTokens ?? [];
  // Seed the required fields, then let `projectAuthFile` fill every one of
  // them from the file. The initial state used to be a third hand-written copy
  // of the projection; going through the same function means startup and
  // reload can never disagree about which tokens are live.
  const mutableAuth: HqRouterMutableAuth = {
    operatorPolicy: { ...DEFAULT_HQ_REDACTION_POLICY },
    operatorPolicyOverride: undefined,
    browserTokens: new Set(),
    clientTokens: new Set(),
    browserTokenObjs: new Map(),
    clientTokenObjs: new Map(),
    alertRules: undefined,
  };
  projectAuthFile(mutableAuth, authFile);

  return {
    mutableAuth,
    tokenStats: () => {
      const now = Date.now();
      const all = [...rawBrowserTokens, ...rawClientTokens];
      const live = all.filter((token) => !isTokenExpired(token, now));
      return {
        browserTotal: mutableAuth.browserTokens.size,
        clientTotal: mutableAuth.clientTokens.size,
        expired: all.length - live.length,
        expiringSoon: live.filter((token) => {
          if (token.expiresAt === undefined) return false;
          const expiry = Date.parse(token.expiresAt);
          return Number.isFinite(expiry) && expiry - now <= TOKEN_EXPIRY_WARNING_MS;
        }).length,
      };
    },
    apply: (next) => {
      const newBrowser = next.browserTokens ?? [];
      const newClient = next.clientTokens ?? [];
      auditPrunedTokens('browser', rawBrowserTokens, newBrowser, next, dataDir);
      auditPrunedTokens('client', rawClientTokens, newClient, next, dataDir);
      rawBrowserTokens = newBrowser;
      rawClientTokens = newClient;
      projectAuthFile(mutableAuth, next);
      opts.onApplied?.(mutableAuth);
    },
  };
}

function browserTokenMap(tokens: HqToken[] | undefined): HqRouterMutableAuth['browserTokenObjs'] {
  return new Map(
    liveTokens(tokens).map((token) => [
      hqTokenKey(token),
      {
        id: token.id,
        ...(token.capabilities !== undefined ? { capabilities: token.capabilities } : {}),
        ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
      },
    ]),
  );
}

function auditPrunedTokens(
  scope: 'browser' | 'client',
  previous: readonly HqToken[],
  next: readonly HqToken[],
  authFile: HqAuthFile,
  dataDir: string,
): void {
  const previouslyLive = new Set(
    previous.filter((token) => !isTokenExpired(token)).map(({ id }) => id),
  );
  const prunedCount = next.filter(
    (token) => isTokenExpired(token) && previouslyLive.has(token.id),
  ).length;
  if (prunedCount === 0) return;
  const contentHash = hqAuthContentHash(authFile);
  logHqAuthAudit(dataDir, {
    kind: 'expired-prune',
    scope,
    tokenId: '(aggregate)',
    prunedCount,
    ...(contentHash !== undefined ? { contentHash } : {}),
  });
}
