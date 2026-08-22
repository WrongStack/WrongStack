import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';
import { mutateHqAuthFile, verifyHqPassword } from '@wrongstack/core/hq';
import {
  buildOtpAuthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyRecoveryCode,
  verifyTotp,
  verifyTotpCounter,
} from '@wrongstack/core/security';
import {
  parseHqSessionCookie,
  readHqSessionCookie,
  serializeHqSessionCookie,
  setHqSessionCookie,
} from '../../auth.js';
import { resolveClientAddress } from '../../client-address.js';
import type { LoginAttemptStore } from '../../login-attempt-store.js';
import type { HqRouterMutableAuth, HqSessionEntry } from '../../types.js';
import { readRequestBody } from '../../utils.js';
import { type ApplyHqAuthFile, authorizeAuthAdmin } from './common.js';

const PENDING_2FA_TTL_MS = 5 * 60_000;
let recoveryCodeLock: Promise<void> = Promise.resolve();
const MAX_2FA_VERIFY_FAILURES = 5;

function recordVerifyFailure(loginAttempts: LoginAttemptStore, clientIp: string): number {
  const prev = loginAttempts.get(clientIp);
  const count = (prev?.count ?? 0) + 1;
  loginAttempts.recordFailure(clientIp);
  return count;
}

export async function handleApiLoginVerify(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _url: URL,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  loginAttempts: LoginAttemptStore,
  dataDir: string,
  secureCookies: boolean | undefined,
  applyAuthFile: ApplyHqAuthFile,
  trustedProxyHops: number,
): Promise<void> {
  if (!mutableAuth.cookieSecret) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NO_COOKIE_SECRET' } }));
    return;
  }

  const clientIp = resolveClientAddress(req, trustedProxyHops);
  const { blocked, retryAfter } = loginAttempts.checkBlocked(clientIp);
  if (blocked) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
    res.end(
      JSON.stringify({
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' },
      }),
    );
    return;
  }

  const raw = readHqSessionCookie(req.headers.cookie);
  const sessionId = raw ? parseHqSessionCookie(raw, mutableAuth.cookieSecret) : undefined;
  if (!sessionId) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'NO_PENDING_SESSION', message: 'No pending 2FA session.' } }),
    );
    return;
  }
  const session = sessions.get(sessionId);
  if (!session?.pending2fa) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { code: 'NO_PENDING_SESSION', message: 'Session is not pending 2FA.' },
      }),
    );
    return;
  }
  if (Date.now() - session.createdAt > PENDING_2FA_TTL_MS) {
    sessions.delete(sessionId);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { code: 'TOTP_EXPIRED', message: '2FA session expired. Please log in again.' },
      }),
    );
    return;
  }

  let body: { code?: unknown; recoveryCode?: unknown };
  try {
    body = JSON.parse(await readRequestBody(req)) as typeof body;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' } }));
    return;
  }

  if (typeof body.code === 'string' && body.code.length > 0) {
    if (!mutableAuth.totpSecret) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: { code: 'TOTP_NOT_ENABLED', message: '2FA is not configured.' } }),
      );
      return;
    }
    const matchedCounter = verifyTotpCounter(body.code, mutableAuth.totpSecret);
    const replayed =
      matchedCounter !== undefined &&
      mutableAuth.totpLastUsedCounter !== undefined &&
      matchedCounter <= mutableAuth.totpLastUsedCounter;
    if (matchedCounter === undefined || replayed) {
      if (recordVerifyFailure(loginAttempts, clientIp) >= MAX_2FA_VERIFY_FAILURES) {
        sessions.delete(sessionId);
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: replayed ? 'TOTP_ALREADY_USED' : 'INVALID_TOTP',
            message: replayed
              ? 'That authenticator code has already been used. Wait for the next one.'
              : 'Invalid authenticator code.',
          },
        }),
      );
      return;
    }
    mutableAuth.totpLastUsedCounter = matchedCounter;
    try {
      const next = await mutateHqAuthFile(dataDir, (current) => ({
        ...current,
        totpLastUsedCounter: matchedCounter,
      }));
      applyAuthFile(next);
    } catch {
      // Best-effort write — mutableAuth already updated in memory
    }
    loginAttempts.clearOnSuccess(clientIp);
    sessions.delete(sessionId);
    const fullSessionId = randomUUID();
    sessions.set(fullSessionId, {
      createdAt: Date.now(),
      kind: 'password',
      lastSeenAt: Date.now(),
    });
    setHqSessionCookie(
      res,
      serializeHqSessionCookie(fullSessionId, mutableAuth.cookieSecret),
      secureCookies,
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ loggedIn: true }));
    return;
  }

  if (typeof body.recoveryCode === 'string' && body.recoveryCode.length > 0) {
    const usedHash = hashRecoveryCode(body.recoveryCode);
    const storedHashes = mutableAuth.totpRecoveryCodes ?? [];
    if (storedHashes.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'NO_RECOVERY_CODES', message: 'No recovery codes available.' },
        }),
      );
      return;
    }
    if (!verifyRecoveryCode(body.recoveryCode, storedHashes)) {
      if (recordVerifyFailure(loginAttempts, clientIp) >= MAX_2FA_VERIFY_FAILURES) {
        sessions.delete(sessionId);
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'INVALID_RECOVERY_CODE', message: 'Invalid recovery code.' },
        }),
      );
      return;
    }
    let consumed = false;
    let remainingCount = 0;
    await recoveryCodeLock;
    let releaseLock: () => void = () => {};
    recoveryCodeLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    try {
      const next = await mutateHqAuthFile(dataDir, (current) => {
        const diskHashes = current.totpRecoveryCodes ?? [];
        const idx = diskHashes.indexOf(usedHash);
        if (idx === -1) {
          consumed = false;
          remainingCount = diskHashes.length;
          return current;
        }
        consumed = true;
        const remaining = diskHashes.filter((_, i) => i !== idx);
        remainingCount = remaining.length;
        return { ...current, totpRecoveryCodes: remaining };
      });
      if (!consumed) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'RECOVERY_CODE_ALREADY_USED',
              message: 'This recovery code has already been used.',
            },
          }),
        );
        return;
      }
      applyAuthFile(next);
    } finally {
      releaseLock();
    }
    loginAttempts.clearOnSuccess(clientIp);
    sessions.delete(sessionId);
    const fullSessionId = randomUUID();
    sessions.set(fullSessionId, {
      createdAt: Date.now(),
      kind: 'password',
      lastSeenAt: Date.now(),
    });
    setHqSessionCookie(
      res,
      serializeHqSessionCookie(fullSessionId, mutableAuth.cookieSecret),
      secureCookies,
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ loggedIn: true, recoveryCodesRemaining: remainingCount }));
    return;
  }

  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: { code: 'BAD_REQUEST', message: 'Provide a `code` or `recoveryCode`.' },
    }),
  );
}

