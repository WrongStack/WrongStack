import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expectDefined, toErrorMessage, validateAgainstSchema } from '@wrongstack/core/utils';
import { MCP_CONSTANTS } from './constants.js';
import type { MCPPromptArgument, MCPPromptMessage, MCPResourceContents } from './protocol.js';
/**
 * Server-side MCP. The mirror image of `MCPClient`: instead of consuming a
 * remote MCP server, this lets WrongStack *be* an MCP server — exposing its
 * tools to any MCP client (Claude Desktop, another agent, an IDE) over a
 * JSON-RPC 2.0 stream.
 *
 * The protocol core (`MCPServer`) is transport-agnostic: feed it a raw JSON
 * line via `handleMessage`, get back a response string (or `null` for
 * notifications). `serveStdio` wires it to stdin/stdout for the canonical
 * stdio transport.
 */

/** A tool descriptor advertised over `tools/list`. */
export interface MCPServerTool {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

/** The result of a `tools/call`, as the host produces it. */
export interface MCPServerCallResult {
  /** Text or pre-built MCP content blocks. Strings are wrapped as a text block. */
  content: unknown;
  isError: boolean;
}

/**
 * Bridges the MCP server to a tool backend (in the CLI, the `ToolRegistry`).
 * Kept narrow so the protocol core has no dependency on `@wrongstack/core`.
 */
export interface MCPServerToolHost {
  listTools(): MCPServerTool[] | Promise<MCPServerTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<MCPServerCallResult>;
}

export interface MCPServerResource {
  uri: string;
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  mimeType?: string | undefined;
  size?: number | undefined;
  contents: MCPResourceContents[];
}

export interface MCPServerPrompt {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  arguments?: MCPPromptArgument[] | undefined;
  /** Static rich messages, or a text template using {{argument}} placeholders. */
  messages?: MCPPromptMessage[] | undefined;
  template?: string | undefined;
}

export interface MCPServerLogger {
  warn?(msg: string): void;
  info?(msg: string): void;
}

export interface MCPServerOptions {
  host: MCPServerToolHost;
  /** Advertised in the `initialize` handshake. Defaults to the wrongstack identity. */
  serverInfo?: { name: string; version: string };
  logger?: MCPServerLogger | undefined;
  /** Explicit allowlist only; omitted means this server exposes no resources. */
  resources?: MCPServerResource[] | undefined;
  /** Explicit allowlist only; omitted means this server exposes no prompts. */
  prompts?: MCPServerPrompt[] | undefined;
}

interface JsonRpcRequest {
  jsonrpc?: string | undefined;
  id?: number | string | null | undefined;
  method?: string | undefined;
  params?: unknown | undefined;
}

// JSON-RPC 2.0 reserved error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export class MCPServer {
  private readonly host: MCPServerToolHost;
  private readonly serverInfo: { name: string; version: string };
  private readonly logger?: MCPServerLogger | undefined;
  private readonly resources: MCPServerResource[];
  private readonly prompts: MCPServerPrompt[];

  constructor(opts: MCPServerOptions) {
    this.host = opts.host;
    this.serverInfo = opts.serverInfo ?? {
      name: MCP_CONSTANTS.CLIENT_INFO.name,
      version: MCP_CONSTANTS.CLIENT_INFO.version,
    };
    this.logger = opts.logger;
    this.resources = structuredClone(opts.resources ?? []);
    this.prompts = structuredClone(opts.prompts ?? []);
  }

  /**
   * Handle one raw JSON-RPC line. Returns the response JSON string for
   * requests, or `null` for notifications (no `id`) and for blank input —
   * the caller should write the string to its output stream when non-null.
   */
  async handleMessage(raw: string): Promise<string | null> {
    const line = raw.trim();
    if (!line) return null;

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return this.encodeError(null, PARSE_ERROR, 'Parse error');
    }

    if (typeof msg !== 'object' || msg === null || typeof msg.method !== 'string') {
      const id = msg && typeof msg === 'object' ? (msg.id ?? null) : null;
      return this.encodeError(id ?? null, INVALID_REQUEST, 'Invalid Request');
    }

    const isNotification = msg.id === undefined || msg.id === null;

    // Notifications never get a response. We still dispatch known ones for
    // side effects, but `notifications/initialized` is purely a handshake ack.
    if (isNotification) {
      return null;
    }

