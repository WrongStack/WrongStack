/**
 * Shared constants for the MCP package.
 *
 * Centralizing these values means:
 * - Protocol version and client identity are updated in one place
 * - Reconnect parameters can be overridden via config in the future
 * - No scattered magic values across multiple files
 */
/**
 * Protocol revisions this package actually implements, newest first.
 *
 * Deliberately conservative: a revision belongs here only once its wire
 * requirements are met, because the version we send in `initialize` is a
 * promise about what the peer may then use. WrongStack speaks the 2024-11-05
 * shape — tools, resources, prompts, sampling — and does not implement the
 * additions of later revisions (elicitation, structured tool output, resource
 * links), so listing one of those would advertise capabilities that are not
 * there.
 *
 * Adding a revision: implement its additions, then put it at the FRONT.
 * `PROTOCOL_VERSION` follows automatically, and the negotiation below starts
 * accepting a peer that asks for it.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = Object.freeze(['2024-11-05']);

/**
 * Pick the version to answer an `initialize` with.
 *
 * The spec's rule: echo what the peer asked for when it is supported,
 * otherwise reply with our own latest and let the peer decide whether it can
 * continue. Before this existed the server ignored the request entirely and
 * always answered `2024-11-05`, so a peer that asked for a newer revision was
 * told it had been granted nothing of the sort — silently, with no way to see
 * the mismatch.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return MCP_CONSTANTS.PROTOCOL_VERSION;
}

export const MCP_CONSTANTS = Object.freeze({
  /** MCP protocol version advertised during handshake: the newest we implement. */
  PROTOCOL_VERSION: SUPPORTED_PROTOCOL_VERSIONS[0] as string,

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
