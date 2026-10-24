import type { UserInputRequest, UserInputResponse } from '@wrongstack/contracts/types';
import { sanitizeTerminalText } from '@wrongstack/core/utils';
import type { UrlElicitation } from './contracts.js';
import { INVALID_PARAMS } from './server-dispatch.js';

export type { UrlElicitation };

/**
 * MCP elicitation (`elicitation/create`, client feature since 2025-06-18): a
 * server asks the user for a small, flat form of values mid-operation.
 *
 * The requested schema is deliberately restricted by the spec to a flat object
 * of primitive properties, so it is parsed into a list of typed fields here and
 * anything richer is refused as invalid params instead of half-rendered.
 */
export type ElicitationValue = string | number | boolean | string[];

export interface ElicitationOption {
  value: string;
  label: string;
}

interface ElicitationFieldBase {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  required: boolean;
}

export type ElicitationField =
  | (ElicitationFieldBase & {
      kind: 'string';
      minLength?: number | undefined;
      maxLength?: number | undefined;
      format?: string | undefined;
      default?: string | undefined;
    })
  | (ElicitationFieldBase & {
      kind: 'number' | 'integer';
      minimum?: number | undefined;
      maximum?: number | undefined;
      default?: number | undefined;
    })
  | (ElicitationFieldBase & { kind: 'boolean'; default?: boolean | undefined })
  | (ElicitationFieldBase & {
      kind: 'enum';
      options: ElicitationOption[];
      default?: string | undefined;
    })
  | (ElicitationFieldBase & {
      kind: 'multi-enum';
      options: ElicitationOption[];
      minItems?: number | undefined;
      maxItems?: number | undefined;
      default?: string[] | undefined;
    });

export interface ElicitationForm {
  message: string;
  fields: ElicitationField[];
}

/** What a server can put in front of the user: a form, or a page to open. */
export type ElicitationPrompt = (ElicitationForm & { mode?: 'form' | undefined }) | UrlElicitation;

export type MCPElicitationResult =
  | { action: 'accept'; content: Record<string, ElicitationValue> }
  | { action: 'decline' }
  | { action: 'cancel' };

/** The slice of a tool call's run context that can put a form in front of its user. */
export interface ElicitationRequester {
  requestUserInput(
    request: UserInputRequest,
    signal?: AbortSignal,
  ): Promise<UserInputResponse | undefined>;
}

/** What a host sees: the form or page, which server asks, and the run that caused it. */
export type MCPElicitationRequest = ElicitationPrompt & {
  server: string;
  /**
   * Context of the newest in-flight tool call to this server, when there is
   * one — the run whose user should answer. Undefined when the server asks
   * outside any tool call.
   */
  requester?: ElicitationRequester | undefined;
  /** Aborts when the server cancels the request, the connection closes, or the wait runs out. */
  signal: AbortSignal;
};

export type MCPElicitationHandler = (
  request: MCPElicitationRequest,
) => Promise<MCPElicitationResult>;

/** The per-connection slice of {@link MCPElicitationHandler} a client is given. */
export type MCPClientElicitationHandler = (
  request: ElicitationPrompt & {
    signal: AbortSignal;
    requester?: ElicitationRequester | undefined;
  },
) => Promise<MCPElicitationResult>;

/**
 * Longest a server may hold an elicitation open. Request timeouts are paused
 * while one is pending (the user is typing, not the server stalling), so this
 * is what still bounds a call that nobody answers.
 */
const ELICITATION_MAX_WAIT_MS = 10 * 60_000;
const MAX_FIELDS = 32;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_OPTIONS = 100;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/**
 * Server-authored text shown to the user (message, titles, descriptions,
 * choice labels). It lands in the TUI's input form under a host-authored
 * header, so terminal escapes, carriage returns and bidi controls are dropped:
 * otherwise a hostile server could clear or overwrite that header and present
 * its own "WrongStack needs your API key" form, or write the clipboard with
 * OSC 52 (NV-1, security-check 2026-09-26). Values the server receives back
 * (`const`, `default`, field names as keys) are left as sent.
 */
