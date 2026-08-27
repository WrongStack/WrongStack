import { toErrorMessage } from '../utils/error.js';

/**
 * WrongStack error hierarchy.
 *
 * Every error thrown by the framework is a `WrongStackError` with a
 * machine-readable `code`, a `subsystem` tag, and a `severity` level.
 * This lets consumers (CLI, TUI, plugins, tests) branch on structured
 * data instead of parsing error messages.
 */

// ── Error codes ──────────────────────────────────────────────────────

/**
 * Machine-readable error codes as frozen constants.
 *
 * Use `ERROR_CODES.X` instead of raw string literals for:
 * - IDE autocomplete and compile-time validation
 * - Safe refactoring (rename updates all usages)
 * - Plugin extensibility (extend the object to add custom codes)
 *
 * The `ErrorCode` type is derived from this object, so adding a new
 * code here automatically updates the type without extra changes.
 */
export const ERROR_CODES = {
  // Provider
  PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  PROVIDER_AUTH_FAILED: 'PROVIDER_AUTH_FAILED',
  PROVIDER_OVERLOADED: 'PROVIDER_OVERLOADED',
  PROVIDER_INVALID_REQUEST: 'PROVIDER_INVALID_REQUEST',
  PROVIDER_SERVER_ERROR: 'PROVIDER_SERVER_ERROR',
  PROVIDER_NETWORK_ERROR: 'PROVIDER_NETWORK_ERROR',
  PROVIDER_CONTEXT_OVERFLOW: 'PROVIDER_CONTEXT_OVERFLOW',
  // Tool
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  TOOL_PERMISSION_DENIED: 'TOOL_PERMISSION_DENIED',
  TOOL_EXECUTION_FAILED: 'TOOL_EXECUTION_FAILED',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  TOOL_INPUT_INVALID: 'TOOL_INPUT_INVALID',
  // Config
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  CONFIG_PARSE_FAILED: 'CONFIG_PARSE_FAILED',
  CONFIG_MIGRATION_NEEDED: 'CONFIG_MIGRATION_NEEDED',
  // Plugin
  PLUGIN_LOAD_FAILED: 'PLUGIN_LOAD_FAILED',
  PLUGIN_API_MISMATCH: 'PLUGIN_API_MISMATCH',
  PLUGIN_MISSING_DEPENDENCY: 'PLUGIN_MISSING_DEPENDENCY',
  // Agent
  AGENT_ITERATION_LIMIT: 'AGENT_ITERATION_LIMIT',
  AGENT_CONTEXT_OVERFLOW: 'AGENT_CONTEXT_OVERFLOW',
  AGENT_ABORTED: 'AGENT_ABORTED',
  AGENT_RUN_FAILED: 'AGENT_RUN_FAILED',
  // Session
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_CORRUPTED: 'SESSION_CORRUPTED',
  SESSION_WRITE_FAILED: 'SESSION_WRITE_FAILED',
  SESSION_ID_REQUIRED: 'SESSION_ID_REQUIRED',
  // Container / Registry
  CONTAINER_TOKEN_ALREADY_BOUND: 'CONTAINER_TOKEN_ALREADY_BOUND',
  CONTAINER_TOKEN_NOT_BOUND: 'CONTAINER_TOKEN_NOT_BOUND',
  CONTAINER_CIRCULAR_DEPENDENCY: 'CONTAINER_CIRCULAR_DEPENDENCY',
  REGISTRY_DUPLICATE: 'REGISTRY_DUPLICATE',
  REGISTRY_NOT_FOUND: 'REGISTRY_NOT_FOUND',
  REGISTRY_INVALID: 'REGISTRY_INVALID',
  // File system
  FS_READ_FAILED: 'FS_READ_FAILED',
  FS_WRITE_FAILED: 'FS_WRITE_FAILED',
  FS_MKDIR_FAILED: 'FS_MKDIR_FAILED',
  FS_DELETE_FAILED: 'FS_DELETE_FAILED',
  FS_ATOMIC_WRITE_FAILED: 'FS_ATOMIC_WRITE_FAILED',
  // SDD (Spec-Driven Development)
  SDD_VALIDATION_FAILED: 'SDD_VALIDATION_FAILED',
  SDD_PARSE_FAILED: 'SDD_PARSE_FAILED',
  SDD_INVALID_STATE: 'SDD_INVALID_STATE',
  SDD_NOT_READY: 'SDD_NOT_READY',
  // General
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  PARSE_FAILED: 'PARSE_FAILED',
  UNKNOWN: 'UNKNOWN',
} as const;

