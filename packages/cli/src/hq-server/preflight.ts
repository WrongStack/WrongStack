import {
  assessHqExposure,
  type EnsureHqFirstRunAuthResult,
  ensureHqFirstRunAuthFile,
  HqInsecureExposureError,
  isTokenExpired,
  resolveHqDataDir,
} from '@wrongstack/core/hq';
import { resolveAuditActor } from './audit-actor.js';

interface HqPreflightOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  password?: string;
  tokenTtlMs?: number;
  requireBrowserAuth?: boolean;
  allowInsecureOpen?: boolean;
}

interface HqPreflightResult {
  host: string;
  port: number;
  dataDir: string;
  firstRunAuth: EnsureHqFirstRunAuthResult;
}

/** Resolves startup inputs and enforces exposure/auth policy before binding a socket. */
export async function prepareHqServerStart(
  options: HqPreflightOptions,
  defaults: { host: string; port: number },
): Promise<HqPreflightResult> {
  const host = options.host ?? defaults.host;
  const port = options.port ?? defaults.port;
  const dataDir = resolveHqDataDir(options.dataDir);
  const firstRunAuth = await ensureHqFirstRunAuthFile(dataDir, {
    warn: (message) =>
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'hq.auth_load_failed',
          message,
          timestamp: new Date().toISOString(),
        }),
      ),
    actor: resolveAuditActor(),
    ...(options.password !== undefined ? { password: options.password } : {}),
    ...(options.tokenTtlMs !== undefined ? { tokenTtlMs: options.tokenTtlMs } : {}),
  });
  const { authFile } = firstRunAuth;

  // Count only LIVE tokens. This used to read `browserTokens.length` straight
  // from the file while the runtime built its usable set through liveTokens(),
  // which drops expired entries. The two disagreed in exactly one direction: an
  // auth file whose tokens had all expired satisfied the exposure check here,
  // so HQ bound the wildcard host, and then presented `browserTokens.size === 0`
  // to the router — which read that as "no auth configured" and skipped the
  // /api/* gate entirely. Enabling token TTL rotation, the more careful
  // configuration, was the trigger (WS-078).
  const rawBrowserTokens = authFile.browserTokens ?? [];
  const liveBrowserTokens = rawBrowserTokens.filter((token) => !isTokenExpired(token));
  const hasPassword = authFile.passwordHash !== undefined;
  const allTokensExpired = rawBrowserTokens.length > 0 && liveBrowserTokens.length === 0;

  if (options.requireBrowserAuth && liveBrowserTokens.length === 0 && !hasPassword) {
    throw new HqInsecureExposureError(
      allTokensExpired
        ? `HQ public relay requires browser authentication, but all ${rawBrowserTokens.length} browser token(s) in the auth file have expired. Create a fresh token or set --password.`
        : 'HQ public relay requires browser authentication. Set --password or create a browser token first.',
    );
  }
  const exposure = assessHqExposure({
    host,
    hasBrowserTokens: liveBrowserTokens.length > 0,
    hasPassword,
    allowInsecure: options.allowInsecureOpen,
  });
  if (exposure.kind === 'refuse') {
    // Without this the operator sees "no browser tokens" while looking at an
    // auth file that visibly contains some.
    throw new HqInsecureExposureError(
      allTokensExpired
        ? `${exposure.message} (all ${rawBrowserTokens.length} browser token(s) in the auth file have expired)`
        : exposure.message,
    );
  }
  if (exposure.kind === 'warn') {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'hq.insecure_exposure',
        message: exposure.message,
        host,
        timestamp: new Date().toISOString(),
      }),
    );
  }
  return { host, port, dataDir, firstRunAuth };
}
