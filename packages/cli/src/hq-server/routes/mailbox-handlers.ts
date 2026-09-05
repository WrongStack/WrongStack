import type * as http from 'node:http';
import * as path from 'node:path';
import { type MailboxHttpAccessDecision, resolveProjectDir } from '@wrongstack/core/coordination';
import { authenticateBrowserRequest, hqAuthRequired, isCookieAuth, isTokenAuth } from '../auth.js';
import { resolveHqProjectRoot } from '../project-root.js';
import type { HqRouterMailboxGateway, HqRouterMutableAuth, HqSessionEntry } from '../types.js';
import {
  decodePathSegment,
  readRequestBody,
  sanitizeApiError,
  writeInvalidBody,
} from '../utils.js';

/**
 * Does this authenticated caller hold `control.enqueue`?
 *
 * WS-012: this predicate was inlined at two call sites with a subtly different
 * unauthenticated fallback (`!inBrowserTokenMode` vs
 * `mutableAuth.browserTokens.size === 0` — equivalent, but drifting), and a
 * third route, `POST /api/mailbox/messages/:id/action`, skipped it entirely:
 * its auth parameters were `_`-prefixed to mark them deliberately unused. That
 * left mailbox mutation (mark-read, acknowledge, reopen, soft-delete, restore)
 * reachable by any authenticated caller regardless of capability.
 *
 * One helper so the three cannot diverge again.
 */
export function callerCanEnqueue(
  auth: ReturnType<typeof authenticateBrowserRequest>,
  mutableAuth: HqRouterMutableAuth,
): boolean {
  if (isCookieAuth(auth)) {
    return (
      auth.tokenId === undefined ||
      auth.capabilities === undefined ||
      auth.capabilities.includes('control.enqueue')
    );
  }
  if (isTokenAuth(auth)) {
    return auth.capabilities === undefined || auth.capabilities.includes('control.enqueue');
  }
  // No credential presented at all: only legitimate when HQ genuinely has no
  // auth configured. This previously tested `browserTokens.size === 0` alone,
  // so an all-expired token file or a live revocation (requireAuthFloor) read
  // as "open mode" and this returned true — unauthenticated enqueue into
  // running agents via /api/mailbox-send (WS-077).
  return !hqAuthRequired(mutableAuth);
}

export async function handleMailboxGateway(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
  authorizeMailboxGateway: (
    req: http.IncomingMessage,
    projectDir: string,
  ) => MailboxHttpAccessDecision,
  getMailboxGateway: (projectDir: string) => HqRouterMailboxGateway,
  dataDir: string,
): Promise<void> {
  const projectId = decodePathSegment(match[1]!);
  if (projectId === null || projectId.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'invalid projectId encoding' } }),
    );
    return;
  }
  const gatewayGlobalRoot = path.dirname(dataDir);
  const preliminaryAccess = authorizeMailboxGateway(_req, `project:${projectId}`);
  if (!preliminaryAccess.allowed) {
    res.writeHead(preliminaryAccess.status ?? 401, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(preliminaryAccess.body));
    return;
  }
  const projectRoot = await resolveHqProjectRoot(gatewayGlobalRoot, { projectId });
  if (!projectRoot) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'NOT_FOUND', message: `Unknown project: ${projectId}` } }),
    );
    return;
  }
  const suffix = match[2];
  // Preserve the query string (e.g. `?sinceMs=…`) so the router's
  // `parseSinceMs` sees per-request overrides. Without this the HQ
  // gateway would forward the canonical path without the query and
  // the look-back filter would never engage — a silent contract
  // regression for clients that pass `?sinceMs=…` through HQ.
  const rawUrl = _req.url ?? '';
  const queryIndex = rawUrl.indexOf('?');
  const querySuffix = queryIndex === -1 ? '' : rawUrl.slice(queryIndex);
  const canonicalPath = suffix ? `/mailbox/${suffix}${querySuffix}` : `/mailbox${querySuffix}`;
  const projectDir = resolveProjectDir(projectRoot, gatewayGlobalRoot);
  await getMailboxGateway(projectDir).router.handle(_req, res, canonicalPath);
}