function displayText(v: string): string {
  return sanitizeTerminalText(v);
}

function optionalDisplayString(v: unknown): string | undefined {
  const text = optionalString(v);
  return text === undefined ? undefined : optionalString(displayText(text));
}

function optionalNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function optionalCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/**
 * Options of an enum-like schema, in every shape the spec revisions use:
 * `enum` (+ legacy `enumNames` labels), or titled `oneOf` / `anyOf` entries of
 * `{ const, title }`.
 */
function parseOptions(schema: Record<string, unknown>): ElicitationOption[] | undefined {
  const values = schema['enum'];
  if (Array.isArray(values)) {
    if (!values.every((v) => typeof v === 'string')) return undefined;
    const names = Array.isArray(schema['enumNames']) ? schema['enumNames'] : [];
    return values.map((value, i) => ({
      value,
      label: displayText(typeof names[i] === 'string' && names[i] ? (names[i] as string) : value),
    }));
  }
  const titled = Array.isArray(schema['oneOf'])
    ? schema['oneOf']
    : Array.isArray(schema['anyOf'])
      ? schema['anyOf']
      : undefined;
  if (!titled) return undefined;
  const options: ElicitationOption[] = [];
  for (const entry of titled) {
    if (!isRecord(entry) || typeof entry['const'] !== 'string') return undefined;
    options.push({
      value: entry['const'],
      label: optionalDisplayString(entry['title']) ?? displayText(entry['const']),
    });
  }
  return options;
}

function parseField(name: string, schema: unknown, required: boolean): Parsed<ElicitationField> {
  if (!isRecord(schema)) return { ok: false, error: `property "${name}" is not a schema object` };
  const base = {
    name,
    title: optionalDisplayString(schema['title']),
    description: optionalDisplayString(schema['description']),
    required,
  };
  const type = schema['type'];
  if (type === 'array') {
    const items = schema['items'];
    const options = isRecord(items) ? parseOptions(items) : undefined;
    if (!options || options.length === 0 || options.length > MAX_OPTIONS) {
      return { ok: false, error: `property "${name}": arrays must be a list of enum values` };
    }
    const defaults = Array.isArray(schema['default'])
      ? schema['default'].filter((v): v is string => typeof v === 'string')
      : undefined;
    return {
      ok: true,
      value: {
        ...base,
        kind: 'multi-enum',
        options,
        minItems: optionalCount(schema['minItems']),
        maxItems: optionalCount(schema['maxItems']),
        default: defaults,
      },
    };
  }
  if (type === 'string') {
    const options = parseOptions(schema);
    if (options) {
      if (options.length === 0 || options.length > MAX_OPTIONS) {
        return { ok: false, error: `property "${name}": enum needs 1-${MAX_OPTIONS} values` };
      }
      return {
        ok: true,
        value: { ...base, kind: 'enum', options, default: optionalString(schema['default']) },
      };
    }
    return {
      ok: true,
      value: {
        ...base,
        kind: 'string',
        minLength: optionalCount(schema['minLength']),
        maxLength: optionalCount(schema['maxLength']),
        format: optionalString(schema['format']),
        default: typeof schema['default'] === 'string' ? schema['default'] : undefined,
      },
    };
  }
  if (type === 'number' || type === 'integer') {
    return {
      ok: true,
      value: {
        ...base,
        kind: type,
        minimum: optionalNumber(schema['minimum']),
        maximum: optionalNumber(schema['maximum']),
        default: optionalNumber(schema['default']),
      },
    };
  }
  if (type === 'boolean') {
    return {
      ok: true,
      value: {
        ...base,
        kind: 'boolean',
        default: typeof schema['default'] === 'boolean' ? schema['default'] : undefined,
      },
    };
  }
  return {
    ok: false,
    error: `property "${name}" has unsupported type ${JSON.stringify(type)} — only flat primitive fields can be elicited`,
  };
}

