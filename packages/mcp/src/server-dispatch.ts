import { expectDefined, toErrorMessage, validateAgainstSchema } from '@wrongstack/core/utils';
import {
  MCP_CONSTANTS,
  negotiateProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './constants.js';
import type { MCPToolAnnotations } from './contracts.js';
import { validateModernHeaders } from './modern-http-headers.js';
import {
  CAPABILITIES_META,
  hasModernMetadata,
  INFO_META,
  MODERN_PROTOCOL_VERSION,
  objectRecord,
  requestVersion,
} from './modern-protocol.js';
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
  /**
   * `ToolAnnotations` (spec 2025-03-26) — this server's own claim about its
   * behaviour, published verbatim by `tools/list`. A client MUST treat it as
   * untrusted, so publishing it never relaxes anything on our side: the
   * permission tier of a proxied tool comes from WrongStack policy, not from a
   * hint in this object.
   */
  annotations?: MCPToolAnnotations | undefined;
  /**
   * Client-specific extensions, published verbatim. E.g. Claude Code reads
   * `"anthropic/alwaysLoad": true` to load a tool upfront instead of behind
   * its tool search.
   */
  _meta?: Record<string, unknown> | undefined;
}

/** The result of a `tools/call`, as the host produces it. */
export interface MCPServerCallResult {
  /** Text or pre-built MCP content blocks. Strings are wrapped as a text block. */
  content: unknown;
  isError: boolean;
  /** Client-facing metadata, separate from model content. */
  _meta?: Record<string, unknown> | undefined;
}

/**
 * Bridges the MCP server to a tool backend (in the CLI, the `ToolRegistry`).
 * Kept narrow so the protocol core has no dependency on `@wrongstack/core`.
 */
export interface MCPServerToolHost {
  listTools(): MCPServerTool[] | Promise<MCPServerTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<MCPServerCallResult>;
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
  /**
   * `InitializeResult.instructions`: how and when to use this server. Clients
   * that honour it (Claude Code does) put it in front of the model.
   */
  instructions?: string | undefined;
}

export interface JsonRpcRequest {
  jsonrpc?: string | undefined;
  id?: number | string | null | undefined;
  method?: string | undefined;
  params?: unknown | undefined;
}

// JSON-RPC 2.0 reserved error codes.
export const PARSE_ERROR = -32700;

export const INVALID_REQUEST = -32600;

export const METHOD_NOT_FOUND = -32601;

export const INVALID_PARAMS = -32602;

export const INTERNAL_ERROR = -32603;

export class MCPServer {
  private readonly host: MCPServerToolHost;
  private readonly serverInfo: { name: string; version: string };
  private readonly logger?: MCPServerLogger | undefined;
  private readonly resources: MCPServerResource[];
  private readonly prompts: MCPServerPrompt[];
  private readonly instructions: string | undefined;
  private readonly inFlightRequests = new Map<number | string | symbol, AbortController>();

  constructor(opts: MCPServerOptions) {
    this.host = opts.host;
    this.serverInfo = opts.serverInfo ?? {
      name: MCP_CONSTANTS.CLIENT_INFO.name,
      version: MCP_CONSTANTS.CLIENT_INFO.version,
    };
    this.logger = opts.logger;
    this.instructions = opts.instructions?.trim() || undefined;
    this.resources = structuredClone(opts.resources ?? []);
    this.prompts = structuredClone(opts.prompts ?? []);
  }

  async validateHttpHeaders(method: string, params: unknown, headers: Headers): Promise<void> {
    const name = objectRecord(params)?.['name'];
    const schema =
      method === 'tools/call'
        ? (await this.host.listTools()).find((tool) => tool.name === name)?.inputSchema
        : undefined;
    validateModernHeaders(method, params, headers, schema);
  }

  /**
   * Handle one raw JSON-RPC line. Returns the response JSON string for
   * requests, or `null` for notifications (no `id`) and for blank input —
   * the caller should write the string to its output stream when non-null.
   */
  async handleMessage(raw: string, options?: { signal?: AbortSignal }): Promise<string | null> {
    const line = raw.trim();
    if (!line) return null;

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return this.encodeError(null, PARSE_ERROR, 'Parse error');
    }

