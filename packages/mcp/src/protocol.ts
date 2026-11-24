/** Typed MCP protocol surface for server discovery, resources, and prompts. */

export interface MCPImplementationInfo {
  name: string;
  version: string;
  title?: string | undefined;
}

export interface MCPServerCapabilities {
  tools?: { listChanged?: boolean | undefined } | undefined;
  resources?: { subscribe?: boolean | undefined; listChanged?: boolean | undefined } | undefined;
  prompts?: { listChanged?: boolean | undefined } | undefined;
  logging?: Record<string, never> | undefined;
  [capability: string]: unknown;
}

export interface MCPServerMetadata {
  protocolVersion: string;
  capabilities: MCPServerCapabilities;
  serverInfo: MCPImplementationInfo;
  instructions?: string | undefined;
}

export interface MCPResource {
  uri: string;
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  mimeType?: string | undefined;
  size?: number | undefined;
  annotations?: Record<string, unknown> | undefined;
}

export interface MCPResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  mimeType?: string | undefined;
  annotations?: Record<string, unknown> | undefined;
}

export interface MCPResourceContents {
  uri: string;
  mimeType?: string | undefined;
  text?: string | undefined;
  blob?: string | undefined;
}

export interface MCPPromptArgument {
  name: string;
  description?: string | undefined;
  required?: boolean | undefined;
}

export interface MCPPrompt {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  arguments?: MCPPromptArgument[] | undefined;
}

export interface MCPPromptMessage {
  role: 'user' | 'assistant';
  /** Preserve text, image, audio, embedded-resource, and resource-link blocks. */
  content: unknown;
}

export interface MCPListResourcesResult {
  resources: MCPResource[];
  nextCursor?: string | undefined;
}

export interface MCPListResourceTemplatesResult {
  resourceTemplates: MCPResourceTemplate[];
  nextCursor?: string | undefined;
}

export interface MCPReadResourceResult {
  contents: MCPResourceContents[];
}

export interface MCPListPromptsResult {
  prompts: MCPPrompt[];
  nextCursor?: string | undefined;
}

