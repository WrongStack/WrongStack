/**
 * `wstack tools serve` — the tool gateway as a plain REST service, so an
 * external agent (a WrongForge worker, a script, another orchestrator) can use
 * WrongStack's tools as if they were its own: it lists them once, registers
 * each as a local tool whose `execute` POSTs here, and hands the model the
 * response body as the tool's result.
 *
 *   GET  /health                   no auth — liveness only
 *   GET  /v1/tools                 { mode, capabilities, tools: [{ name, description, input_schema, capabilities }] }
 *   GET  /v1/tools/:name           one tool, or 404 { ok:false, error:'not_exposed', message }
 *   POST /v1/tools/:name/call      { input?, call_id?, workdir?, callback? } → the call's result
 *
 * A call's body is always `{ call_id, ok, tool, … }`: a tool outcome — success,
 * a tool error, invalid input, a policy refusal — is HTTP 200, because to the
 * calling model it is a tool result like any other. Only transport problems
 * (auth, malformed request, unknown tool, overload) use other statuses.
 *
 * Long calls: with `callback: { url, token? }` the call answers `202
 * { call_id, status:'accepted' }` at once and POSTs the result to `url`
 * (loopback only unless the operator opts in) when it settles.
 *
 * Same transport guards as `wstack mcp serve --http` (bearer token compared in
 * constant time, Origin / Host pinning against DNS rebinding, JSON-only POSTs,
 * no CORS), and unlike that surface the token is never optional.
 */
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  bearerTokenMatches,
  hostHeaderIsAcceptable,
  isJsonContentType,
  isLoopbackHost,
  originIsAcceptable,
} from '@wrongstack/mcp';
import { type ToolGateway, withheldReason } from './tool-gateway.js';

/** Request bodies are tool inputs, not uploads. Same cap as the MCP HTTP transport. */
const BODY_CAP_BYTES = 4 * 1024 * 1024;
/** Calls running at once; more answer 429 so a runaway caller cannot pile up work. */
const DEFAULT_MAX_CONCURRENT_CALLS = 16;
const CALLBACK_TIMEOUT_MS = 30_000;

export interface ToolGatewayHttpOptions {
  gateway: ToolGateway;
  /** For `withheldReason` on tools the gateway does not expose. */
  registry: ToolRegistry;
  /** Required. Every route but `/health` checks `Authorization: Bearer <token>`. */
  token: string;
  /** TCP port; 0 picks a free one. */
  port?: number | undefined;
  /** Default 127.0.0.1. */
  host?: string | undefined;
  /** Allow `callback.url` to name a non-loopback host. Default false. */
  allowRemoteCallbacks?: boolean | undefined;
  maxConcurrentCalls?: number | undefined;
  /** Do not keep the process alive for this server (an in-process side service). */
  unref?: boolean | undefined;
  log?: ((message: string) => void) | undefined;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch | undefined;
}

export interface ToolGatewayHttpHandle {
  url: string;
  port: number;
  host: string;
  /** Resolves once every accepted async call has settled and its callback was attempted. */
  close(): Promise<void>;
}

interface CallRequest {
  input: Record<string, unknown>;
  callId: string;
  callback?: { url: string; token?: string | undefined } | undefined;
  /** The caller's working directory for this call (WrongForge sends its task `workdir`). */
  workdir?: string | undefined;
}

