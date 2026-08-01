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
    const { SessionRegistry } = await import('@wrongstack/core/storage');
    const registry = new SessionRegistry(globalRoot);
    const sessions = await registry.list();

    const result = sessions.map((s) => ({
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
    }));

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
    const { SessionRegistry } = await import('@wrongstack/core/storage');
    const registry = new SessionRegistry(globalRoot);
    const entry = await registry.get(sessionId);

    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
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
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: sanitizeApiError(err) }));
  }
}

/** One line in the session "watch" stream sent to the browser.
 *  Rich enough for the frontend to render full tool call details,
 *  markdown, and structured data — not just pre-clipped text. */
interface WatchEntry {
  ts: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  /** Human-readable text summary (may be clipped for tool input/output). */
  text: string;
  /** Tool name (for tool-role entries). */
  tool?: string;
  /** Structured tool input (object or array — rendered by ToolInputView). */
  input?: unknown;
  /** Structured tool output (rendered as pre-formatted text / markdown). */
  output?: unknown;
  /** Wall-clock duration in ms (tool call / response). */
  durationMs?: number;
  /** Whether the tool/response had an error. */
  isError?: boolean;
  /** Tool use correlation id — pairs tool_call_start with tool_call_end. */
  toolUseId?: string;
}

/** Join the text blocks of a message content value into a single string. */
function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' &&
          typeof (b as { text?: unknown }).text === 'string',
      )
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Map a raw session event to a watch entry. Returns rich structured data
 *  for tool calls (input + output + duration) so the frontend can render
 *  full detail via WatchMessageBubble — matching the main ChatView. */
function mapWatchEntry(ev: Record<string, unknown>): WatchEntry | null {
  const ts = typeof ev['ts'] === 'string' ? (ev['ts'] as string) : '';
  switch (ev['type']) {
    case 'user_input': {
      const text = blocksToText(ev['content']);
      return text.trim() ? { ts, role: 'user', text } : null;
    }
    case 'llm_response': {
      const text = blocksToText(ev['content']);
      return text.trim() ? { ts, role: 'assistant', text } : null;
    }
    case 'tool_use':
    case 'tool_call_start': {
      const toolName = String(ev['name'] ?? 'tool');
      const input = ev['input'] ?? ev['args'];
      const text = input !== undefined && input !== null ? asString(input) : '';
      const toolUseId = typeof ev['id'] === 'string' ? ev['id'] : undefined;
      return {
        ts,
        role: 'tool',
        tool: toolName,
        text,
        input,
        ...(toolUseId !== undefined ? { toolUseId } : {}),
      };
    }
    case 'tool_call_end':
    case 'tool_result': {
      const isError = ev['isError'] === true;
      const content = ev['output'] ?? ev['content'];
      const outStr = content !== undefined && content !== null ? asString(content) : '';
      const durationMs = typeof ev['durationMs'] === 'number' ? ev['durationMs'] : undefined;
      const toolUseId = typeof ev['id'] === 'string' ? ev['id'] : undefined;
      const toolName = typeof ev['name'] === 'string' ? String(ev['name']) : '↳ result';
      if (!outStr.trim() && !isError) return null;
      return {
        ts,
        role: isError ? 'error' : 'tool',
        tool: toolName,
        text: outStr,
        output: content,
        isError,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(toolUseId !== undefined ? { toolUseId } : {}),
      };
    }
    case 'error':
    case 'provider_error':
      return { ts, role: 'error', text: String(ev['message'] ?? 'error') };
    case 'agent_spawned':
      return { ts, role: 'system', text: `spawned ${String(ev['role'] ?? 'agent')}` };
    case 'task_completed':
      return { ts, role: 'system', text: `task done: ${String(ev['title'] ?? '')}` };
    case 'task_failed':
      return { ts, role: 'system', text: `task failed: ${String(ev['title'] ?? '')}` };
    default:
      return null;
  }
}

/** Correlate tool_call_start + tool_call_end events by id and merge them
 *  into unified WatchEntry entries with full input+output+duration.
 *  Standalone events (unpaired) pass through as-is. */