    try {
      const result = await this.dispatch(msg.method, msg.params);
      if (result === METHOD_NOT_FOUND_SENTINEL) {
        return this.encodeError(
          expectDefined(msg.id),
          METHOD_NOT_FOUND,
          `Method not found: ${msg.method}`,
        );
      }
      return JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      const message = toErrorMessage(err);
      this.logger?.warn?.(`MCP server: method "${msg.method}" threw: ${message}`);
      // A schema violation is the caller's fault, not ours — JSON-RPC has a
      // code for exactly that, and clients retry differently on it (WS-026).
      const code = err instanceof InvalidToolArgumentsError ? INVALID_PARAMS : INTERNAL_ERROR;
      return this.encodeError(expectDefined(msg.id), code, message);
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: MCP_CONSTANTS.PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            ...(this.resources.length > 0
              ? { resources: { subscribe: false, listChanged: false } }
              : {}),
            ...(this.prompts.length > 0 ? { prompts: { listChanged: false } } : {}),
          },
          serverInfo: this.serverInfo,
        };
      case 'ping':
        return {};
      case 'tools/list': {
        const tools = await this.host.listTools();
        return { tools };
      }
      case 'tools/call': {
        const p = (params ?? {}) as { name?: unknown | undefined; arguments?: unknown | undefined };
        if (typeof p.name !== 'string') {
          throw new Error('tools/call requires a string "name"');
        }
        const args =
          p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments)
            ? (p.arguments as Record<string, unknown>)
            : {};
        await this.assertArgumentsMatchSchema(p.name, args);
        const res = await this.host.callTool(p.name, args);
        return { content: toContentBlocks(res.content), isError: res.isError };
      }
      case 'resources/list': {
        if (this.resources.length === 0) return METHOD_NOT_FOUND_SENTINEL;
        const page = paginate(this.resources, params);
        return {
          resources: page.items.map(({ contents: _contents, ...resource }) => resource),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      }
      case 'resources/templates/list':
        if (this.resources.length === 0) return METHOD_NOT_FOUND_SENTINEL;
        return { resourceTemplates: [] };
      case 'resources/read': {
        if (this.resources.length === 0) return METHOD_NOT_FOUND_SENTINEL;
        const uri = requiredParamString(params, 'uri', 'resources/read');
        const resource = this.resources.find((candidate) => candidate.uri === uri);
        if (!resource) throw new Error(`Resource not found: ${uri}`);
        return { contents: structuredClone(resource.contents) };
      }
      case 'prompts/list': {
        if (this.prompts.length === 0) return METHOD_NOT_FOUND_SENTINEL;
        const page = paginate(this.prompts, params);
        return {
          prompts: page.items.map(
            ({ messages: _messages, template: _template, ...prompt }) => prompt,
          ),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      }
      case 'prompts/get': {
        if (this.prompts.length === 0) return METHOD_NOT_FOUND_SENTINEL;
        const name = requiredParamString(params, 'name', 'prompts/get');
        const prompt = this.prompts.find((candidate) => candidate.name === name);
        if (!prompt) throw new Error(`Prompt not found: ${name}`);
        const input = paramsRecord(params);
        const args = stringRecord(input['arguments'], 'prompts/get arguments');
        for (const argument of prompt.arguments ?? []) {
          if (argument.required && args[argument.name] === undefined) {
            throw new Error(`Prompt "${name}" requires argument "${argument.name}"`);
          }
        }
        const messages = prompt.template
          ? [
              {
                role: 'user' as const,
                content: { type: 'text', text: renderPromptTemplate(prompt.template, args) },
              },
            ]
          : structuredClone(prompt.messages ?? []);
        return { description: prompt.description, messages };
      }
      default:
        return METHOD_NOT_FOUND_SENTINEL;
    }
  }

  /**
   * WS-026: enforce the `inputSchema` this server advertises on `tools/list`.
   *
   * `tools/call` used to forward `params.arguments` to the host verbatim after
   * checking only that it was a non-array object — so every `enum`, `required`,
   * `additionalProperties: false`, and numeric bound in the published schema
   * was advisory. A client (or an attacker who reached the transport) could
   * send `{mode: "../../etc"}` to a tool whose schema declares
   * `enum: ["read","write"]` and the tool would receive it. Publishing a
   * contract and not enforcing it is worse than publishing none: downstream
   * tools are written against the schema they declared.
   *
   * SCOPE: `validateAgainstSchema` is the shared validator that also gates the
   * agent's own tool executor. It checks `type`, `enum`, and `required`, and
   * recurses through `properties`/`items` — it does NOT check
   * `additionalProperties: false`, numeric bounds, or string lengths. So those
   * keywords stay advisory here. Teaching the shared validator about them
   * would change what the agent accepts on every tool call in the product,
   * which is a deliberate decision that does not belong inside a transport
   * fix; it is tracked separately.
   *
   * Unknown tool names are left alone — the host owns that error, and
   * answering "no such tool" here would fork the message for no benefit.
   */
  private async assertArgumentsMatchSchema(
    name: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    let tools: MCPServerTool[];
    try {
      tools = await this.host.listTools();
    } catch {
      // A host that cannot enumerate its tools is a host problem; let the
      // call through so the real failure surfaces from `callTool`.
      return;
    }
    const schema = tools.find((tool) => tool.name === name)?.inputSchema;
    if (!schema || typeof schema !== 'object') return;
    const result = validateAgainstSchema(
      args,
      schema as Parameters<typeof validateAgainstSchema>[1],
    );
    if (result.ok) return;
    const detail = result.errors
      .slice(0, MAX_REPORTED_SCHEMA_ERRORS)
      .map((error) => `${error.path || '(root)'}: ${error.message}`)
      .join('; ');
    const more =
      result.errors.length > MAX_REPORTED_SCHEMA_ERRORS
        ? ` (+${result.errors.length - MAX_REPORTED_SCHEMA_ERRORS} more)`
        : '';
    throw new InvalidToolArgumentsError(`invalid arguments for tool "${name}" — ${detail}${more}`);
  }

  private encodeError(id: number | string | null, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  }
}