/**
 * A URL-mode request: a web page the user is asked to open. Only `http(s)` is
 * accepted — the page is handed to the system browser, and a `file:` or
 * custom-scheme URL would have the operating system run something instead.
 */
export function parseUrlElicitation(params: unknown): Parsed<UrlElicitation> {
  if (!isRecord(params)) return { ok: false, error: 'params must be an object' };
  const message = params['message'];
  if (typeof message !== 'string' || !message.trim()) {
    return { ok: false, error: 'message is required' };
  }
  const elicitationId = params['elicitationId'];
  if (typeof elicitationId !== 'string' || !elicitationId) {
    return { ok: false, error: 'elicitationId is required in URL mode' };
  }
  const raw = params['url'];
  let url: URL;
  try {
    url = new URL(typeof raw === 'string' ? raw : '');
  } catch {
    return { ok: false, error: 'url must be a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: `url must be http(s), not ${url.protocol}` };
  }
  return {
    ok: true,
    value: {
      mode: 'url',
      message: displayText(message).slice(0, MAX_MESSAGE_CHARS),
      url: url.href,
      elicitationId,
    },
  };
}

/** Parse `elicitation/create` params into a form or a page, or say why they are invalid. */
export function parseElicitationParams(params: unknown): Parsed<ElicitationPrompt> {
  if (!isRecord(params)) return { ok: false, error: 'params must be an object' };
  const message = params['message'];
  if (typeof message !== 'string' || !message.trim()) {
    return { ok: false, error: 'message is required' };
  }
  if (params['mode'] === 'url') return parseUrlElicitation(params);
  if (params['mode'] !== undefined && params['mode'] !== 'form') {
    return { ok: false, error: `unsupported mode ${JSON.stringify(params['mode'])}` };
  }
  const schema = params['requestedSchema'];
  if (!isRecord(schema) || schema['type'] !== 'object' || !isRecord(schema['properties'])) {
    return { ok: false, error: 'requestedSchema must be an object schema with properties' };
  }
  const required = new Set(
    Array.isArray(schema['required'])
      ? schema['required'].filter((v): v is string => typeof v === 'string')
      : [],
  );
  const entries = Object.entries(schema['properties']);
  if (entries.length > MAX_FIELDS) {
    return { ok: false, error: `requestedSchema has more than ${MAX_FIELDS} properties` };
  }
  const fields: ElicitationField[] = [];
  for (const [name, property] of entries) {
    const parsed = parseField(name, property, required.has(name));
    if (!parsed.ok) return parsed;
    fields.push(parsed.value);
  }
  return { ok: true, value: { message: displayText(message).slice(0, MAX_MESSAGE_CHARS), fields } };
}

function label(field: ElicitationField): string {
  return field.title ?? displayText(field.name);
}

function checkValue(field: ElicitationField, raw: unknown): Parsed<ElicitationValue> {
  const name = label(field);
  switch (field.kind) {
    case 'string': {
      if (typeof raw !== 'string') return { ok: false, error: `${name} must be text` };
      // JSON Schema counts characters (code points), not UTF-16 code units.
      const length = [...raw].length;
      if (field.minLength !== undefined && length < field.minLength) {
        return { ok: false, error: `${name} needs at least ${field.minLength} characters` };
      }
      if (field.maxLength !== undefined && length > field.maxLength) {
        return { ok: false, error: `${name} allows at most ${field.maxLength} characters` };
      }
      return { ok: true, value: raw };
    }
    case 'number':
    case 'integer': {
      const n = typeof raw === 'string' && raw.trim() ? Number(raw.trim()) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        return { ok: false, error: `${name} must be a number` };
      }
      if (field.kind === 'integer' && !Number.isInteger(n)) {
        return { ok: false, error: `${name} must be a whole number` };
      }
      if (field.minimum !== undefined && n < field.minimum) {
        return { ok: false, error: `${name} must be at least ${field.minimum}` };
      }
      if (field.maximum !== undefined && n > field.maximum) {
        return { ok: false, error: `${name} must be at most ${field.maximum}` };
      }
      return { ok: true, value: n };
    }
    case 'boolean':
      return typeof raw === 'boolean'
        ? { ok: true, value: raw }
        : { ok: false, error: `${name} must be yes or no` };
    case 'enum':
      return typeof raw === 'string' && field.options.some((o) => o.value === raw)
        ? { ok: true, value: raw }
        : { ok: false, error: `${name} must be one of the offered choices` };
    case 'multi-enum': {
      if (!Array.isArray(raw) || !raw.every((v) => field.options.some((o) => o.value === v))) {
        return { ok: false, error: `${name} must be picked from the offered choices` };
      }
      const picked = [...new Set(raw as string[])];
      if (field.minItems !== undefined && picked.length < field.minItems) {
        return { ok: false, error: `${name} needs at least ${field.minItems} choices` };
      }
      if (field.maxItems !== undefined && picked.length > field.maxItems) {
        return { ok: false, error: `${name} allows at most ${field.maxItems} choices` };
      }
      return { ok: true, value: picked };
    }
  }
}