export function serveToolGatewayHttp(opts: ToolGatewayHttpOptions): Promise<ToolGatewayHttpHandle> {
  const host = opts.host ?? '127.0.0.1';
  if (!opts.token || opts.token.length < 16) {
    return Promise.reject(
      new Error('tools serve: a bearer token of at least 16 characters is required'),
    );
  }
  const maxConcurrent = opts.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS;
  const pending = new Set<Promise<void>>();
  let inFlight = 0;

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      opts.log?.(`tools serve: request failed: ${toErrorMessage(err)}`);
      if (!res.headersSent) send(res, 500, { ok: false, error: 'internal_error' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!originIsAcceptable(req, host))
      return send(res, 403, { ok: false, error: 'cross_origin_forbidden' });
    if (!hostHeaderIsAcceptable(req, host))
      return send(res, 403, { ok: false, error: 'untrusted_host_header' });
    const url = new URL(req.url ?? '/', 'http://local');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (!bearerTokenMatches(req.headers.authorization, opts.token)) {
      return send(res, 401, { ok: false, error: 'unauthorized' });
    }

    let parts: string[];
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return send(res, 400, { ok: false, error: 'invalid_path_encoding' });
    }

    if (parts[0] !== 'v1' || parts[1] !== 'tools')
      return send(res, 404, { ok: false, error: 'not_found' });
    const name = parts[2];
    if (req.method === 'GET' && parts.length === 2) {
      return send(res, 200, {
        mode: opts.gateway.mode,
        capabilities: opts.gateway.capabilities,
        tools: opts.gateway.tools.map(describe),
      });
    }
    if (req.method === 'GET' && name && parts.length === 3) {
      const tool = opts.gateway.get(name);
      if (!tool) return send(res, 404, notExposedBody(name));
      return send(res, 200, describe(tool));
    }
    if (req.method === 'POST' && name && parts.length === 4 && parts[3] === 'call') {
      return call(req, res, name);
    }
    return send(res, req.method === 'GET' || req.method === 'POST' ? 404 : 405, {
      ok: false,
      error: req.method === 'GET' || req.method === 'POST' ? 'not_found' : 'method_not_allowed',
    });
  }

  async function call(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    // `application/json` is not a CORS-simple type: a cross-origin page cannot
    // POST it without a preflight this server never answers.
    if (!isJsonContentType(req.headers['content-type'])) {
      return send(res, 415, { ok: false, error: 'content_type_must_be_json' });
    }
    const body = await readBody(req);
    if (body === 'too_large') return send(res, 413, { ok: false, error: 'payload_too_large' });
    let parsed: CallRequest;
    try {
      parsed = parseCallRequest(body, opts.allowRemoteCallbacks === true);
    } catch (err) {
      return send(res, 400, { ok: false, error: 'bad_request', message: toErrorMessage(err) });
    }
    if (!opts.gateway.get(name)) {
      return send(res, 404, { call_id: parsed.callId, ...notExposedBody(name) });
    }
    let cwd: string | undefined;
    if (parsed.workdir !== undefined) {
      const resolved = await resolveWorkdir(parsed.workdir, opts.gateway.projectRoot);
      if ('error' in resolved) {
        return send(res, 400, {
          call_id: parsed.callId,
          ok: false,
          tool: name,
          error: 'bad_workdir',
          message: resolved.error,
        });
      }
      cwd = resolved.cwd;
    }
    if (inFlight >= maxConcurrent) {
      return send(res, 429, { call_id: parsed.callId, ok: false, error: 'too_many_calls' });
    }

    inFlight++;
    const settle = run(name, parsed, cwd).finally(() => {
      inFlight--;
    });
    if (!parsed.callback) {
      return send(res, 200, await settle);
    }
    send(res, 202, { call_id: parsed.callId, status: 'accepted' });
    const delivery = settle
      .then((result) => deliverCallback(parsed.callback!, result))
      .catch((err) =>
        opts.log?.(`tools serve: callback for ${parsed.callId} failed: ${toErrorMessage(err)}`),
      );
    pending.add(delivery);
    void delivery.finally(() => pending.delete(delivery));
  }

  async function run(
    name: string,
    req: CallRequest,
    cwd: string | undefined,
  ): Promise<Record<string, unknown>> {
    const base = { call_id: req.callId, tool: name };
    try {
      const outcome = await opts.gateway.call(name, req.input, { cwd });
      if (outcome.kind === 'not_exposed') return { ...base, ...notExposedBody(name) };
      if (outcome.kind === 'confirm_required') {
        return {
          ...base,
          ok: false,
          error: 'confirm_required',
          message: `Tool "${name}" needs an interactive confirmation for this input, which this server cannot give.`,
        };
      }
      return {
        ...base,
        ok: !outcome.isError && outcome.settlement === 'completed',
        settlement: outcome.settlement,
        duration_ms: outcome.durationMs,
        content: outcome.content,
      };
    } catch (err) {
      return { ...base, ok: false, error: 'tool_threw', message: toErrorMessage(err) };
    }
  }

  async function deliverCallback(
    callback: NonNullable<CallRequest['callback']>,
    result: Record<string, unknown>,
  ): Promise<void> {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(callback.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(callback.token ? { authorization: `Bearer ${callback.token}` } : {}),
      },
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`callback answered HTTP ${res.status}`);
  }

  function notExposedBody(name: string): Record<string, unknown> {
    return {
      ok: false,
      tool: name,
      error: 'not_exposed',
      message: withheldReason(opts.gateway, opts.registry, name),
    };
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.removeListener('error', reject);
      if (opts.unref) server.unref();
      const port = (server.address() as AddressInfo).port;
      const shown = host === '::1' ? '[::1]' : host;
      resolve({
        url: `http://${shown}:${port}/`,
        port,
        host,
        close: async () => {
          await new Promise<void>((done) => server.close(() => done()));
          await Promise.allSettled([...pending]);
        },
      });
    });
  });
}