/** Cap on how many schema violations are echoed back in one error message. */
const MAX_REPORTED_SCHEMA_ERRORS = 5;

/**
 * Marks a `tools/call` rejected by {@link MCPServer.assertArgumentsMatchSchema}
 * so `handleMessage` can answer with JSON-RPC `-32602 Invalid params` rather
 * than the generic internal-error code every other throw maps to.
 */
export class InvalidToolArgumentsError extends Error {
  override readonly name = 'InvalidToolArgumentsError';
}

const SERVER_PAGE_SIZE = 100;

function paginate<T>(items: T[], params: unknown): { items: T[]; nextCursor?: string | undefined } {
  const cursor = paramsRecord(params)['cursor'];
  let offset = 0;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || !/^\d+$/.test(cursor)) {
      throw new Error('MCP pagination cursor must be a non-negative integer string');
    }
    offset = Number(cursor);
    if (!Number.isSafeInteger(offset)) throw new Error('MCP pagination cursor is too large');
  }
  const page = items.slice(offset, offset + SERVER_PAGE_SIZE);
  const next = offset + page.length;
  return {
    items: page,
    ...(next < items.length ? { nextCursor: String(next) } : {}),
  };
}

function paramsRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function requiredParamString(params: unknown, field: string, method: string): string {
  const value = paramsRecord(params)[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${method} requires a non-empty string "${field}"`);
  }
  return value;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') throw new Error(`${label}.${key} must be a string`);
    result[key] = item;
  }
  return result;
}

function renderPromptTemplate(template: string, args: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z_][A-Za-z0-9_.-]*)\}\}/g, (_match, name: string) => {
    const value = args[name];
    if (value === undefined) throw new Error(`Missing prompt template argument "${name}"`);
    return value;
  });
}

const METHOD_NOT_FOUND_SENTINEL = Symbol('method-not-found');

/** Normalize a host result's content into MCP content blocks. */
export function toContentBlocks(content: unknown): Array<{ type: 'text'; text: string }> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) {
    // Already-shaped content blocks pass through; otherwise stringify each item.
    const allBlocks = content.every(
      (c) => c && typeof c === 'object' && (c as { type?: unknown | undefined }).type === 'text',
    );
    if (allBlocks) return content as Array<{ type: 'text'; text: string }>;
    return [{ type: 'text', text: content.map((c) => stringifyItem(c)).join('\n') }];
  }
  if (content === undefined || content === null) return [{ type: 'text', text: '' }];
  return [{ type: 'text', text: stringifyItem(content) }];
}

function stringifyItem(c: unknown): string {
  if (typeof c === 'string') return c;
  try {
    return JSON.stringify(c);
  } catch {
    return String(c);
  }
}

export interface ServeStdioHandle {
  /** Stop reading and detach listeners. Does not exit the process. */
  close(): void;
  /** Resolves when the input stream ends (EOF). */
  done: Promise<void>;
}

export interface ServeStdioOptions {
  stdin?: NodeJS.ReadableStream | undefined;
  stdout?: NodeJS.WritableStream | undefined;
}

/**
 * Run an `MCPServer` over stdio: newline-delimited JSON-RPC in on stdin,
 * responses out on stdout. CRITICAL: nothing else may write to stdout while
 * this runs — it is the JSON-RPC channel. Route all logging to stderr.
 */
export function serveStdio(server: MCPServer, opts: ServeStdioOptions = {}): ServeStdioHandle {
  const stdin: NodeJS.ReadableStream = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  let buffer = '';
  let closed = false;
  let bufferTooLarge = false;
  // Serialize writes so concurrent async handlers don't interleave lines.
  let writeChain: Promise<void> = Promise.resolve();
  const inFlightHandlers = new Set<Promise<void>>();

  const writeLine = (s: string) => {
    writeChain = writeChain
      .then(
        () =>
          new Promise<void>((resolve) => {
            stdout.write(`${s}\n`, () => resolve());
          }),
      )
      .catch((err) => {
        const msg = toErrorMessage(err);
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'mcp_server.stdout_write_failed',
            message: msg,
            timestamp: new Date().toISOString(),
          }),
        );
      });
  };

  const onData = (chunk: Buffer | string) => {
    // A misbehaving peer that streams bytes forever without `\n` would
    // otherwise balloon `buffer` indefinitely. Mirror the HTTP body cap
    // (`HTTP_BODY_CAP` below) — once exceeded, abandon the line, drop the
    // unread tail, and shut down so the caller can react.
    if (bufferTooLarge) return;
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (buffer.length > HTTP_BODY_CAP) {
      bufferTooLarge = true;
      buffer = '';
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'mcp_server.line_buffer_overflow',
          message: `stdio line exceeded ${HTTP_BODY_CAP} bytes without newline — aborting stream`,
          timestamp: new Date().toISOString(),
        }),
      );
      // Pause and tear down further reads so the caller sees a clean end.
      // `destroy()` is called WITHOUT an error so the stream's 'error' event
      // isn't emitted (PassThrough/mocked streams would otherwise emit
      // unhandled 'error' that callers must drain).
      try {
        (stdin as { pause?: () => void }).pause?.();
        (stdin as { destroy?: () => void }).destroy?.();
      } catch {
        /* ignore */
      }
      onEnd();
      return;
    }
    let start = 0;
    let idx = buffer.indexOf('\n', start);
    while (idx !== -1) {
      let end = idx;
      if (end > start && buffer.charCodeAt(end - 1) === 13 /* \r */) end--;
      const line = buffer.slice(start, end);
      start = idx + 1;
      idx = buffer.indexOf('\n', start);
      if (!line.trim()) continue;
      const handler = server
        .handleMessage(line)
        .then((res) => {
          // Always flush responses for in-flight requests, even after
          // the stream ended: `done` waits on writeChain, so dropping a
          // late response here would mean `done` resolves without that
          // line ever landing on stdout. Stopping new reads is `onEnd`'s
          // job — not gating writes.
          if (res !== null) writeLine(res);
        })
        .catch((err) => {
          // Malformed JSON from a peer — log and continue so one bad line
          // doesn't kill the entire session.
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'mcp_server.handle_message_failed',
              message: toErrorMessage(err),
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .finally(() => {
          inFlightHandlers.delete(handler);
        });
      inFlightHandlers.add(handler);
    }
    if (start > 0) buffer = buffer.slice(start);
  };

  let resolveDone!: () => void;
  // `done` resolves once the stream has closed, every async request handler
  // has settled, and its resulting writes have drained. Waiting only on the
  // current writeChain is insufficient: a slow handler may enqueue its write
  // after stdin has already emitted `end`.
  const done = new Promise<void>((resolve) => {
    resolveDone = () => {
      void Promise.allSettled([...inFlightHandlers])
        .then(() => writeChain)
        .then(() => resolve());
    };
  });

  const onEnd = () => {
    if (closed) return;
    closed = true;
    stdin.off('data', onData);
    if (!bufferTooLarge && buffer.trim()) {
      const line = buffer.trim();
      buffer = '';
      const handler = server
        .handleMessage(line)
        .then((res) => {
          if (res !== null) writeLine(res);
        })
        .catch((err) => {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'mcp_server.handle_message_failed',
              message: toErrorMessage(err),
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .finally(() => {
          inFlightHandlers.delete(handler);
        });
      inFlightHandlers.add(handler);
    }
    resolveDone();
  };

  stdin.on('data', onData);
  stdin.once('end', onEnd);
  stdin.once('close', onEnd);
  if (typeof (stdin as { resume?: () => void }).resume === 'function') {
    (stdin as { resume: () => void }).resume();
  }

  return {
    close: () => {
      onEnd();
    },
    done,
  };
}

// ── HTTP transport ──────────────────────────────────────────────────────────

const HTTP_BODY_CAP = 4 * 1024 * 1024; // 4 MiB

export interface ServeHttpOptions {
  /** TCP port. 0 picks an ephemeral port (resolved in the handle). Default 0. */
  port?: number | undefined;
  /** Bind address. Default '127.0.0.1' (loopback only). */
  host?: string | undefined;
  /**
   * Bearer token required on every request (`Authorization: Bearer <token>`).
   * REQUIRED when binding to a non-loopback host — `serveHttp` refuses to
   * expose tools to the network without one.
   */
  token?: string | undefined;
  logger?: MCPServerLogger | undefined;
}

export interface ServeHttpHandle {
  port: number;
  host: string;
  url: string;
  close(): Promise<void>;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * Run an `MCPServer` over HTTP: POST a single JSON-RPC request, get the JSON
 * response (notifications → 202 with no body). Reuses `handleMessage`, so the
 * protocol is identical to the stdio transport.
 *
 * Security: binds to loopback by default. Binding to any other host (e.g.
 * `0.0.0.0`) REQUIRES a `token` — otherwise this rejects, because it would
 * otherwise expose tool execution to the whole network unauthenticated.
 */
export function serveHttp(
  server: MCPServer,
  opts: ServeHttpOptions = {},
): Promise<ServeHttpHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const token = opts.token;
  const log = opts.logger;

  if (!isLoopbackHost(host) && !token) {
    return Promise.reject(
      new Error(
        `serveHttp: refusing to bind to non-loopback host "${host}" without a token — ` +
          'pass a token to expose tools to the network, or bind to 127.0.0.1.',
      ),
    );
  }

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleHttpRequest(server, req, res, token, log, host);
  });

  return new Promise<ServeHttpHandle>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      const boundPort = (httpServer.address() as AddressInfo).port;
      const displayHost = host === '::1' ? '[::1]' : host;
      resolve({
        port: boundPort,
        host,
        url: `http://${displayHost}:${boundPort}/`,
        close: () =>
          new Promise<void>((res2) => {
            httpServer.close(() => res2());
          }),
      });
    });
  });
}

