/**
 * `/api/notify*` — notification channels (webhook, Slack, Discord, ntfy).
 *
 * Gated on `auth.admin`, like the account-security routes: a channel decides
 * where fleet information leaves the machine, and its URL is a credential.
 * Responses carry only masked URLs.
 *
 *   GET    /api/notify                     settings + channels (masked)
 *   PUT    /api/notify/settings            { publicUrl?, approvalDelaySeconds? }
 *   POST   /api/notify/channels            add a channel
 *   PATCH  /api/notify/channels/:id        change a channel (URL optional)
 *   DELETE /api/notify/channels/:id        remove a channel
 *   POST   /api/notify/channels/:id/test   send a test message
 */
import type * as http from 'node:http';
import type { HqNotifier, HqNotifyMutation } from '@wrongstack/hq';
import { authenticateBrowserRequest, hqAuthRequired } from '../auth.js';
import type { HqRouterMutableAuth, HqSessionEntry } from '../types.js';
import { readRequestBody, writeInvalidBody } from '../utils.js';
import { requireAdminCredential } from './auth/common.js';

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function writeOutcome<T>(res: http.ServerResponse, outcome: HqNotifyMutation<T>): void {
  if (outcome.ok) writeJson(res, 200, outcome.value);
  else writeJson(res, outcome.status, { error: outcome.error });
}

/** True when the request was routed here (handled or refused). */
export async function handleApiNotify(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: {
    notifier: HqNotifier;
    mutableAuth: HqRouterMutableAuth;
    sessions: Map<string, HqSessionEntry>;
  },
): Promise<boolean> {
  const { pathname } = url;
  if (pathname !== '/api/notify' && !pathname.startsWith('/api/notify/')) return false;

  const auth = authenticateBrowserRequest(req, url, deps.mutableAuth, deps.sessions);
  if (hqAuthRequired(deps.mutableAuth) && !auth) {
    writeJson(res, 401, { error: 'unauthorized' });
    return true;
  }
  if (!requireAdminCredential(res, auth)) return true;

  const readBody = async (): Promise<Record<string, unknown> | null> => {
    try {
      const parsed: unknown = JSON.parse(await readRequestBody(req));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        writeJson(res, 400, { error: 'expected a JSON object' });
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      writeInvalidBody(res, error);
      return null;
    }
  };

  const { notifier } = deps;
  if (pathname === '/api/notify' && req.method === 'GET') {
    writeJson(res, 200, notifier.view());
    return true;
  }
  if (pathname === '/api/notify/settings' && req.method === 'PUT') {
    const body = await readBody();
    if (body !== null) writeOutcome(res, await notifier.updateSettings(body));
    return true;
  }
  if (pathname === '/api/notify/channels' && req.method === 'POST') {
    const body = await readBody();
    if (body !== null) writeOutcome(res, await notifier.addChannel(body));
    return true;
  }
  const match = pathname.match(/^\/api\/notify\/channels\/([a-z0-9-]{1,40})(\/test)?$/);
  if (match) {
    const id = match[1]!;
    if (match[2] === '/test' && req.method === 'POST') {
      writeOutcome(res, await notifier.test(id));
      return true;
    }
    if (match[2] === undefined && req.method === 'PATCH') {
      const body = await readBody();
      if (body !== null) writeOutcome(res, await notifier.updateChannel(id, body));
      return true;
    }
    if (match[2] === undefined && req.method === 'DELETE') {
      writeOutcome(res, await notifier.removeChannel(id));
      return true;
    }
  }
  writeJson(res, 404, { error: 'not found' });
  return true;
}