/** What a caller needs to register the tool as its own. */
function describe(tool: Tool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema ?? { type: 'object' },
    capabilities: tool.capabilities ?? [],
    mutating: tool.mutating,
  };
}

function parseCallRequest(body: string, allowRemoteCallbacks: boolean): CallRequest {
  const text = body.trim();
  const raw: unknown = text === '' ? {} : JSON.parse(text);
  if (!isRecord(raw)) throw new Error('the body must be a JSON object');
  const input = raw['input'] ?? {};
  if (!isRecord(input)) throw new Error('"input" must be a JSON object (the tool\'s input)');
  const callId = raw['call_id'] ?? randomUUID();
  if (typeof callId !== 'string' || callId.length === 0 || callId.length > 200) {
    throw new Error('"call_id" must be a non-empty string of at most 200 characters');
  }
  const cb = raw['callback'];
  const workdir = raw['workdir'];
  if (
    workdir !== undefined &&
    workdir !== null &&
    (typeof workdir !== 'string' || workdir === '')
  ) {
    throw new Error('"workdir" must be a non-empty path');
  }
  const base = { input, callId, ...(typeof workdir === 'string' ? { workdir } : {}) };
  if (cb === undefined) return base;
  if (!isRecord(cb) || typeof cb['url'] !== 'string') {
    throw new Error('"callback" must be { "url": string, "token"?: string }');
  }
  let target: URL;
  try {
    target = new URL(cb['url']);
  } catch {
    throw new Error('"callback.url" is not a valid URL');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('"callback.url" must be http(s)');
  }
  // The caller already holds the token and can run tools; what a remote
  // callback adds is an outbound request to any host this machine can reach.
  // Keep that an explicit operator decision.
  if (!allowRemoteCallbacks && !isLoopbackHost(target.hostname.replace(/^\[(.*)\]$/, '$1'))) {
    throw new Error(
      '"callback.url" must be a loopback address (start the server with --allow-remote-callbacks)',
    );
  }
  const token = cb['token'];
  if (token !== undefined && typeof token !== 'string')
    throw new Error('"callback.token" must be a string');
  return { ...base, callback: { url: target.toString(), token } };
}

/**
 * A caller's `workdir` becomes the call's working directory only inside the
 * served project: compared after resolving symlinks, so a link that points out
 * of the tree cannot move shell commands outside it. Relative paths resolve
 * against the project root.
 */
async function resolveWorkdir(
  workdir: string,
  projectRoot: string,
): Promise<{ cwd: string } | { error: string }> {
  let root: string;
  let target: string;
  try {
    root = await realpath(projectRoot);
    target = await realpath(path.resolve(projectRoot, workdir));
  } catch {
    return { error: `workdir "${workdir}" does not exist on the WrongStack side` };
  }
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(fold(root), fold(target));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      error: `workdir "${workdir}" is outside the project this server serves (${root}); start \`wstack tools serve\` in the task's directory`,
    };
  }
  return { cwd: target };
}

function readBody(req: IncomingMessage): Promise<string | 'too_large'> {
  return new Promise((resolve, reject) => {
    // Raw chunks, decoded once: a chunk can end inside a multi-byte character.
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.byteLength;
      if (size > BODY_CAP_BYTES) {
        tooLarge = true;
        resolve('too_large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    // This endpoint executes tools: nothing about it should be embedded,
    // sniffed into another type, or leak its URL onward. No CORS headers.
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