async function handleHttpRequest(
  server: MCPServer,
  req: IncomingMessage,
  res: ServerResponse,
  token: string | undefined,
  log: MCPServerLogger | undefined,
  boundHost: string,
): Promise<void> {
  const send = (status: number, body: string, type = 'application/json') => {
    res.writeHead(status, {
      'content-type': type,
      // This endpoint executes tools. Nothing about it should be embedded,
      // sniffed into another type, or leak its URL onward.
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      // No CORS headers are ever emitted: a cross-origin reader must not be
      // able to see a response even if it manages to send the request.
    });
    res.end(body);
  };

  // WS-024: a browser on any site can reach a loopback port. Two guards run
  // before anything else, on every method:
  //
  //  - Origin. Browsers attach it to every cross-origin request and cannot
  //    forge it. A foreign origin is refused outright. A same-origin one is
  //    accepted; a missing one is accepted because non-browser MCP clients
  //    (the actual audience for this transport) never send it.
  //  - Host. Pinned to the bound authority so a DNS-rebinding name that
  //    resolves to 127.0.0.1 cannot be used to turn a foreign page into a
  //    same-origin one.
  if (!originIsAcceptable(req, boundHost)) {
    return send(403, JSON.stringify({ error: 'cross-origin forbidden' }));
  }
  if (!hostHeaderIsAcceptable(req, boundHost)) {
    return send(403, JSON.stringify({ error: 'untrusted host header' }));
  }

  // WS-024: the token check used to sit AFTER this branch, so `GET` on any
  // path answered 200 with the server identity to an unauthenticated caller.
  if (token && !bearerTokenMatches(req.headers.authorization, token)) {
    return send(401, JSON.stringify({ error: 'unauthorized' }));
  }

  // Health probe.
  if (req.method === 'GET') {
    return send(200, JSON.stringify({ status: 'ok', server: 'wrongstack-mcp' }));
  }
  if (req.method !== 'POST') {
    return send(405, JSON.stringify({ error: 'method not allowed' }));
  }
  // WS-024: `application/json` is not a CORS-simple content type, so requiring
  // it means a cross-origin POST must clear a preflight this server never
  // answers. Without it, a page could drive tool execution with a `text/plain`
  // form-style POST that no preflight ever gates.
  if (!isJsonContentType(req.headers['content-type'])) {
    return send(415, JSON.stringify({ error: 'content-type must be application/json' }));
  }

  let body = '';
  let aborted = false;
  req.on('data', (chunk: Buffer) => {
    if (aborted) return;
    body += chunk.toString('utf8');
    if (body.length > HTTP_BODY_CAP) {
      aborted = true;
      send(413, JSON.stringify({ error: 'payload too large' }));
      req.destroy();
    }
  });
  req.on('end', () => {
    if (aborted) return;
    void server
      .handleMessage(body)
      .then((out) => {
        if (aborted) return;
        // Notifications produce no response body.
        if (out === null) return send(202, '');
        return send(200, out);
      })
      .catch((err) => {
        if (aborted) return;
        log?.warn?.(`MCP http handler error: ${toErrorMessage(err)}`);
        send(500, JSON.stringify({ error: 'internal error' }));
      });
  });
}