/**
 * Union type derived from `ERROR_CODES`. Using `typeof ERROR_CODES[keyof typeof ERROR_CODES]`
 * instead of a string literal union means TypeScript auto-updates the type whenever
 * a new code is added to `ERROR_CODES` — no need to keep two lists in sync.
 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ErrorSubsystem =
  | 'provider'
  | 'tool'
  | 'config'
  | 'plugin'
  | 'agent'
  | 'session'
  | 'sdd'
  | 'container'
  | 'fs'
  | 'general';
export type ErrorSeverity = 'fatal' | 'error' | 'warning';

// ── Base error class ─────────────────────────────────────────────────

export class WrongStackError extends Error {
  readonly code: ErrorCode;
  readonly subsystem: ErrorSubsystem;
  readonly severity: ErrorSeverity;
  readonly recoverable: boolean;
  readonly context?: Record<string, unknown> | undefined;

  constructor(opts: {
    message: string;
    code: ErrorCode;
    subsystem: ErrorSubsystem;
    severity?: ErrorSeverity | undefined;
    recoverable?: boolean | undefined;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = 'WrongStackError';
    this.code = opts.code;
    this.subsystem = opts.subsystem;
    this.severity = opts.severity ?? 'error';
    this.recoverable = opts.recoverable ?? false;
    this.context = opts.context;
  }

  /**
   * Duck-type guard mirroring {@link ProviderError.isProviderError}.
   *
   * `instanceof WrongStackError` is NOT reliable inside this monorepo: the
   * package builder emits every `@wrongstack/core` subpath (`core`, `types`,
   * `coordination`, `execution`, `extension`, …) as an independent esbuild
   * bundle with `splitting: false`, so each entry inlines its OWN copy of this
   * class. An error constructed by `@wrongstack/providers` (which imports from
   * `@wrongstack/core/types`) therefore fails `instanceof` against the copy
   * baked into `@wrongstack/core/core` — which is where the agent loop and the
   * provider runner live.
   *
   * That mismatch silently downgraded every provider failure to a generic
   * `AgentError` in {@link toWrongStackError}, stripping `kind` / `status` /
   * `body` and blinding the fallback engine and the provider waiting room.
   * Use this guard anywhere the error may have crossed a subpath boundary.
   */
  static isWrongStackError(err: unknown): err is WrongStackError {
    if (err instanceof WrongStackError) return true;
    if (!err || typeof err !== 'object') return false;
    const e = err as Record<string, unknown>;
    return (
      typeof e['name'] === 'string' &&
      e['name'].endsWith('Error') &&
      typeof e['code'] === 'string' &&
      typeof e['subsystem'] === 'string' &&
      typeof e['severity'] === 'string' &&
      typeof e['describe'] === 'function'
    );
  }

  /**
   * Render a one-line user-facing description.
   * Subclasses should override for domain-specific formatting.
   */
  describe(): string {
    const ctx = this.context ? ` ${formatContext(this.context)}` : '';
    return `${this.code}: ${this.message}${ctx}`;
  }
}

function formatContext(ctx: Record<string, unknown>): string {
  const parts = Object.entries(ctx)
    .filter(([, v]) => v !== undefined)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length > 0 ? `[${parts.join(' ')}]` : '';
}