export async function handleApiMailboxSend(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  dataDir: string,
  getMailboxGateway: (projectDir: string) => HqRouterMailboxGateway,
  hqSessionTag: string,
): Promise<void> {
  const auth = authenticateBrowserRequest(
    _req,
    new URL(_req.url ?? '/', 'http://localhost'),
    mutableAuth,
    sessions,
  );
  // This route enqueues a message into a LIVE agent session — a control-plane
  // write. It had no 401 branch at all and leaned entirely on callerCanEnqueue,
  // which returned true whenever the browser-token set was empty. A missing
  // credential and an insufficient capability are distinct failures and must
  // not collapse into one status (WS-077).
  if (hqAuthRequired(mutableAuth) && !auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } }));
    return;
  }
  const canEnqueue = callerCanEnqueue(auth, mutableAuth);
  if (!canEnqueue) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden: token lacks control.enqueue capability' }));
    return;
  }

  let mbody: {
    sessionId?: string;
    projectId?: string;
    type?: string;
    to?: string;
    subject?: string;
    body?: string;
    priority?: string;
    audience?: string;
  };
  try {
    mbody = JSON.parse(await readRequestBody(_req));
  } catch (error) {
    writeInvalidBody(res, error);
    return;
  }
  if (typeof mbody.type !== 'string' || typeof mbody.body !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing type or body' }));
    return;
  }
  if (typeof mbody.sessionId !== 'string' && typeof mbody.projectId !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing sessionId or projectId' }));
    return;
  }
  if (mbody.audience !== undefined && mbody.audience !== 'all' && mbody.audience !== 'leaders') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'audience must be all or leaders' }));
    return;
  }

  const mbGlobalRoot = path.dirname(dataDir);
  const projectRoot = await resolveHqProjectRoot(mbGlobalRoot, {
    sessionId: mbody.sessionId,
    projectId: mbody.projectId,
  });
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'could not resolve target project mailbox' }));
    return;
  }

  const to = typeof mbody.to === 'string' ? mbody.to : 'leader';
  const subject = typeof mbody.subject === 'string' ? mbody.subject : 'HQ prompt';
  const priority = mbody.priority === 'high' ? 'high' : mbody.priority === 'low' ? 'low' : 'normal';
  const audience = mbody.audience === 'leaders' ? 'leaders' : 'all';
  const mailboxType =
    mbody.type === 'queue'
      ? 'note'
      : [
            'note',
            'ask',
            'assign',
            'steer',
            'btw',
            'broadcast',
            'status',
            'result',
            'review',
          ].includes(mbody.type)
        ? (mbody.type as
            | 'note'
            | 'ask'
            | 'assign'
            | 'steer'
            | 'btw'
            | 'broadcast'
            | 'status'
            | 'result'
            | 'review')
        : undefined;
  if (mailboxType === undefined) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'unrecognized or malformed mailbox message',
        type: mbody.type,
      }),
    );
    return;
  }
  if (
    (mailboxType === 'assign' || mailboxType === 'steer') &&
    (to === '*' || to.trim().toLowerCase() === 'all')
  ) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `${mailboxType} requires a specific recipient` }));
    return;
  }

  try {
    const projectDir = resolveProjectDir(projectRoot, mbGlobalRoot);
    const mailbox = getMailboxGateway(projectDir).mailbox;
    const from = `hq@${hqSessionTag}`;
    const deliveryTo = mailboxType === 'broadcast' ? 'all' : to;
    // Session scoping. The bare `leader` alias is answered by EVERY leader in
    // the project (unread state is per reader, so a second terminal on the
    // same project consumes the same message). The caller already named one
    // session — the route only used it to resolve the project root, so the
    // operator's choice was thrown away. Stamping it makes
    // `acceptMailboxMessageForSession` drop the message at every other leader.
    // Only the bare alias is scoped: an explicit `leader@<tag>` or a subagent
    // id already names one agent, and a worker delegated from another tab
    // carries THAT tab's owning session, so stamping it would drop the
    // message at the receiver instead of narrowing it.
    const scopeSessionId =
      typeof mbody.sessionId === 'string' &&
      mbody.sessionId.length > 0 &&
      deliveryTo.trim().toLowerCase() === 'leader'
        ? mbody.sessionId
        : undefined;
    const sent = await mailbox.send({
      from,
      to: deliveryTo,
      type: mailboxType,
      subject,
      body: mbody.body,
      priority,
      audience,
      ...(scopeSessionId !== undefined ? { sessionAffinity: { sessionId: scopeSessionId } } : {}),
    });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        delivered: true,
        messageId: sent?.id,
        to: sent?.to ?? deliveryTo,
        type: mailboxType,
        audience,
      }),
    );
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    // WS-066: `String(err)` here forwarded the raw throw — absolute paths and
    // whatever the mailbox layer quoted back — to the browser, while the
    // sibling mailbox-action route two functions down already sanitized.
    res.end(JSON.stringify({ error: 'mailbox write failed', detail: sanitizeApiError(err) }));
  }
}

