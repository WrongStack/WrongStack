/**
 * HTTP /api/* request handlers for the WebUI server — extracted from
 * http-server.ts to keep the static-serve/routing concern separate from the
 * (substantial) Fleet-HQ session/mailbox API. Every handler is a pure,
 * param-based function: it takes the Node req/res plus the globalRoot and reads
 * the cross-process SessionRegistry / project mailbox via dynamic core imports.
 * createHttpServer() in http-server.ts dispatches to these.
 */
import type * as http from 'node:http';
import { sanitizeApiError } from '@wrongstack/core/security';
import type {
  ApiSession,
  ApiSessionAgents,
  ApiSessionInterruptResponse,
  ApiSessionMessageResponse,
} from '@wrongstack/webui-protocol';

export { handleApiSessionEvents } from './api-session-events-handler.js';

export async function handleApiSessions(
  res: http.ServerResponse,
  globalRoot: string | undefined,
): Promise<void> {
  if (!globalRoot) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'SessionRegistry not available' }));
    return;
  }

  try {
    const { getSessionRegistry } = await import('@wrongstack/core/storage');
    const registry = getSessionRegistry(globalRoot);
    const sessions = await registry.list();

    const result = sessions.map(
      (s): ApiSession => ({
        sessionId: s.sessionId,
        projectSlug: s.projectSlug,
        projectName: s.projectName,
        projectRoot: s.projectRoot,
        workingDir: s.workingDir,
        status: s.status,
        pid: s.pid,
        startedAt: s.startedAt,
        lastHeartbeatAt: s.lastHeartbeatAt,
        agentCount: s.agentCount,
        agents: s.agents.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          currentTool: a.currentTool,
          iterations: a.iterations,
          toolCalls: a.toolCalls,
          lastActivityAt: a.lastActivityAt,
        })),
      }),
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: sanitizeApiError(err) }));
  }
}

export async function handleApiSessionAgents(
  res: http.ServerResponse,
  globalRoot: string | undefined,
  sessionId: string,
): Promise<void> {
  if (!globalRoot) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'SessionRegistry not available' }));
    return;
  }

  try {
    const { getSessionRegistry } = await import('@wrongstack/core/storage');
    const registry = getSessionRegistry(globalRoot);
    const entry = await registry.get(sessionId);

    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        sessionId: entry.sessionId,
        projectName: entry.projectName,
        status: entry.status,
        agents: entry.agents.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          currentTool: a.currentTool,
          iterations: a.iterations,
          toolCalls: a.toolCalls,
          lastActivityAt: a.lastActivityAt,
        })),
      } satisfies ApiSessionAgents),
    );
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: sanitizeApiError(err) }));
  }
}

/**
 * Diagnostic sink for `ProjectSessionRegistry`'s swallowed per-project failures.
 *
 * `list()` catches every metadata/probe error and substitutes `[]`, which a
 * caller cannot distinguish from "no sessions exist" — so a transient
 * session-catalog blip surfaces to the operator as a bare
 * `404 Session not found` or `delivered: 0`, with the real mechanism erased.
 * This records the phase (`metadata` | `probe`) and errno so the next
 * occurrence names its cause instead of guessing.
 *
 * Follows the module's structured-warn convention (level/event/message plus a
 * timestamp) and never puts a path or an untrusted value in the event name.
 * Silent by default: `list()` only fires it on a genuine failure, so a healthy
 * request logs nothing.
 */
function registryFailureSink(scope: string, sessionId?: string) {
  const failures: string[] = [];
  return {
    failures,
    onProjectFailure: (slug: string, phase: 'metadata' | 'probe', error: unknown): void => {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? 'error';
      const detail = `${slug}/${phase}/${code}`;
      failures.push(detail);
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'webui.session_registry_unavailable',
          scope,
          ...(sessionId !== undefined ? { sessionId } : {}),
          detail,
          timestamp: new Date().toISOString(),
        }),
      );
    },
  };
}

/**
 * Body for a "session not found" reply that can also mean "the registry
 * could not be read". The failures collected by {@link registryFailureSink}
 * are attached so a 404 is no longer ambiguous between the two — the client
 * already has the session id it asked for, and these are its OWN project slugs
 * and errno codes, not another operator's data.
 */
