/**
 * The tools of a WrongStack session, served to WrongForge while it leads that
 * session (wrongforge-leader-provider.ts).
 *
 * Unlike a worker's gateway (fleet/wrongforge-gateway.ts: a session-less
 * executor), every call here runs as the session's own tool call
 * (`AcpLeaderHost.runTool`): its permission policy and prompts, its context
 * (files read, the session journal, rewind), its tool cards, and its fleet —
 * a `delegate` from WrongForge reports back into this session like the
 * leader's own. Same REST shape as `wstack tools serve`, which is what
 * WrongForge's task `gateway` speaks.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Tool } from '@wrongstack/contracts/types';
import { isToolReachable } from '@wrongstack/core/agent';
import {
  compactToolDefinitionForWire,
  subjectForToolInput,
  toErrorMessage,
} from '@wrongstack/core/utils';
import type { WrongForgeGatewaySpec } from '@wrongstack/fleet';
import { timingSafeTokenEqual } from '@wrongstack/primitives';
import { confirmThroughEvents, rememberConfirmAnswer } from '../acp-leader/acp-leader-confirm.js';
import type { AcpLeaderHost } from '../acp-leader/acp-leader-host.js';

/**
 * Not offered: WrongForge reads with its own tools (a second copy only splits
 * the model's choice), and these drive the WrongStack loop itself, which this
 * route does not run (the agent loop that would answer them is WrongForge's).
 */
const NOT_OFFERED: ReadonlySet<string> = new Set([
  'read',
  'glob',
  'grep',
  'fetch',
  'read_url_content',
  'tree',
  'clarify',
  'tool_use',
  'tool_script',
  'tool_search',
]);

const MAX_BODY = 4 * 1024 * 1024;

export interface LeaderGateway {
  spec: WrongForgeGatewaySpec;
  tools: string[];
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ask the session's user about one call, on the prompt its surface has. */
async function askUser(
  host: AcpLeaderHost,
  sessionId: string,
  tool: Tool,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  const suggestedPattern =
    subjectForToolInput(tool.name, input, tool.subjectKey, tool.subjectFields) ?? tool.name;
  const toolUseId = `wrongforge-${randomBytes(6).toString('hex')}`;
  if (host.confirmAwaiter) {
    const answer = await host.confirmAwaiter(tool, input, toolUseId, suggestedPattern);
    if (signal.aborted) return false;
    await rememberConfirmAnswer(
      {
        tool,
        input,
        suggestedPattern,
        permission: host.permission(sessionId),
        context: host.context(sessionId),
      },
      answer,
    );
    return !signal.aborted && answer !== 'no' && answer !== 'deny';
  }
  if (!host.confirmThroughEvents) return false;
  const approved = await confirmThroughEvents({
    events: host.events,
    sessionId,
    tool,
    input,
    toolUseId,
    suggestedPattern,
    signal,
    permission: host.permission(sessionId),
    context: host.context(sessionId),
  });
  return !signal.aborted && approved;
}

export async function startLeaderGateway(
  host: AcpLeaderHost,
  sessionId: string,
): Promise<LeaderGateway | undefined> {
  // Offer what this session can call (session-tool-reach), not the registry.
  // The executor enforces the same rule on every call.
  const sessionCtx = host.context?.(sessionId);
  const tools = (host.listTools?.() ?? []).filter(
    (t) => !NOT_OFFERED.has(t.name) && (!sessionCtx || isToolReachable(sessionCtx, t.name)),
  );
  if (tools.length === 0) return undefined;
  const byName = new Map(tools.map((t) => [t.name, t]));
  // Schemas on this listing reach Claude through WrongForge: serve the same
  // wire-normalized form every provider converter applies — top-level
  // combinators flattened (Anthropic-family endpoints reject them at the
  // input_schema root) and description prose inside the provider budgets.
  // `runTool` still executes the real tool, whose original schema remains
  // the runtime validator.
  const wireTools = tools.map((t) =>
    compactToolDefinitionForWire({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: 'object' },
    }),
  );
  const token = randomBytes(24).toString('hex');
  const expected = `Bearer ${token}`;
  const authorized = (req: http.IncomingMessage) =>
    timingSafeTokenEqual(req.headers.authorization, expected);
  let closed = false;
  const activeCalls = new Set<AbortController>();
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  };

  const server = http.createServer((req, res) => {
    if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/v1/tools') {
      return send(res, 200, {
        tools: wireTools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          input_schema: inputSchema,
        })),
      });
    }
    const m = /^\/v1\/tools\/([^/]+)\/call$/.exec(url.pathname);
    if (req.method !== 'POST' || !m) return send(res, 404, { ok: false, error: 'not_found' });
    // Same REST shape as `wstack tools serve` (tool-gateway-http.ts): a
    // malformed percent escape in the {name} segment throws URIError, and an
    // exception escaping this synchronous handler takes the connection down
    // with it (Bun fabricates an empty answer, Node unwinds the host) instead
    // of returning the canonical 400. Reject it the way every other malformed
    // request on this surface is rejected — with an HTTP status.
    let name: string;
    try {
      name = decodeURIComponent(m[1] ?? '');
    } catch {
      return send(res, 400, { ok: false, error: 'invalid_path_encoding' });
    }
    const tool = byName.get(name);
    if (!tool) {
      return send(res, 404, { ok: false, tool: name, error: 'not_offered' });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (tooLarge) {
        if (size > MAX_BODY * 2) req.destroy();
        return;
      }
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        send(res, 413, { ok: false, error: 'payload_too_large' });
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (closed) {
        return send(res, 503, { ok: false, tool: name, error: 'gateway_closed' });
      }
      let raw: unknown;
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        raw = text ? JSON.parse(text) : {};
      } catch {
        return send(res, 400, { ok: false, tool: name, error: 'invalid_json' });
      }
      if (!isRecord(raw)) {
        return send(res, 400, { ok: false, tool: name, error: 'invalid_json' });
      }
      const rawInput = raw['input'] === undefined ? {} : raw['input'];
      if (!isRecord(rawInput)) {
        return send(res, 400, { ok: false, tool: name, error: 'invalid_input' });
      }
      const input = rawInput;
      const callAbort = new AbortController();
      activeCalls.add(callAbort);
      const onClose = () => {
        if (!res.writableEnded) callAbort.abort();
      };
      req.on('aborted', onClose);
      res.on('close', onClose);
      host
        .runTool(name, input, {
          sessionId,
          approve: (t, i) => askUser(host, sessionId, t, i, callAbort.signal),
          // The provider draws no card for a `wstack_*` call (its events are
          // marked external), so the session's card is settled here.
          announce: true,
        })
        .then(
          (r) => send(res, 200, { ok: !r.isError, tool: name, content: r.content }),
          (err: unknown) =>
            send(res, 200, {
              ok: false,
              tool: name,
              error: 'tool_failed',
              message: toErrorMessage(err),
            }),
        )
        .finally(() => {
          req.removeListener('aborted', onClose);
          res.removeListener('close', onClose);
          activeCalls.delete(callAbort);
        });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    spec: {
      url: `http://127.0.0.1:${port}`,
      token,
      list_path: '/v1/tools',
      call_path: '/v1/tools/{name}/call',
      name_prefix: 'wstack_',
    },
    tools: [...byName.keys()],
    close: () => {
      closed = true;
      for (const ctrl of [...activeCalls]) ctrl.abort();
      activeCalls.clear();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