    const validId =
      msg?.id === undefined ||
      msg.id === null ||
      typeof msg.id === 'string' ||
      typeof msg.id === 'number';
    if (
      typeof msg !== 'object' ||
      msg === null ||
      msg.jsonrpc !== '2.0' ||
      typeof msg.method !== 'string' ||
      !validId
    ) {
      const id = validId && msg && typeof msg === 'object' ? (msg.id ?? null) : null;
      return this.encodeError(id ?? null, INVALID_REQUEST, 'Invalid Request');
    }

    const isNotification = msg.id === undefined || msg.id === null;

    // Notifications never get a response. We still dispatch known ones for
    // side effects, but `notifications/initialized` is purely a handshake ack.
    if (isNotification) {
      if (msg.method === 'notifications/cancelled') {
        const input = paramsRecord(msg.params);
        const requestId = input['requestId'];
        if (typeof requestId === 'number' || typeof requestId === 'string') {
          const reason =
            typeof input['reason'] === 'string' && input['reason'].trim().length > 0
              ? input['reason'].trim().slice(0, 500)
              : 'MCP request cancelled by client';
          this.inFlightRequests.get(requestId)?.abort(new Error(reason));
        }
      }
      return null;
    }

    const requestId = expectDefined(msg.id);
    const version = requestVersion(msg.params);
    const modern = hasModernMetadata(msg.params);
    if (modern && typeof version !== 'string')
      return this.encodeError(
        requestId,
        INVALID_PARAMS,
        'Missing or invalid protocol version metadata',
      );
    if (modern && version !== MODERN_PROTOCOL_VERSION) {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: -32022,
          message: 'Unsupported protocol version',
          data: {
            supported: [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS],
            requested: version,
          },
        },
      });
    }
    if (modern) {
      const meta = objectRecord(objectRecord(msg.params)?.['_meta']);
      const info = objectRecord(meta?.[INFO_META]);
      if (
        !info ||
        typeof info['name'] !== 'string' ||
        typeof info['version'] !== 'string' ||
        !info['name'] ||
        !info['version'] ||
        !objectRecord(meta?.[CAPABILITIES_META])
      )
        return this.encodeError(
          requestId,
          INVALID_PARAMS,
          'Modern requests require clientInfo and clientCapabilities metadata',
        );
      if (msg.method === 'initialize')
        return this.encodeError(
          requestId,
          METHOD_NOT_FOUND,
          'Modern MCP requests do not use initialize',
        );
    }
    const controller = new AbortController();
    const abort = () => controller.abort(options?.signal?.reason);
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();
    // Modern HTTP has request-scoped cancellation and no shared session IDs.
    const requestKey = options?.signal ? Symbol() : requestId;
    // One id has one abort handle. A retry that reuses the id must not orphan
    // the call already running under it: cancellation is keyed only by id.
    const displaced = this.inFlightRequests.get(requestKey);
    this.inFlightRequests.set(requestKey, controller);
    displaced?.abort(new Error('MCP request id reused by a newer in-flight call'));
    try {
      controller.signal.throwIfAborted();
      const result = await this.dispatch(msg.method, msg.params, controller.signal);
      if (result === METHOD_NOT_FOUND_SENTINEL) {
        return this.encodeError(requestId, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
      }
      return JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: modern ? { ...objectRecord(result), resultType: 'complete' } : result,
      });
    } catch (err) {
      const message = toErrorMessage(err);
      this.logger?.warn?.(`MCP server: method "${msg.method}" threw: ${message}`);
      // SEP-1303: an argument that violates the advertised `inputSchema` is
      // feedback the model can act on, so it goes back as a tool-execution
      // error (`isError: true` in the result), not a protocol error — a
      // JSON-RPC error stays inside the transport and never reaches the model.
      // The warn above still fires, so the server-side audit trail for the
      // probe traffic this gate exists to catch is kept.
      if (err instanceof InvalidToolArgumentsError) {
        return JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          result: {
            ...(modern ? { resultType: 'complete' } : {}),
            content: [{ type: 'text', text: message }],
            isError: true,
          },
        });
      }
      // Anything in the InvalidParamsError family is the caller's request
      // error, not our failure — JSON-RPC has a code for exactly that, and
      // clients key their retry policy off the difference.
      const code = err instanceof InvalidParamsError ? INVALID_PARAMS : INTERNAL_ERROR;
      return this.encodeError(requestId, code, message);
    } finally {
      options?.signal?.removeEventListener('abort', abort);
      if (this.inFlightRequests.get(requestKey) === controller) {
        this.inFlightRequests.delete(requestKey);
      }
    }
  }

  private async dispatch(
    method: string,
    params: unknown,
    signal?: AbortSignal | undefined,
  ): Promise<unknown> {
    switch (method) {
      case 'server/discover':
        return {
          resultType: 'complete',
          supportedVersions: [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS],
          capabilities: {
            tools: {},
            ...(this.resources.length ? { resources: {} } : {}),
            ...(this.prompts.length ? { prompts: {} } : {}),
          },
          _meta: { 'io.modelcontextprotocol/serverInfo': this.serverInfo },
          ...(this.instructions ? { instructions: this.instructions } : {}),
        };
      case 'initialize':
        return {
          protocolVersion: negotiateProtocolVersion(
            (params as { protocolVersion?: unknown } | undefined)?.protocolVersion,
          ),
          capabilities: {
            tools: { listChanged: false },
            ...(this.resources.length > 0
              ? { resources: { subscribe: false, listChanged: false } }
              : {}),
            ...(this.prompts.length > 0 ? { prompts: { listChanged: false } } : {}),
          },
          serverInfo: this.serverInfo,
          ...(this.instructions ? { instructions: this.instructions } : {}),
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
          throw new InvalidParamsError('tools/call requires a string "name"');
        }
        const args =
          p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments)
            ? (p.arguments as Record<string, unknown>)
            : {};
        await this.assertArgumentsMatchSchema(p.name, args);
        signal?.throwIfAborted();
        const res = await this.host.callTool(p.name, args, { signal });
        return {
          content: toContentBlocks(res.content),
          isError: res.isError,
          ...(res._meta ? { _meta: res._meta } : {}),
        };
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
        if (!resource) throw new InvalidLookupError(`Resource not found: ${uri}`);
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
        if (!prompt) throw new InvalidLookupError(`Prompt not found: ${name}`);
        const input = paramsRecord(params);
        const args = stringRecord(input['arguments'], 'prompts/get arguments');
        for (const argument of prompt.arguments ?? []) {
          if (argument.required && !Object.hasOwn(args, argument.name)) {
            // prompts.md: "Missing required arguments: -32602 (Invalid params)".
            throw new InvalidParamsError(`Prompt "${name}" requires argument "${argument.name}"`);
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
   * agent's own tool executor. It checks `type`, `enum`, `required`, recurses
   * through `properties`/`items`, enforces numeric bounds
   * (`minimum`/`maximum`), rejects unknown keys on strict-closed objects
   * (`additionalProperties: false`), validates the `additionalProperties`
   * subschema form against unknown-key values, applies `patternProperties`
   * to matching keys, enforces string lengths (`minLength`/`maxLength`) and
   * `pattern`, array lengths (`minItems`/`maxItems`/`uniqueItems`), and the
   * combinators `allOf`/`anyOf`/`oneOf` (all landed 2026-09-11). Still
   * advisory per the 2026-09-11 usage survey: `const` and `$ref` — declared
   * only in the techstack rulebook, which validates with its own
   * `validateRulebook`, not this validator.
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
export const MAX_REPORTED_SCHEMA_ERRORS = 5;

/**
 * Marks a `tools/call` rejected by {@link MCPServer.assertArgumentsMatchSchema}.
 * SEP-1303: `handleMessage` answers these in-band — `{ content, isError: true }`
 * — so the model sees the refusal and can retry with corrected arguments,
 * instead of a JSON-RPC error that stays inside the transport.
 */
export class InvalidToolArgumentsError extends Error {
  override readonly name = 'InvalidToolArgumentsError';
}

/**
 * Base for every failure that is the *caller's* request error, mapped to
 * JSON-RPC `-32602 Invalid params`. Current MCP assigns no dedicated code to these:
 * `prompts.md` prescribes `-32602` for an invalid prompt name AND for missing
 * required arguments, and `resources.md` retired the old `-32002` in favour of
 * the same code. Use this (or a subclass) instead of a bare `throw`, which
 * `handleMessage` would otherwise report as `-32603 Internal error` — a code
 * clients legitimately retry.
 */
export class InvalidParamsError extends Error {
  // Typed as `string`, not the literal, so subclasses may override `name`.
  override readonly name: string = 'InvalidParamsError';
}

/**
 * Marks a lookup for a resource or prompt that does not exist.
 *
 * JSON-RPC has no "not found" code, and MCP retired its own `-32002` in favour
 * of plain Invalid params, so this maps to `-32602` rather than the
 * `-32603 Internal error` a bare `throw` would produce. A caller asking for one
 * URI out of a known-good catalog made a request error, not a server failure —
 * and callers key retry policy off that difference.
 */
export class InvalidLookupError extends InvalidParamsError {
  override readonly name = 'InvalidLookupError';
}

export const SERVER_PAGE_SIZE = 100;

export function paginate<T>(
  items: T[],
  params: unknown,
): { items: T[]; nextCursor?: string | undefined } {
  const cursor = paramsRecord(params)['cursor'];
  let offset = 0;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || !/^\d+$/.test(cursor)) {
      // pagination.md: "Invalid cursors SHOULD result in an error with code
      // -32602 (Invalid params)."
      throw new InvalidParamsError('MCP pagination cursor must be a non-negative integer string');
    }
    offset = Number(cursor);
    if (!Number.isSafeInteger(offset))
      throw new InvalidParamsError('MCP pagination cursor is too large');
  }
  const page = items.slice(offset, offset + SERVER_PAGE_SIZE);
  const next = offset + page.length;
  return {
    items: page,
    ...(next < items.length ? { nextCursor: String(next) } : {}),
  };
}

export function paramsRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

export function requiredParamString(params: unknown, field: string, method: string): string {
  const value = paramsRecord(params)[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidParamsError(`${method} requires a non-empty string "${field}"`);
  }
  return value;
}

export function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return Object.create(null) as Record<string, string>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidParamsError(`${label} must be an object`);
  }
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') throw new InvalidParamsError(`${label}.${key} must be a string`);
    result[key] = item;
  }
  return result;
}