function sessionNotFound(sessionId: string, failures: readonly string[]): string {
  return JSON.stringify(
    failures.length > 0
      ? { error: 'Session not found', registryFailures: failures, sessionId }
      : { error: 'Session not found', sessionId },
  );
}

/**
 * Read and JSON-parse a request body, capped at 64 KiB.
 *
 * WS-001: the body must be declared `application/json`. Only `text/plain`,
 * `application/x-www-form-urlencoded`, and `multipart/form-data` qualify as
 * CORS *simple* content types, so requiring JSON forces a preflight on every
 * cross-origin write — a second, independent barrier behind the Origin guard.
 * Bodies were previously parsed regardless of the declared type.
 */
function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      reject(new Error(`Unsupported Content-Type: ${contentType || '(absent)'}`));
      return;
    }
    let data = '';
    // Decode across chunks: TCP may split a multibyte character between two
    // 'data' events, and a per-chunk decode turns it into U+FFFD.
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > 64_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}

export async function handleApiSessionMessage(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  globalRoot: string | undefined,
  sessionId: string,
): Promise<void> {
  if (!globalRoot) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'SessionRegistry not available' }));
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
    return;
  }

  const text = typeof body['text'] === 'string' ? (body['text'] as string).trim() : '';
  if (!text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'text is required' }));
    return;
  }
  const from =
    typeof body['from'] === 'string' && (body['from'] as string).trim()
      ? (body['from'] as string).trim()
      : 'human@webui';

  // Message kind from Fleet HQ's composer. The agent-loop injects every type
  // before its next LLM call; 'ask'/'assign' carry a stronger call-to-action
  // in the injected block (see buildMailboxBlock). Default 'steer'.
  const ALLOWED = new Set(['steer', 'ask', 'assign', 'note', 'btw']);
  const rawType = typeof body['type'] === 'string' ? (body['type'] as string) : 'steer';
  const type = (ALLOWED.has(rawType) ? rawType : 'steer') as
    | 'steer'
    | 'ask'
    | 'assign'
    | 'note'
    | 'btw';
  const rawPriority = typeof body['priority'] === 'string' ? (body['priority'] as string) : '';
  const priority = (['low', 'normal', 'high'].includes(rawPriority) ? rawPriority : 'high') as
    | 'low'
    | 'normal'
    | 'high';
  const subject =
    typeof body['subject'] === 'string' && (body['subject'] as string).trim()
      ? (body['subject'] as string).trim()
      : 'Message from Fleet HQ';

  try {
    const { getSessionRegistry } = await import('@wrongstack/core/storage');
    const { getSharedProjectMailbox, mailboxSessionTag } = await import('@wrongstack/coordination');
    const { resolveWstackPaths } = await import('@wrongstack/core/utils');
    const registry = getSessionRegistry(globalRoot);
    const probe = registryFailureSink('message', sessionId);
    const entry = await registry.get(sessionId, { onProjectFailure: probe.onProjectFailure });
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(sessionNotFound(sessionId, probe.failures));
      return;
    }

    const paths = resolveWstackPaths({ projectRoot: entry.projectRoot, globalRoot });
    const mailbox = getSharedProjectMailbox(paths.projectDir);
    // The target session's leader answers to `leader@<sessionTag>` — its
    // agent-loop checker queries exactly this address before each LLM call.
    const to = `leader@${mailboxSessionTag(sessionId)}`;
    const sent = await mailbox.send({ from, to, type, subject, body: text, priority });

    // Return the message id so the caller can poll the thread for read-receipt
    // (readBy) and the agent's reply — the visible two-way feedback loop.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const body: ApiSessionMessageResponse = {
      ok: true,
      id: sent.id,
      to,
      type,
      delivered: entry.status,
    };
    res.end(JSON.stringify(body));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: sanitizeApiError(err) }));
  }
}

/**
 * GET /api/sessions/:id/mailbox — the human↔leader thread for a session.
 *
 * Returns the messages exchanged between the operator (human@webui) and this
 * session's leader, newest last, with read-receipts (readBy) and completion/
 * outcome. This is what makes the WebUI's two-way loop *visible*: after Fleet
 * HQ sends a steer/ask, the panel shows whether the target read it (✓) and any
 * reply the agent posted back.
 */
