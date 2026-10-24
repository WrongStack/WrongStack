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
import {
  compactToolDefinitionForWire,
  subjectForToolInput,
  toErrorMessage,
} from '@wrongstack/core/utils';
import { timingSafeTokenEqual } from '@wrongstack/primitives';
import { confirmThroughEvents } from '../acp-leader/acp-leader-confirm.js';
import type { AcpLeaderHost } from '../acp-leader/acp-leader-host.js';
import type { WrongForgeGatewaySpec } from '../fleet/wrongforge-client.js';

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

/** Ask the session's user about one call, on the prompt its surface has. */
async function askUser(
  host: AcpLeaderHost,
  sessionId: string,
  tool: Tool,
  input: Record<string, unknown>,
): Promise<boolean> {
  const suggestedPattern =
    subjectForToolInput(tool.name, input, tool.subjectKey, tool.subjectFields) ?? tool.name;
  const toolUseId = `wrongforge-${randomBytes(6).toString('hex')}`;
  if (host.confirmAwaiter) {
    const answer = await host.confirmAwaiter(tool, input, toolUseId, suggestedPattern);
    return answer !== 'no' && answer !== 'deny';
  }
  if (!host.confirmThroughEvents) return false;
  return confirmThroughEvents({
    events: host.events,
    sessionId,
    tool,
    input,
    toolUseId,
    suggestedPattern,
    signal: new AbortController().signal,
    permission: host.permission(sessionId),
    context: host.context(sessionId),
  });
}

export async function startLeaderGateway(
  host: AcpLeaderHost,
  sessionId: string,
): Promise<LeaderGateway | undefined> {
  const tools = (host.listTools?.() ?? []).filter((t) => !NOT_OFFERED.has(t.name));
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
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
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
    const name = decodeURIComponent(m[1] ?? '');
    const tool = byName.get(name);
    if (!tool) {
      return send(res, 404, { ok: false, tool: name, error: 'not_offered' });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      let input: Record<string, unknown> = {};
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
          input?: unknown;
        };
        if (body.input && typeof body.input === 'object' && !Array.isArray(body.input)) {
          input = body.input as Record<string, unknown>;
        }
      } catch {
        return send(res, 400, { ok: false, tool: name, error: 'invalid_json' });
      }
      host
        .runTool(name, input, {
          sessionId,
          approve: (t, i) => askUser(host, sessionId, t, i),
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
        );
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
