/**
 * Client ("machine") tokens from the dashboard — the step that used to need a
 * shell on the HQ host (`wstack hq token create --client`).
 *
 *   GET    /api/machine-tokens        list client tokens (never the secret)
 *   POST   /api/machine-tokens        mint one; the secret is returned ONCE
 *   DELETE /api/machine-tokens/:id    revoke; its sockets close on the next sweep
 *
 * All three need an admin credential (`auth.admin`), even in open mode: a
 * client token lets a machine publish into this HQ (and, with
 * `control.execute`, run shell commands HQ sends it). An admin credential
 * means browser auth is on, so client tokens are already required — minting
 * one never changes who may connect.
 *
 * Every mint and revoke is written to the auth audit log, like the CLI's.
 */
import type * as http from 'node:http';
import {
  hqAuthContentHash,
  logHqAuthAudit,
  mintHqToken,
  mutateHqAuthFile,
  readHqAuthFile,
} from '@wrongstack/hq';
import { authenticateBrowserRequest, hqAuthRequired } from '../auth.js';
import type { HqRouterMutableAuth, HqSessionEntry } from '../types.js';
import { readRequestBody, writeInvalidBody } from '../utils.js';
import { requireAdminCredential } from './auth/common.js';
import type { ApplyHqAuthFile } from './auth-handlers.js';

const TTL_DAYS_MAX = 3650;
const DEFAULT_TTL_DAYS = 90;

export interface MachineTokenDeps {
  mutableAuth: HqRouterMutableAuth;
  sessions: Map<string, HqSessionEntry>;
  dataDir: string;
  applyAuthFile: ApplyHqAuthFile;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** True when the request was routed here. */
export async function handleApiMachineTokens(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: MachineTokenDeps,
): Promise<boolean> {
  const listPath = url.pathname === '/api/machine-tokens';
  const one = url.pathname.match(/^\/api\/machine-tokens\/([0-9a-f-]{8,64})$/);
  if (!listPath && !one) return false;

  const auth = authenticateBrowserRequest(req, url, deps.mutableAuth, deps.sessions);
  if (hqAuthRequired(deps.mutableAuth) && !auth) {
    writeJson(res, 401, { error: 'unauthorized' });
    return true;
  }
  if (!requireAdminCredential(res, auth) || auth === undefined) return true;
  const actor =
    auth.kind === 'token'
      ? `hq-dashboard:token:${auth.id}`
      : `hq-dashboard:session${auth.tokenId ? `:token:${auth.tokenId}` : ''}`;
  const audit = async (entry: {
    kind: 'create' | 'revoke';
    tokenId: string;
    label?: string | undefined;
    capabilities?: readonly string[] | undefined;
    expiresAt?: string | undefined;
  }): Promise<void> => {
    const file = await readHqAuthFile(deps.dataDir).catch(() => undefined);
    const hash = file === undefined ? undefined : hqAuthContentHash(file);
    logHqAuthAudit(deps.dataDir, {
      kind: entry.kind,
      scope: 'client',
      tokenId: entry.tokenId,
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.capabilities ? { capabilities: [...entry.capabilities] } : {}),
      ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
      actor,
      ...(hash !== undefined ? { contentHash: hash } : {}),
    });
  };

  if (listPath && req.method === 'GET') {
    const now = Date.now();
    const file = await readHqAuthFile(deps.dataDir);
    writeJson(res, 200, {
      tokenMode: deps.mutableAuth.clientTokens.size > 0 || hqAuthRequired(deps.mutableAuth),
      tokens: (file.clientTokens ?? []).map((token) => ({
        id: token.id,
        ...(token.label ? { label: token.label } : {}),
        createdAt: token.createdAt,
        ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
        ...(token.lastUsedAt ? { lastUsedAt: token.lastUsedAt } : {}),
        capabilities: token.capabilities ?? null,
        expired: token.expiresAt !== undefined && Date.parse(token.expiresAt) <= now,
      })),
    });
    return true;
  }

  if (listPath && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readRequestBody(req));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        writeJson(res, 400, { error: 'expected a JSON object' });
        return true;
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      writeInvalidBody(res, error);
      return true;
    }
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';
    if (label === '') {
      writeJson(res, 400, { error: 'Name the machine the token is for.' });
      return true;
    }
    const ttlDays = body.ttlDays === undefined ? DEFAULT_TTL_DAYS : body.ttlDays;
    if (
      typeof ttlDays !== 'number' ||
      !Number.isInteger(ttlDays) ||
      ttlDays < 0 ||
      ttlDays > TTL_DAYS_MAX
    ) {
      writeJson(res, 400, {
        error: `ttlDays must be a whole number from 0 (never) to ${TTL_DAYS_MAX}.`,
      });
      return true;
    }
    const capabilities = [
      'telemetry.publish',
      ...(body.allowShell === true ? ['control.execute'] : []),
    ];
    const token = {
      ...mintHqToken({ label, ...(ttlDays > 0 ? { ttlMs: ttlDays * 86_400_000 } : {}) }),
      capabilities,
    };
    const next = await mutateHqAuthFile(deps.dataDir, (current) => ({
      ...current,
      clientTokens: [...(current.clientTokens ?? []), token],
    }));
    deps.applyAuthFile(next);
    await audit({
      kind: 'create',
      tokenId: token.id,
      label,
      capabilities,
      expiresAt: token.expiresAt,
    });
    writeJson(res, 200, {
      id: token.id,
      label,
      token: token.token,
      capabilities,
      ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
    });
    return true;
  }

  if (one && req.method === 'DELETE') {
    const id = one[1]!;
    let revoked: { id: string; label?: string; capabilities?: readonly string[] } | undefined;
    const next = await mutateHqAuthFile(deps.dataDir, (current) => {
      const tokens = current.clientTokens ?? [];
      revoked = tokens.find((token) => token.id === id);
      return revoked === undefined
        ? current
        : { ...current, clientTokens: tokens.filter((token) => token.id !== id) };
    });
    if (revoked === undefined) {
      writeJson(res, 404, { error: 'No client token with that id.' });
      return true;
    }
    deps.applyAuthFile(next);
    await audit({
      kind: 'revoke',
      tokenId: id,
      label: revoked.label,
      capabilities: revoked.capabilities,
    });
    writeJson(res, 200, { revoked: id });
    return true;
  }

  writeJson(res, 405, { error: 'method not allowed' });
  return true;
}