export async function handleApiSessionMailbox(
  res: http.ServerResponse,
  globalRoot: string | undefined,
  sessionId: string,
): Promise<void> {
  if (!globalRoot) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'SessionRegistry not available' }));
    return;
  }
  try {
    const { getSessionRegistry } = await import('@wrongstack/core/storage');
    const { getSharedProjectMailbox, mailboxSessionTag } = await import('@wrongstack/coordination');
    const { resolveWstackPaths } = await import('@wrongstack/core/utils');
    const registry = getSessionRegistry(globalRoot);
    const probe = registryFailureSink('mailbox', sessionId);
    const entry = await registry.get(sessionId, { onProjectFailure: probe.onProjectFailure });
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(sessionNotFound(sessionId, probe.failures));
      return;
    }
    const paths = resolveWstackPaths({ projectRoot: entry.projectRoot, globalRoot });
    const mailbox = getSharedProjectMailbox(paths.projectDir);
    const leaderAddr = `leader@${mailboxSessionTag(sessionId)}`;
    // Messages TO the leader (operator → agent) and FROM the leader (replies).
    const [inbound, outbound] = await Promise.all([
      mailbox.query({ to: leaderAddr, limit: 50 }),
      mailbox.query({ from: leaderAddr, limit: 50 }),
    ]);
    const seen = new Set<string>();
    const thread = [...inbound, ...outbound]
      .filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      })
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .map((m) => ({
        id: m.id,
        from: m.from,
        to: m.to,
        type: m.type,
        subject: m.subject,
        body: m.body,
        priority: m.priority,
        // Whether the leader has read it, and when.
        readByLeader: m.readBy?.[leaderAddr] ?? null,
        readByCount: Object.keys(m.readBy ?? {}).length,
        completed: m.completed,
        outcome: m.outcome ?? null,
        timestamp: m.timestamp,
        replyTo: m.replyTo ?? null,
        fromLeader: m.from === leaderAddr,
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessionId, leader: leaderAddr, status: entry.status, thread }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: sanitizeApiError(err) }));
  }
}

/**
 * POST /api/sessions/:id/interrupt — cooperatively halt a running session.
 *
 * Sends a high-priority `control` mailbox message. The target's agent-loop
 * checks the mailbox before each LLM call; on seeing a fresh control:interrupt
 * it stops gracefully at the next iteration boundary (it does NOT kill the
 * process — for a hard stop use the process panel's PID kill). Cross-process
 * interrupt is necessarily cooperative: the WebUI server can't reach another
 * process's AbortController, only its mailbox.
 */
export async function handleApiSessionInterrupt(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  globalRoot: string | undefined,
  sessionId: string,
): Promise<void> {
  if (!globalRoot) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'SessionRegistry not available' }));
    return;
  }
  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBody(req);
  } catch {
    /* interrupt needs no body — ignore parse errors */
  }
  const reason =
    typeof body['reason'] === 'string' && (body['reason'] as string).trim()
      ? (body['reason'] as string).trim()
      : 'Operator requested stop from Fleet HQ';
  const from =
    typeof body['from'] === 'string' && (body['from'] as string).trim()
      ? (body['from'] as string).trim()
      : 'human@webui';
  try {
    const { getSessionRegistry } = await import('@wrongstack/core/storage');
    const { getSharedProjectMailbox, mailboxSessionTag } = await import('@wrongstack/coordination');
    const { resolveWstackPaths } = await import('@wrongstack/core/utils');
    const registry = getSessionRegistry(globalRoot);
    const probe = registryFailureSink('interrupt', sessionId);
    const entry = await registry.get(sessionId, { onProjectFailure: probe.onProjectFailure });
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(sessionNotFound(sessionId, probe.failures));
      return;
    }
    const paths = resolveWstackPaths({ projectRoot: entry.projectRoot, globalRoot });
    const mailbox = getSharedProjectMailbox(paths.projectDir);
    const to = `leader@${mailboxSessionTag(sessionId)}`;
    const sent = await mailbox.sendRuntimeControl({
      from,
      to,
      subject: 'interrupt',
      body: reason,
      priority: 'high',
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const body: ApiSessionInterruptResponse = {
      ok: true,
      id: sent.id,
      to,
      delivered: entry.status,
    };
    res.end(JSON.stringify(body));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: sanitizeApiError(err) }));
  }
}