// ── Specific error classes ───────────────────────────────────────────

/**
 * Tool execution errors — thrown by ToolExecutor and individual tools.
 */
export class ToolError extends WrongStackError {
  readonly toolName: string;

  constructor(opts: {
    message: string;
    code: Extract<
      ErrorCode,
      | 'TOOL_NOT_FOUND'
      | 'TOOL_PERMISSION_DENIED'
      | 'TOOL_EXECUTION_FAILED'
      | 'TOOL_TIMEOUT'
      | 'TOOL_INPUT_INVALID'
    >;
    toolName: string;
    recoverable?: boolean | undefined;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: opts.code,
      subsystem: 'tool',
      recoverable: opts.recoverable,
      context: { tool: opts.toolName, ...opts.context },
      cause: opts.cause,
    });
    this.name = 'ToolError';
    this.toolName = opts.toolName;
  }
}

/**
 * Config loading / validation errors.
 */
export class ConfigError extends WrongStackError {
  constructor(opts: {
    message: string;
    code: Extract<
      ErrorCode,
      'CONFIG_INVALID' | 'CONFIG_NOT_FOUND' | 'CONFIG_PARSE_FAILED' | 'CONFIG_MIGRATION_NEEDED'
    >;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: opts.code,
      subsystem: 'config',
      severity: 'fatal',
      recoverable: false,
      context: opts.context,
      cause: opts.cause,
    });
    this.name = 'ConfigError';
  }
}

/**
 * Plugin loading / lifecycle errors.
 */
export class PluginError extends WrongStackError {
  readonly pluginName: string;

  constructor(opts: {
    message: string;
    code: Extract<
      ErrorCode,
      'PLUGIN_LOAD_FAILED' | 'PLUGIN_API_MISMATCH' | 'PLUGIN_MISSING_DEPENDENCY'
    >;
    pluginName: string;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: opts.code,
      subsystem: 'plugin',
      severity: 'error',
      recoverable: opts.code === ERROR_CODES.PLUGIN_MISSING_DEPENDENCY,
      context: { plugin: opts.pluginName, ...opts.context },
      cause: opts.cause,
    });
    this.name = 'PluginError';
    this.pluginName = opts.pluginName;
  }
}

/**
 * Agent runtime errors — thrown by Agent.run when a non-WrongStackError
 * escapes the inner loop, so callers always see a structured error.
 */
export class AgentError extends WrongStackError {
  constructor(opts: {
    message: string;
    code: Extract<
      ErrorCode,
      'AGENT_ITERATION_LIMIT' | 'AGENT_CONTEXT_OVERFLOW' | 'AGENT_ABORTED' | 'AGENT_RUN_FAILED'
    >;
    recoverable?: boolean | undefined;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: opts.code,
      subsystem: 'agent',
      severity: opts.code === ERROR_CODES.AGENT_ABORTED ? 'warning' : 'error',
      recoverable: opts.recoverable ?? opts.code === ERROR_CODES.AGENT_ITERATION_LIMIT,
      context: opts.context,
      cause: opts.cause,
    });
    this.name = 'AgentError';
  }
}

/**
 * Wrap an arbitrary thrown value into a `WrongStackError` so the caller
 * always gets a structured error. Pass-throughs WrongStackError instances
 * unchanged; raw `Error`s and primitives get an `AGENT_RUN_FAILED` wrapper
 * with the original preserved as `cause`.
 */