// ── WS-024: transport guards ───────────────────────────────────────────────

/** Hostnames that always denote this machine, regardless of the bind address. */
function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return bare === 'localhost' || bare === '::1' || bare === '127.0.0.1' || bare.startsWith('127.');
}

/**
 * Reject a request whose `Origin` names a site other than this server.
 *
 * A missing `Origin` is accepted: the clients this transport exists for
 * (Claude Desktop, IDE extensions, `curl`) are not browsers and never send
 * one. A browser, which is the threat here, always attaches it on a
 * cross-origin request and cannot forge it.
 */
function originIsAcceptable(req: IncomingMessage, boundHost: string): boolean {
  const origin = req.headers.origin;
  if (origin === undefined || origin === 'null') return origin === undefined;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const rawHost = req.headers.host?.trim();
  if (!rawHost) return false;
  try {
    // Same-origin means the Origin's authority equals the one the request was
    // actually addressed to — which `hostHeaderIsAcceptable` separately pins
    // to the bind address, so the two together leave no gap.
    const requestAuthority = new URL(`${parsed.protocol}//${rawHost}`).host.toLowerCase();
    if (parsed.host.toLowerCase() !== requestAuthority) return false;
  } catch {
    return false;
  }
  // A loopback bind is only ever addressable as this machine.
  return isLoopbackHost(boundHost) ? isLoopbackHostname(parsed.hostname) : true;
}