/**
 * Check accepted content against the form: every required field present, each
 * value of its declared kind and within its bounds, nothing the server did not
 * ask for. Numeric text is coerced so a text box can answer a number field.
 */
export function validateElicitationContent(
  fields: readonly ElicitationField[],
  content: Record<string, unknown>,
): Parsed<Record<string, ElicitationValue>> {
  const out: Record<string, ElicitationValue> = {};
  for (const field of fields) {
    const raw = Object.hasOwn(content, field.name) ? content[field.name] : undefined;
    // Presence and bounds are separate: '' and [] are answers, not omissions.
    // Let checkValue enforce their type and minLength/minItems, including when
    // no minimum is declared. Only undefined/null mean "not answered".
    if (raw === undefined || raw === null) {
      if (field.required) return { ok: false, error: `${label(field)} is required` };
      continue;
    }
    const checked = checkValue(field, raw);
    if (!checked.ok) return checked;
    Object.defineProperty(out, field.name, {
      value: checked.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { ok: true, value: out };
}

type JsonRpcId = number | string;

export interface ServerRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export type ServerResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string } };

/**
 * Answers the requests an MCP server sends to this client — one per
 * connection, shared by the stdio, SSE and Streamable HTTP transports so they
 * cannot drift apart on what the client supports.
 */
export class ServerRequestResponder {
  private readonly pending = new Map<JsonRpcId, AbortController>();

  constructor(private readonly elicitation?: MCPClientElicitationHandler | undefined) {}

  /** Capabilities for legacy initialize and modern request metadata: only installed handlers. */
  capabilities(): Record<string, unknown> {
    return this.elicitation ? { elicitation: { form: {}, url: {} } } : {};
  }

  /** True while an elicitation waits on the user; request timeouts hold meanwhile. */
  get awaitingUser(): boolean {
    return this.pending.size > 0;
  }

  async answer(
    request: ServerRequest,
    scope?: { signal: AbortSignal; requester?: ElicitationRequester | undefined },
  ): Promise<ServerResponse> {
    const { id, method } = request;
    const error = (code: number, message: string): ServerResponse => ({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
    // `ping` is valid in both directions and MUST be answered with an empty
    // result — servers that probe liveness treat "Method not found" as a dead client.
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'sampling/createMessage') {
      return error(-32601, 'Client sampling is disabled by policy');
    }
    if (method !== 'elicitation/create' || !this.elicitation) {
      return error(-32601, `Method not found: ${method}`);
    }
    const form = parseElicitationParams(request.params);
    if (!form.ok) return error(-32602, `Invalid elicitation request: ${form.error}`);
    // One form at a time per server: a second request while the user is still
    // answering the first is refused rather than stacked into a queue of forms.
    if (this.pending.size > 0) {
      // Caller-side request error, not our failure: the server sent a second
      // `elicitation/create` while the first is still on screen.
      return error(
        INVALID_PARAMS,
        'Another elicitation from this server is still waiting on the user',
      );
    }
    const controller = new AbortController();
    const abort = () => controller.abort(scope?.signal.reason);
    scope?.signal.addEventListener('abort', abort, { once: true });
    if (scope?.signal.aborted) abort();
    this.pending.set(id, controller);
    const deadline = setTimeout(
      () => controller.abort(new Error('elicitation timed out')),
      ELICITATION_MAX_WAIT_MS,
    );
    deadline.unref?.();
    try {
      const prompt = form.value;
      let detach = () => {};
      const result = await new Promise<MCPElicitationResult>((resolve, reject) => {
        const cancelled = () => resolve({ action: 'cancel' });
        controller.signal.addEventListener('abort', cancelled, { once: true });
        detach = () => controller.signal.removeEventListener('abort', cancelled);
        if (controller.signal.aborted) {
          cancelled();
          return;
        }
        Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted();
            return this.elicitation!({
              ...prompt,
              signal: controller.signal,
              ...(scope ? { requester: scope.requester } : {}),
            });
          })
          .then(resolve, reject);
      }).finally(() => detach());
      if (controller.signal.aborted) return { jsonrpc: '2.0', id, result: { action: 'cancel' } };
      if (result.action !== 'accept')
        return { jsonrpc: '2.0', id, result: { action: result.action } };
      // A page carries no content back: `accept` is the user's consent to open it.
      if (prompt.mode === 'url') return { jsonrpc: '2.0', id, result: { action: 'accept' } };
      const content = validateElicitationContent(prompt.fields, result.content);
      // The answer the server handed back does not satisfy the schema this
      // client advertised — an invalid-params condition, not an internal one.
      if (!content.ok)
        return error(INVALID_PARAMS, `Elicitation answer rejected: ${content.error}`);
      return { jsonrpc: '2.0', id, result: { action: 'accept', content: content.value } };
    } catch {
      return { jsonrpc: '2.0', id, result: { action: 'cancel' } };
    } finally {
      clearTimeout(deadline);
      scope?.signal.removeEventListener('abort', abort);
      // dispose/reconnect may reuse an id before the previous surface settles.
      if (this.pending.get(id) === controller) this.pending.delete(id);
    }
  }

  /**
   * Pages a tool call's `-32042` (URL elicitation required) error names, put
   * to the user one at a time. Returns what the user chose for each; nothing
   * is opened without their consent, and without a handler every one is
   * `cancel`.
   */
  async presentUrl(
    elicitations: readonly UrlElicitation[],
    signal: AbortSignal,
  ): Promise<Array<{ elicitation: UrlElicitation; action: MCPElicitationResult['action'] }>> {
    const outcomes: Array<{
      elicitation: UrlElicitation;
      action: MCPElicitationResult['action'];
    }> = [];
    for (const elicitation of elicitations) {
      let action: MCPElicitationResult['action'] = 'cancel';
      if (this.elicitation && !signal.aborted) {
        try {
          action = (await this.elicitation({ ...elicitation, signal })).action;
        } catch {
          action = 'cancel';
        }
      }
      outcomes.push({ elicitation, action });
    }
    return outcomes;
  }

  /** `notifications/cancelled` from the server: stop waiting for that answer. */
  cancel(params: unknown): void {
    if (!isRecord(params)) return;
    const requestId = params['requestId'];
    if (typeof requestId !== 'number' && typeof requestId !== 'string') return;
    this.pending.get(requestId)?.abort(new Error('cancelled by server'));
  }

  /** The connection is gone: abandon every open form. */
  dispose(): void {
    for (const controller of this.pending.values())
      controller.abort(new Error('connection closed'));
    this.pending.clear();
  }
}