/** Same directory, ignoring separator style and (on Windows) case. */
function sameProjectRoot(a: string, b: string): boolean {
  const norm = (value: string) => {
    const plain = value
      .replace(/^\\\\\?\\/, '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
    return process.platform === 'win32' ? plain.toLowerCase() : plain;
  };
  return norm(a) === norm(b);
}

/**
 * The sessions a fleet broadcast reaches: non-stale sessions of the host's own project. The
 * project is the host process's own registered session's, else the host's project root. With
 * neither known nothing is addressed — a broadcast must never reach other projects' leaders.
 */
export function fleetBroadcastTargets<
  T extends { pid: number; projectSlug: string; projectRoot: string; status: string },
>(all: readonly T[], hostPid: number, projectRoot: string | undefined): T[] {
  const mySlug = all.find((s) => s.pid === hostPid)?.projectSlug;
  return all
    .filter((s) => s.status !== 'stale')
    .filter((s) =>
      mySlug
        ? s.projectSlug === mySlug
        : projectRoot
          ? sameProjectRoot(s.projectRoot, projectRoot)
          : false,
    );
}

/**
 * POST /api/fleet/broadcast — send one message to every live session's leader.
 *
 * Resolves all non-stale sessions in the same project as the WebUI host and
 * sends the message to each session's `leader@<tag>` (a true per-leader fan-out
 * rather than the bare '*' broadcast, so every live leader's mailbox loop —
 * which queries its session-bound id — actually receives it).
 */
export async function handleApiFleetBroadcast(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  globalRoot: string | undefined,
  projectRoot?: string | undefined,
): Promise<void> {
  if (!globalRoot) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'SessionRegistry not available' }));
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
    return;
  }
  const text = typeof body['text'] === 'string' ? (body['text'] as string).trim() : '';
  if (!text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'text is required' }));
    return;
  }
  const from =
    typeof body['from'] === 'string' && (body['from'] as string).trim()
      ? (body['from'] as string).trim()
      : 'human@webui';
  try {
    const { getSessionRegistry } = await import('@wrongstack/core/storage');
    const { getSharedProjectMailbox, mailboxSessionTag } = await import('@wrongstack/coordination');
    const { resolveWstackPaths } = await import('@wrongstack/core/utils');
    const registry = getSessionRegistry(globalRoot);
    const probe = registryFailureSink('broadcast');
    const all = await registry.list({ onProjectFailure: probe.onProjectFailure });
    // Scope to the WebUI host's own project, like the live status poll does.
    const targets = fleetBroadcastTargets(all, process.pid, projectRoot);
    if (targets.length === 0) {
      // `list()` swallowed a per-project failure, so "no live sessions" and
      // "the catalog could not be read" are indistinguishable here. Report
      // which: the fleet-control tests assert `delivered >= 1`, and this is
      // the branch that made that assertion flaky.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          probe.failures.length > 0
            ? { ok: true, delivered: 0, registryFailures: probe.failures }
            : { ok: true, delivered: 0 },
        ),
      );
      return;
    }
    // Cache one mailbox per project dir (targets here share a slug).
    const mbByDir = new Map<string, ReturnType<typeof getSharedProjectMailbox>>();
    const mailboxFor = (projectRoot: string): ReturnType<typeof getSharedProjectMailbox> => {
      const dir = resolveWstackPaths({ projectRoot, globalRoot }).projectDir;
      let mb = mbByDir.get(dir);
      if (!mb) {
        mb = getSharedProjectMailbox(dir);
        mbByDir.set(dir, mb);
      }
      return mb;
    };
    let delivered = 0;
    await Promise.all(
      targets.map(async (s) => {
        try {
          const mb = mailboxFor(s.projectRoot);
          await mb.send({
            from,
            to: `leader@${mailboxSessionTag(s.sessionId)}`,
            type: 'steer',
            subject: 'Broadcast from Fleet HQ',
            body: text,
            priority: 'high',
          });
          delivered++;
        } catch {
          /* best-effort per target */
        }
      }),
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, delivered, targets: targets.length }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: sanitizeApiError(err) }));
  }
}