export async function handleMailboxAction(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  dataDir: string,
  getMailboxGateway: (projectDir: string) => HqRouterMailboxGateway,
): Promise<void> {
  // WS-012: this route mutates mailbox state (mark-read, acknowledge, reopen,
  // soft-delete, restore) but performed no capability check at all — its auth
  // parameters were `_`-prefixed as deliberately unused, unlike its three
  // siblings which all gate on control.enqueue.
  const auth = authenticateBrowserRequest(
    _req,
    new URL(_req.url ?? '/', 'http://localhost'),
    mutableAuth,
    sessions,
  );
  if (hqAuthRequired(mutableAuth) && !auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  if (!callerCanEnqueue(auth, mutableAuth)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden: token lacks control.enqueue capability' }));
    return;
  }
  const MAILBOX_ACTIONS = ['mark-read', 'acknowledge', 'reopen', 'soft-delete', 'restore'] as const;

  let abody: {
    action?: string;
    readerId?: string;
    sessionId?: string;
    projectId?: string;
  };
  try {
    abody = JSON.parse(await readRequestBody(_req));
  } catch (error) {
    writeInvalidBody(res, error);
    return;
  }
  const mailId = decodePathSegment(match[1]!);
  if (mailId === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid mailId encoding' }));
    return;
  }
  const action = MAILBOX_ACTIONS.find((a) => a === abody.action);
  if (action === undefined) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unrecognized action', action: abody.action }));
    return;
  }
  // WS-012: readerId is written into the mailbox as "who acknowledged this".
  // Taking it from the request body let any caller attribute an acknowledgement
  // to someone else. Derive it from the authenticated identity when there is
  // one and fall back to the body only in open mode, where there is no identity
  // to derive.
  const authenticatedReaderId = isCookieAuth(auth)
    ? (auth.tokenId ?? 'hq-password-session')
    : isTokenAuth(auth)
      ? auth.id
      : undefined;
  const resolvedReaderId = authenticatedReaderId ?? abody.readerId;
  if (typeof resolvedReaderId !== 'string' || resolvedReaderId.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing readerId' }));
    return;
  }
  if (typeof abody.sessionId !== 'string' && typeof abody.projectId !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing sessionId or projectId' }));
    return;
  }

  const actGlobalRoot = path.dirname(dataDir);
  const projectRoot = await resolveHqProjectRoot(actGlobalRoot, {
    sessionId: abody.sessionId,
    projectId: abody.projectId,
  });
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'could not resolve target project mailbox' }));
    return;
  }

  try {
    const { actionToAckInput } = await import('@wrongstack/core/coordination');
    const projectDir = resolveProjectDir(projectRoot, actGlobalRoot);
    const mailbox = getMailboxGateway(projectDir).mailbox;
    const readerId = resolvedReaderId;
    const message =
      action === 'soft-delete'
        ? await mailbox.softDelete(mailId, readerId)
        : action === 'restore'
          ? await mailbox.restore(mailId)
          : await mailbox.ack(actionToAckInput(action, { action, mailId, readerId }));
    if (message === null) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'message not found', mailId }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ action, mailId, message: null, changed: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'mailbox action failed',
        detail: sanitizeApiError(err),
      }),
    );
  }
}