export async function handleApiTotpSetup(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  dataDir: string,
  applyAuthFile: ApplyHqAuthFile,
): Promise<void> {
  if (!authorizeAuthAdmin(req, res, mutableAuth, sessions)) return;

  if (mutableAuth.totpSecret) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'TOTP_ALREADY_ENABLED',
          message: '2FA is already active. Disable it first to re-enroll.',
        },
      }),
    );
    return;
  }

  const secret = generateTotpSecret();
  const uri = buildOtpAuthUri(secret, 'HQ');

  const next = await mutateHqAuthFile(dataDir, (current) => ({
    ...current,
    totpPendingSecret: secret,
  }));
  applyAuthFile(next);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ secret, uri, enabled: false }));
}

export async function handleApiTotpEnable(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  dataDir: string,
  applyAuthFile: ApplyHqAuthFile,
): Promise<void> {
  if (!authorizeAuthAdmin(req, res, mutableAuth, sessions)) return;

  if (mutableAuth.totpSecret) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { code: 'TOTP_ALREADY_ENABLED', message: '2FA is already active.' },
      }),
    );
    return;
  }

  const pendingSecret = mutableAuth.totpPendingSecret;
  if (!pendingSecret) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { code: 'TOTP_NOT_SETUP', message: 'Call /api/auth/totp/setup first.' },
      }),
    );
    return;
  }

  let body: { code?: unknown };
  try {
    body = JSON.parse(await readRequestBody(req)) as typeof body;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' } }));
    return;
  }

  if (typeof body.code !== 'string' || body.code.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'code is required.' } }));
    return;
  }

  if (!verifyTotp(body.code, pendingSecret)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'INVALID_TOTP', message: 'Invalid authenticator code.' } }),
    );
    return;
  }

  const recoveryCodes = generateRecoveryCodes();
  const recoveryHashes = recoveryCodes.map(hashRecoveryCode);

  const next = await mutateHqAuthFile(dataDir, (current) => {
    const updated = { ...current };
    updated.totpSecret = pendingSecret;
    delete updated.totpPendingSecret;
    updated.totpRecoveryCodes = recoveryHashes;
    return updated;
  });
  applyAuthFile(next);

  sessions.clear();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ enabled: true, recoveryCodes }));
}

export async function handleApiTotpDisable(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  loginAttempts: LoginAttemptStore,
  dataDir: string,
  applyAuthFile: ApplyHqAuthFile,
  trustedProxyHops: number,
): Promise<void> {
  if (!authorizeAuthAdmin(req, res, mutableAuth, sessions)) return;

  const clientIp = resolveClientAddress(req, trustedProxyHops);
  const { blocked, retryAfter } = loginAttempts.checkBlocked(clientIp);
  if (blocked) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
    res.end(
      JSON.stringify({
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' },
      }),
    );
    return;
  }

  let body: { password?: unknown; code?: unknown };
  try {
    body = JSON.parse(await readRequestBody(req)) as typeof body;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' } }));
    return;
  }

  let confirmed = false;
  if (typeof body.password === 'string' && body.password.length > 0 && mutableAuth.passwordHash) {
    confirmed = await verifyHqPassword(body.password, mutableAuth.passwordHash);
  }
  if (!confirmed && typeof body.code === 'string' && mutableAuth.totpSecret) {
    confirmed = verifyTotp(body.code, mutableAuth.totpSecret);
  }
  if (!confirmed) {
    recordVerifyFailure(loginAttempts, clientIp);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: 'Provide the current password or a TOTP code.',
        },
      }),
    );
    return;
  }

  loginAttempts.delete(clientIp);
  const next = await mutateHqAuthFile(dataDir, (current) => {
    const updated = { ...current };
    delete updated.totpSecret;
    delete updated.totpPendingSecret;
    delete updated.totpRecoveryCodes;
    return updated;
  });
  applyAuthFile(next);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ enabled: false }));
}