export interface MCPGetPromptResult {
  description?: string | undefined;
  messages: MCPPromptMessage[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed MCP ${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Malformed MCP ${label}: expected non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Malformed MCP ${label}: expected string`);
  return value;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return record(value, label);
}

function optionalCursor(value: unknown, label: string): string | undefined {
  return optionalString(value, `${label}.nextCursor`);
}

export function parseServerMetadata(value: unknown): MCPServerMetadata {
  const input = record(value, 'initialize result');
  const serverInfo = record(input['serverInfo'], 'initialize.serverInfo');
  const capabilities = record(input['capabilities'], 'initialize.capabilities');
  return {
    protocolVersion: requiredString(input['protocolVersion'], 'initialize.protocolVersion'),
    capabilities: capabilities as MCPServerCapabilities,
    serverInfo: {
      name: requiredString(serverInfo['name'], 'initialize.serverInfo.name'),
      version: requiredString(serverInfo['version'], 'initialize.serverInfo.version'),
      title: optionalString(serverInfo['title'], 'initialize.serverInfo.title'),
    },
    instructions: optionalString(input['instructions'], 'initialize.instructions'),
  };
}

function parseResource(value: unknown, index: number): MCPResource {
  const input = record(value, `resources/list.resources[${index}]`);
  const size = input['size'];
  if (size !== undefined && (typeof size !== 'number' || !Number.isFinite(size) || size < 0)) {
    throw new Error(`Malformed MCP resources/list.resources[${index}].size`);
  }
  return {
    uri: requiredString(input['uri'], `resources/list.resources[${index}].uri`),
    name: requiredString(input['name'], `resources/list.resources[${index}].name`),
    title: optionalString(input['title'], `resources/list.resources[${index}].title`),
    description: optionalString(
      input['description'],
      `resources/list.resources[${index}].description`,
    ),
    mimeType: optionalString(input['mimeType'], `resources/list.resources[${index}].mimeType`),
    size: size as number | undefined,
    annotations: optionalRecord(
      input['annotations'],
      `resources/list.resources[${index}].annotations`,
    ),
  };
}

export function parseListResourcesResult(value: unknown): MCPListResourcesResult {
  const input = record(value, 'resources/list result');
  if (!Array.isArray(input['resources'])) {
    throw new Error('Malformed MCP resources/list result: resources must be an array');
  }
  return {
    resources: input['resources'].map(parseResource),
    nextCursor: optionalCursor(input['nextCursor'], 'resources/list'),
  };
}

export function parseListResourceTemplatesResult(value: unknown): MCPListResourceTemplatesResult {
  const input = record(value, 'resources/templates/list result');
  const templates = input['resourceTemplates'];
  if (!Array.isArray(templates)) {
    throw new Error(
      'Malformed MCP resources/templates/list result: resourceTemplates must be an array',
    );
  }
  return {
    resourceTemplates: templates.map((value, index) => {
      const template = record(value, `resources/templates/list.resourceTemplates[${index}]`);
      return {
        uriTemplate: requiredString(
          template['uriTemplate'],
          `resources/templates/list.resourceTemplates[${index}].uriTemplate`,
        ),
        name: requiredString(
          template['name'],
          `resources/templates/list.resourceTemplates[${index}].name`,
        ),
        title: optionalString(
          template['title'],
          `resources/templates/list.resourceTemplates[${index}].title`,
        ),
        description: optionalString(
          template['description'],
          `resources/templates/list.resourceTemplates[${index}].description`,
        ),
        mimeType: optionalString(
          template['mimeType'],
          `resources/templates/list.resourceTemplates[${index}].mimeType`,
        ),
        annotations: optionalRecord(
          template['annotations'],
          `resources/templates/list.resourceTemplates[${index}].annotations`,
        ),
      };
    }),
    nextCursor: optionalCursor(input['nextCursor'], 'resources/templates/list'),
  };
}

export function parseReadResourceResult(value: unknown): MCPReadResourceResult {
  const input = record(value, 'resources/read result');
  if (!Array.isArray(input['contents'])) {
    throw new Error('Malformed MCP resources/read result: contents must be an array');
  }
  return {
    contents: input['contents'].map((value, index) => {
      const content = record(value, `resources/read.contents[${index}]`);
      const text = optionalString(content['text'], `resources/read.contents[${index}].text`);
      const blob = optionalString(content['blob'], `resources/read.contents[${index}].blob`);
      if (text === undefined && blob === undefined) {
        throw new Error(`Malformed MCP resources/read.contents[${index}]: expected text or blob`);
      }
      return {
        uri: requiredString(content['uri'], `resources/read.contents[${index}].uri`),
        mimeType: optionalString(content['mimeType'], `resources/read.contents[${index}].mimeType`),
        text,
        blob,
      };
    }),
  };
}

function parsePromptArgument(
  value: unknown,
  promptIndex: number,
  argIndex: number,
): MCPPromptArgument {
  const input = record(value, `prompts/list.prompts[${promptIndex}].arguments[${argIndex}]`);
  const required = input['required'];
  if (required !== undefined && typeof required !== 'boolean') {
    throw new Error(
      `Malformed MCP prompts/list.prompts[${promptIndex}].arguments[${argIndex}].required`,
    );
  }
  return {
    name: requiredString(
      input['name'],
      `prompts/list.prompts[${promptIndex}].arguments[${argIndex}].name`,
    ),
    description: optionalString(
      input['description'],
      `prompts/list.prompts[${promptIndex}].arguments[${argIndex}].description`,
    ),
    required: required as boolean | undefined,
  };
}

export function parseListPromptsResult(value: unknown): MCPListPromptsResult {
  const input = record(value, 'prompts/list result');
  if (!Array.isArray(input['prompts'])) {
    throw new Error('Malformed MCP prompts/list result: prompts must be an array');
  }
  return {
    prompts: input['prompts'].map((value, index) => {
      const prompt = record(value, `prompts/list.prompts[${index}]`);
      const args = prompt['arguments'];
      if (args !== undefined && !Array.isArray(args)) {
        throw new Error(`Malformed MCP prompts/list.prompts[${index}].arguments`);
      }
      return {
        name: requiredString(prompt['name'], `prompts/list.prompts[${index}].name`),
        title: optionalString(prompt['title'], `prompts/list.prompts[${index}].title`),
        description: optionalString(
          prompt['description'],
          `prompts/list.prompts[${index}].description`,
        ),
        arguments: args?.map((arg, argIndex) => parsePromptArgument(arg, index, argIndex)),
      };
    }),
    nextCursor: optionalCursor(input['nextCursor'], 'prompts/list'),
  };
}

export function parseGetPromptResult(value: unknown): MCPGetPromptResult {
  const input = record(value, 'prompts/get result');
  if (!Array.isArray(input['messages'])) {
    throw new Error('Malformed MCP prompts/get result: messages must be an array');
  }
  return {
    description: optionalString(input['description'], 'prompts/get.description'),
    messages: input['messages'].map((value, index) => {
      const message = record(value, `prompts/get.messages[${index}]`);
      const role = message['role'];
      if (role !== 'user' && role !== 'assistant') {
        throw new Error(`Malformed MCP prompts/get.messages[${index}].role`);
      }
      if (message['content'] === undefined) {
        throw new Error(`Malformed MCP prompts/get.messages[${index}].content`);
      }
      return { role, content: message['content'] };
    }),
  };
}

/**
 * Extract the `uri` from a `notifications/resources/updated` payload.
 *
 * The notification is the whole point of `resources/subscribe`, which the
 * client already supported — every transport parsed the three `list_changed`
 * notifications and silently dropped this one, so a subscription produced
 * nothing. Returns `undefined` for a malformed payload rather than throwing:
 * a notification has no reply, so a bad one is ignored, not answered.
 */
export function resourceUpdatedUri(params: unknown): string | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const uri = (params as { uri?: unknown }).uri;
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 4_096) return undefined;
  if (/[\r\n]/.test(uri)) return undefined;
  return uri;
}

/**
 * Maximum characters carried through from a progress/log notification's free
 * text (`message`, serialized log `data`). The payload is
 * attacker-controllable server output that lands in logs and consoles, so it
 * is bounded the same way `resourceUpdatedUri` bounds a URI.
 */
const MAX_NOTIFICATION_TEXT_CHARS = 2_000;

/**
 * Maximum length accepted for identifier-shaped fields (`progressToken`
 * string form, `logger`). Longer or control-carrying values make the
 * notification malformed — identifiers are never prose, so there is nothing
 * legitimate to clamp.
 */
const MAX_NOTIFICATION_ID_CHARS = 256;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const HAS_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Clamp free text from a server notification. Control characters — a forged
 * newline above all — become spaces: this text is displayed and logged as if
 * it were ours, and a line break could impersonate a system message.
 */
function clampedNotificationText(value: string): string {
  const sanitized = value.replace(CONTROL_CHARS, ' ');
  if (sanitized.length <= MAX_NOTIFICATION_TEXT_CHARS) return sanitized;
  let end = MAX_NOTIFICATION_TEXT_CHARS;
  const lastKept = sanitized.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
  return `${sanitized.slice(0, end)}…`;
}

/** Accept a bounded, control-free identifier, or report it malformed. */
function notificationId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.length > MAX_NOTIFICATION_ID_CHARS) return undefined;
  if (HAS_CONTROL_CHARS.test(value)) return undefined;
  return value;
}

/** Serialize non-string log data to bounded text. Wire data is always JSON;
 * the fallbacks keep the parser total for direct callers. */
function serializedNotificationData(value: unknown): string {
  if (typeof value === 'string') return clampedNotificationText(value);
  try {
    return clampedNotificationText(JSON.stringify(value) ?? String(value));
  } catch {
    return clampedNotificationText(String(value));
  }
}

/** Parsed `notifications/progress` payload (2024-11-05 progress utility). */
export interface MCPProgressNotification {
  /** Echo of the `params._meta.progressToken` the originating request sent. */
  progressToken: string | number;
  /** Monotonically increasing progress value for the token's request. */
  progress: number;
  /** Expected final `progress` value, when the server sent one. */
  total?: number | undefined;
  /** Human-readable progress text (a later revision's optional field). */
  message?: string | undefined;
}

/** Log levels `notifications/message` may carry (MCP `LoggingLevel`, RFC 5424 severities). */
export type MCPLogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

/** Parsed `notifications/message` (logging) payload. */
export interface MCPLogMessageNotification {
  level: MCPLogLevel;
  /** Name of the emitting subsystem, when the server sent one. */
  logger?: string | undefined;
  /** Log content serialized to bounded, control-free text. */
  data?: string | undefined;
}

const MCP_LOG_LEVELS: ReadonlySet<string> = new Set([
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
]);

/**
 * Parse a `notifications/progress` payload (2024-11-05 progress utility).
 *
 * A server sends progress only while a request whose `params._meta` carried
 * a `progressToken` is in flight, so the token in the result is the only
 * correlation between a notification and the call that asked for it. Returns
 * `undefined` for a malformed payload rather than throwing — a notification
 * has no reply, so a bad one is ignored, not answered (same contract as
 * {@link resourceUpdatedUri}). Optional fields (`total`, `message`) are
 * dropped when invalid instead of failing the whole notification.
 */
export function progressNotification(params: unknown): MCPProgressNotification | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const input = params as Record<string, unknown>;
  const rawToken = input['progressToken'];
  const progressToken =
    typeof rawToken === 'number' && Number.isFinite(rawToken) ? rawToken : notificationId(rawToken);
  if (progressToken === undefined) return undefined;
  const progress = input['progress'];
  if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0) {
    return undefined;
  }
  const rawTotal = input['total'];
  const total =
    typeof rawTotal === 'number' && Number.isFinite(rawTotal) && rawTotal > 0
      ? rawTotal
      : undefined;
  const rawMessage = input['message'];
  const message =
    typeof rawMessage === 'string' && rawMessage.length > 0
      ? clampedNotificationText(rawMessage)
      : undefined;
  return { progressToken, progress, total, message };
}

/**
 * Parse a `notifications/message` (logging) payload (2024-11-05 logging
 * utility). The log `data` is serialized to text and clamped — it is
 * attacker-controllable server output — and an out-of-enum `level` makes the
 * notification malformed. Returns `undefined` rather than throwing; a
 * notification has no reply.
 */
export function logMessageNotification(params: unknown): MCPLogMessageNotification | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const input = params as Record<string, unknown>;
  const level = input['level'];
  if (typeof level !== 'string' || !MCP_LOG_LEVELS.has(level)) return undefined;
  return {
    level: level as MCPLogLevel,
    logger: notificationId(input['logger']),
    data: input['data'] === undefined ? undefined : serializedNotificationData(input['data']),
  };
}

/** Reference identifying what to autocomplete (MCP `Reference`). */
export type MCPCompletionReference =
  | { type: 'ref/prompt'; name: string }
  | { type: 'ref/resource'; uri: string };

export interface MCPCompletionResult {
  completion: {
    /** Suggested completions, most relevant first. May be empty. */
    values: string[];
    /** Total completions the server knows about, when it reports it. */
    total?: number | undefined;
    /** True when more completions exist beyond `values`. */
    hasMore?: boolean | undefined;
  };
}

/**
 * Parse a `completion/complete` result (2024-11-05 completions utility).
 * `values` is required (may be empty); `total`/`hasMore` are validated only
 * when present, so a malformed optional cannot masquerade as valid pagination.
 */
export function parseCompletionResult(value: unknown): MCPCompletionResult {
  const envelope = record(value, 'completion/complete result');
  const completion = record(envelope['completion'], 'completion/complete result.completion');
  const rawValues = completion['values'];
  if (!Array.isArray(rawValues)) {
    throw new Error('Malformed MCP completion/complete result: expected values array');
  }
  const values = rawValues.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new Error(`Malformed MCP completion/complete result.values[${index}]: expected string`);
    }
    return entry;
  });
  const rawTotal = completion['total'];
  const total =
    typeof rawTotal === 'number' && Number.isInteger(rawTotal) && rawTotal >= 0
      ? rawTotal
      : undefined;
  const hasMore = typeof completion['hasMore'] === 'boolean' ? completion['hasMore'] : undefined;
  return { completion: { values, total, hasMore } };
}
