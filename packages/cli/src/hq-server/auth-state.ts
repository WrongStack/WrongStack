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

function liveTokens<T extends { expiresAt?: string }>(list: T[] | undefined): T[] {
  return (list ?? []).filter((token) => !isTokenExpired(token));
}

/** Owns the live auth projection, expiry statistics, and reload audit diff. */
export function createHqAuthState(authFile: HqAuthFile, dataDir: string): HqAuthState {
  let rawBrowserTokens: readonly HqToken[] = authFile.browserTokens ?? [];
  let rawClientTokens: readonly HqToken[] = authFile.clientTokens ?? [];
  const mutableAuth: HqRouterMutableAuth = {
    operatorPolicy: { ...DEFAULT_HQ_REDACTION_POLICY, ...(authFile.redactionPolicy ?? {}) },
    operatorPolicyOverride: authFile.redactionPolicy,
    browserTokens: new Set(liveTokens(authFile.browserTokens).map(hqTokenKey)),
    clientTokens: new Set(liveTokens(authFile.clientTokens).map(hqTokenKey)),
    browserTokenObjs: browserTokenMap(authFile.browserTokens),
    clientTokenObjs: new Map(
      liveTokens(authFile.clientTokens).map((token) => [hqTokenKey(token), token]),
    ),
    passwordHash: authFile.passwordHash,
    cookieSecret: authFile.cookieSecret,
    alertRules: authFile.alertRules,
  };

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
      mutableAuth.operatorPolicy = {
        ...DEFAULT_HQ_REDACTION_POLICY,
        ...(next.redactionPolicy ?? {}),
      };
      mutableAuth.operatorPolicyOverride = next.redactionPolicy;
      mutableAuth.browserTokens = new Set(liveTokens(next.browserTokens).map(hqTokenKey));
      mutableAuth.clientTokens = new Set(liveTokens(next.clientTokens).map(hqTokenKey));
      mutableAuth.browserTokenObjs = browserTokenMap(next.browserTokens);
      mutableAuth.clientTokenObjs = new Map(
        liveTokens(next.clientTokens).map((token) => [hqTokenKey(token), token]),
      );
      mutableAuth.passwordHash = next.passwordHash;
      mutableAuth.cookieSecret = next.cookieSecret;
      mutableAuth.alertRules = next.alertRules;
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