/**
 * Pin the `Host` header to the bound address. Without this, an attacker
 * registers `evil.example → 127.0.0.1`, gets a victim's browser to load a page
 * there, and every request is same-origin by the browser's reckoning while
 * landing on this server (DNS rebinding).
 */
function hostHeaderIsAcceptable(req: IncomingMessage, boundHost: string): boolean {
  const rawHost = req.headers.host?.trim();
  if (!rawHost) return false;
  let parsed: URL;
  try {
    parsed = new URL(`http://${rawHost}`);
  } catch {
    return false;
  }
  // A bare authority only — userinfo, a path, or a query means something is
  // trying to smuggle structure through the header.
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search) return false;
  if (isLoopbackHost(boundHost)) return isLoopbackHostname(parsed.hostname);
  // A non-loopback bind is an explicit operator decision and requires a token
  // (see `serveHttp`), so the hostname is theirs to choose.
  return true;
}

/** `application/json`, with or without parameters such as `; charset=utf-8`. */
function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const base = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return base === 'application/json' || base.endsWith('+json');
}

/**
 * Constant-time bearer comparison. `auth !== expected` short-circuits on the
 * first differing byte, which leaks the token prefix to a caller that can time
 * responses — and a local attacker can time them very precisely.
 */
function bearerTokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const supplied = Buffer.from(header ?? '');
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}
