/**
 * Shared constants for the MCP package.
 *
 * Centralizing these values means:
 * - Protocol version and client identity are updated in one place
 * - Reconnect parameters can be overridden via config in the future
 * - No scattered magic values across multiple files
 */
export const MCP_CONSTANTS = Object.freeze({
  /** MCP protocol version advertised during handshake. */
  PROTOCOL_VERSION: '2024-11-05',

  /** Identity announced to MCP servers during `initialize`. */
  CLIENT_INFO: Object.freeze({
    name: 'wrongstack',
    version: '0.1.10',
  }),

  /** Reconnection behaviour when a transport disconnects. */
  RECONNECT: Object.freeze({
    /** Max full reconnect cycles before the slot is marked `failed`. */
    MAX_CYCLES: 5,
    /** Base delay between cycles (exponential backoff applied on top). */
    BASE_DELAY_MS: 1000,
    /** Jitter factor applied to the backoff (0 = no jitter, 1 = full). */
    JITTER_FACTOR: 0.2,
    /** Max connection attempts within a single cycle. */
    MAX_ATTEMPTS: 3,
    /** Base multiplier for the exponential backoff formula (`delay = BASE * multiplier^attempt`). */
    BACKOFF_MULTIPLIER: 2,
  }),

  /** Timing for graceful / forced disconnect. */
  DISCONNECT: Object.freeze({
    /** Ms to wait for in-flight requests to complete before force-closing. */
    GRACEFUL_MS: 800,
    /** Ms after which the force disconnect is triggered. */
    FORCE_TIMEOUT_MS: 1200,
  }),

  /** Lazy-connect idle lifecycle. */
  IDLE: Object.freeze({
    /** Default ms a lazy server stays connected with no tool calls before auto-sleep. */
    DEFAULT_TIMEOUT_MS: 300_000,
    /** How often the idle sweep runs (kept well below the timeout). */
    SWEEP_INTERVAL_MS: 30_000,
  }),

  /** JSON-RPC response timeout for outstanding requests. */
  RESPONSE_TIMEOUT_MS: 500,

  /** Max buffer size for the SSE reader. */
  SSE_READER_MAX_BUFFER: 256 * 1024,

  /** Max characters logged from a request body. */
  REQUEST_LOG_CAP: 1024,
} as const);