export function toWrongStackError(
  err: unknown,
  code: Extract<
    ErrorCode,
    'AGENT_RUN_FAILED' | 'AGENT_ABORTED' | 'UNKNOWN'
  > = ERROR_CODES.AGENT_RUN_FAILED,
): WrongStackError {
  // Duck-typed, NOT `instanceof`: a ProviderError thrown by
  // `@wrongstack/providers` extends the `@wrongstack/core/types` copy of
  // WrongStackError, which is a different class identity from the copy bundled
  // into `@wrongstack/core/core`. Wrapping it would strip `kind`/`status`/
  // `body` and make the error invisible to the fallback engine and the
  // provider waiting room. See {@link WrongStackError.isWrongStackError}.
  if (WrongStackError.isWrongStackError(err)) return err;
  const message = toErrorMessage(err);
  return new AgentError({
    message,
    code: code === 'UNKNOWN' ? ERROR_CODES.AGENT_RUN_FAILED : code,
    cause: err,
  });
}

/**
 * Session storage errors.
 */
export class SessionError extends WrongStackError {
  readonly sessionId?: string | undefined;

  constructor(opts: {
    message: string;
    code: Extract<
      ErrorCode,
      'SESSION_NOT_FOUND' | 'SESSION_CORRUPTED' | 'SESSION_WRITE_FAILED' | 'SESSION_ID_REQUIRED'
    >;
    sessionId?: string | undefined;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: opts.code,
      subsystem: 'session',
      severity: opts.code === ERROR_CODES.SESSION_WRITE_FAILED ? 'error' : 'warning',
      recoverable: opts.code !== ERROR_CODES.SESSION_CORRUPTED,
      context: { sessionId: opts.sessionId, ...opts.context },
      cause: opts.cause,
    });
    this.name = 'SessionError';
    this.sessionId = opts.sessionId;
  }
}

/**
 * SDD (Spec-Driven Development) errors — spec validation, parsing, and
 * state machine violations in the AISpecBuilder, TaskFlow, and TaskTracker.
 */
export class SddError extends WrongStackError {
  constructor(opts: {
    message: string;
    code: Extract<
      ErrorCode,
      'SDD_VALIDATION_FAILED' | 'SDD_PARSE_FAILED' | 'SDD_INVALID_STATE' | 'SDD_NOT_READY'
    >;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: opts.code,
      subsystem: 'sdd',
      severity: opts.code === ERROR_CODES.SDD_PARSE_FAILED ? 'warning' : 'error',
      recoverable: opts.code === ERROR_CODES.SDD_NOT_READY,
      context: opts.context,
      cause: opts.cause,
    });
    this.name = 'SddError';
  }
}

/**
 * File system operation errors.
 */
export class FsError extends WrongStackError {
  readonly path?: string | undefined;

  constructor(opts: {
    message: string;
    code: Extract<
      ErrorCode,
      | 'FS_READ_FAILED'
      | 'FS_WRITE_FAILED'
      | 'FS_MKDIR_FAILED'
      | 'FS_DELETE_FAILED'
      | 'FS_ATOMIC_WRITE_FAILED'
    >;
    path?: string | undefined;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: opts.code,
      subsystem: 'fs',
      severity: 'error',
      recoverable: opts.code !== ERROR_CODES.FS_READ_FAILED,
      context: { path: opts.path, ...opts.context },
      cause: opts.cause,
    });
    this.name = 'FsError';
    this.path = opts.path;
  }
}

/**
 * HTTP fetch error — thrown when a network request returns a non-OK status.
 * Carries the response status so {@link classifyToolError} can branch on it
 * (429 → transient, 404 → not_found, 401 → permission) without duck-typing
 * the error via `'response' in err`.
 *
 * P3 #18 (before-release.md): the previous `'response' in err` check caught
 * any Error with a `response` property, including custom errors, proxy
 * objects, or mocked errors in tests. `instanceof FetchError` is reliable.
 *
 * Tools and providers that make HTTP requests and need the executor to
 * classify their failures should throw `new FetchError({ status, message })`
 * instead of a bare `Error` with an ad-hoc `response` field.
 */
export class FetchError extends WrongStackError {
  readonly status: number;