function correlateToolEvents(entries: WatchEntry[]): WatchEntry[] {
  const pending = new Map<string, WatchEntry>(); // toolUseId → start entry
  const result: WatchEntry[] = [];
  for (const e of entries) {
    if (e.role === 'tool' && e.toolUseId && e.output === undefined && e.durationMs === undefined) {
      // This is a tool_call_start with no result yet — stash it
      pending.set(e.toolUseId, e);
      continue;
    }
    if (e.toolUseId && pending.has(e.toolUseId)) {
      const start = pending.get(e.toolUseId)!;
      pending.delete(e.toolUseId);
      // Merge: keep the start's ts, tool name, and input; add the end's output/duration/error
      result.push({
        ts: start.ts,
        role: e.isError ? 'error' : 'tool',
        text: e.text || start.text,
        ...(e.isError !== undefined ? { isError: e.isError } : {}),
        ...(start.tool !== undefined ? { tool: start.tool } : {}),
        ...(start.input !== undefined ? { input: start.input } : {}),
        ...(e.output !== undefined ? { output: e.output } : {}),
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        ...(e.toolUseId !== undefined ? { toolUseId: e.toolUseId } : {}),
      });
      continue;
    }
    result.push(e);
  }
  // Unpaired start events: flush at the end
  for (const e of pending.values()) result.push(e);
  return result;
}

export async function handleApiSessionEvents(
  res: http.ServerResponse,
  globalRoot: string | undefined,
  sessionId: string,
  limit: number,
): Promise<void> {
  if (!globalRoot) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'SessionRegistry not available' }));
    return;
  }

  try {
    const { SessionRegistry, DefaultSessionStore, DefaultSessionReader } =
      await import('@wrongstack/core/storage');
    const { resolveWstackPaths } = await import('@wrongstack/core/utils');
    const registry = new SessionRegistry(globalRoot);
    const entry = await registry.get(sessionId);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    const paths = resolveWstackPaths({ projectRoot: entry.projectRoot, globalRoot });
    const store = new DefaultSessionStore({ dir: paths.projectSessions });
    const reader = new DefaultSessionReader({ store });

    const rawEntries: WatchEntry[] = [];
    for await (const ev of reader.replay(sessionId)) {
      const mapped = mapWatchEntry(ev as never as Record<string, unknown>);
      if (mapped) rawEntries.push(mapped);
    }
    // Correlate paired tool call start+end events for rich combined rendering
    const all = correlateToolEvents(rawEntries);
    const tail = all.slice(-limit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        sessionId,
        status: entry.status,
        clientType: entry.clientType,
        projectName: entry.projectName,
        total: all.length,
        entries: tail,
      }),
    );
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: sanitizeApiError(err) }));
  }
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
    req.on('data', (chunk) => {
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
    const { SessionRegistry } = await import('@wrongstack/core/storage');
    const { getSharedProjectMailbox, mailboxSessionTag } = await import('@wrongstack/core/coordination');
    const { resolveWstackPaths } = await import('@wrongstack/core/utils');
    const registry = new SessionRegistry(globalRoot);
    const entry = await registry.get(sessionId);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
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
    res.end(JSON.stringify({ ok: true, id: sent.id, to, type, delivered: entry.status }));
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
    const { SessionRegistry } = await import('@wrongstack/core/storage');
    const { getSharedProjectMailbox, mailboxSessionTag } = await import('@wrongstack/core/coordination');
    const { resolveWstackPaths } = await import('@wrongstack/core/utils');
    const registry = new SessionRegistry(globalRoot);
    const entry = await registry.get(sessionId);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
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
    const { SessionRegistry } = await import('@wrongstack/core/storage');
    const { getSharedProjectMailbox, mailboxSessionTag } = await import('@wrongstack/core/coordination');
    const { resolveWstackPaths } = await import('@wrongstack/core/utils');
    const registry = new SessionRegistry(globalRoot);
    const entry = await registry.get(sessionId);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
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
    res.end(JSON.stringify({ ok: true, id: sent.id, to, delivered: entry.status }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: sanitizeApiError(err) }));
  }
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
    const { SessionRegistry } = await import('@wrongstack/core/storage');
    const { getSharedProjectMailbox, mailboxSessionTag } = await import('@wrongstack/core/coordination');
    const { resolveWstackPaths } = await import('@wrongstack/core/utils');
    const registry = new SessionRegistry(globalRoot);
    const all = await registry.list();
    // Scope to the WebUI host's own project (its pid's entry), like the live
    // status poll does. Fall back to every non-stale session if not found.
    const mySlug = all.find((s) => s.pid === process.pid)?.projectSlug;
    const targets = all
      .filter((s) => s.status !== 'stale')
      .filter((s) => (mySlug ? s.projectSlug === mySlug : true));
    if (targets.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, delivered: 0 }));
      return;
    }
    // Cache one mailbox per project dir (targets here share a slug).
    const mbByDir = new Map<
      string,
      ReturnType<typeof getSharedProjectMailbox>
    >();
    const mailboxFor = (
      projectRoot: string,
    ): ReturnType<typeof getSharedProjectMailbox> => {
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