export function renderPromptTemplate(template: string, args: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z_][A-Za-z0-9_.-]*)\}\}/g, (_match, name: string) => {
    const value = Object.hasOwn(args, name) ? args[name] : undefined;
    if (value === undefined)
      throw new InvalidParamsError(`Missing prompt template argument "${name}"`);
    return value;
  });
}

export const METHOD_NOT_FOUND_SENTINEL = Symbol('method-not-found');

export function isMCPContentBlock(c: unknown): boolean {
  if (!c || typeof c !== 'object') return false;
  const type = (c as Record<string, unknown>)['type'];
  return (
    type === 'text' ||
    type === 'image' ||
    type === 'audio' ||
    type === 'resource' ||
    type === 'resource_link'
  );
}

/** Normalize a host result's content into MCP content blocks. */
export function toContentBlocks(content: unknown): Array<{ type: string; [key: string]: unknown }> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) {
    // Already-shaped content blocks pass through; otherwise stringify each item.
    const allBlocks = content.every(isMCPContentBlock);
    if (allBlocks) return content as Array<{ type: string; [key: string]: unknown }>;
    return [{ type: 'text', text: content.map((c) => stringifyItem(c)).join('\n') }];
  }
  if (content === undefined || content === null) return [{ type: 'text', text: '' }];
  if (isMCPContentBlock(content)) {
    return [content as { type: string; [key: string]: unknown }];
  }
  return [{ type: 'text', text: stringifyItem(content) }];
}

export function stringifyItem(c: unknown): string {
  if (typeof c === 'string') return c;
  try {
    return JSON.stringify(c);
  } catch {
    return String(c);
  }
}