  constructor(opts: {
    message: string;
    status: number;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: ERROR_CODES.VALIDATION_ERROR,
      subsystem: 'general',
      severity: 'error',
      recoverable: opts.status === 429 || opts.status >= 500,
      context: { status: opts.status, ...opts.context },
      cause: opts.cause,
    });
    this.name = 'FetchError';
    this.status = opts.status;
  }
}

/**
 * Tool input validation error — thrown when a tool's input fails a validation
 * check that the JSON Schema cannot express (e.g. `old_string === new_string`
 * in edit, or a cross-field invariant). Use this instead of a bare
 * `throw new Error('...validation...')` so {@link classifyToolError} can
 * match on `instanceof` rather than a locale-dependent message substring.
 *
 * P2 #6 (before-release.md): the previous `err.message.includes('validation')`
 * check misclassified any error whose message happened to contain "validation"
 * (e.g. a third-party "input validation timeout") as a VALIDATION error.
 *
 * Named `ToolValidationError` (not `ValidationError`) to avoid colliding with
 * the existing `ValidationError` interface exported by json-schema-validate.ts
 * (a validation-result shape, not an Error subclass).
 */
export class ToolValidationError extends WrongStackError {
  constructor(opts: {
    message: string;
    /** Field path or tool name that failed validation, for diagnostics. */
    field?: string | undefined;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: ERROR_CODES.VALIDATION_ERROR,
      subsystem: 'general',
      severity: 'error',
      recoverable: false,
      context: { field: opts.field, ...opts.context },
      cause: opts.cause,
    });
    this.name = 'ToolValidationError';
  }
}

/**
 * Response / payload parse error — thrown when an upstream HTTP response,
 * file, or data structure is well-formed at the transport layer (HTTP 200,
 * valid JSON) but is missing required fields or has an unexpected shape.
 *
 * Distinct from `ConfigError(CONFIG_PARSE_FAILED)` (which is specifically
 * for config-file parsing) and `FetchError` (which covers HTTP non-OK
 * responses). `ParseError` fills the gap: the request succeeded but the
 * response body couldn't be interpreted.
 *
 * Common sites: OAuth token responses missing `access_token`, device-code
 * responses missing `device_code`, registry responses with unexpected
 * schemas.
 */
export class ParseError extends WrongStackError {
  readonly source?: string | undefined;

  constructor(opts: {
    message: string;
    /**
     * What was being parsed — e.g. `'oauth-token-response'`,
     * `'device-code-response'`. Lets consumers distinguish parse failures
     * from different upstream APIs without parsing the message.
     */
    source?: string | undefined;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: ERROR_CODES.PARSE_FAILED,
      subsystem: 'general',
      severity: 'error',
      recoverable: false,
      context: { source: opts.source, ...opts.context },
      cause: opts.cause,
    });
    this.name = 'ParseError';
    this.source = opts.source;
  }
}

// ── Type guards ──────────────────────────────────────────────────────

export function isWrongStackError(err: unknown): err is WrongStackError {
  return err instanceof WrongStackError;
}

export function isToolError(err: unknown): err is ToolError {
  return err instanceof ToolError;
}

export function isConfigError(err: unknown): err is ConfigError {
  return err instanceof ConfigError;
}

export function isPluginError(err: unknown): err is PluginError {
  return err instanceof PluginError;
}

export function isSessionError(err: unknown): err is SessionError {
  return err instanceof SessionError;
}

export function isAgentError(err: unknown): err is AgentError {
  return err instanceof AgentError;
}

export function isFsError(err: unknown): err is FsError {
  return err instanceof FsError;
}

export function isToolValidationError(err: unknown): err is ToolValidationError {
  return err instanceof ToolValidationError;
}

export function isFetchError(err: unknown): err is FetchError {
  return err instanceof FetchError;
}

export function isParseError(err: unknown): err is ParseError {
  return err instanceof ParseError;
}

export function isSddError(err: unknown): err is SddError {
  return err instanceof SddError;
}
