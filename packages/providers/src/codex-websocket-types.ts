import type { Request, StreamEvent } from '@wrongstack/contracts/types';

/**
 * Response metadata surfaced by a Codex Responses stream.
 *
 * Shared by HTTP and WebSocket through a type-only leaf. The provider and
 * WebSocket modules re-export their existing public type names.
 */
export interface CodexResponseMetadata {
  /** Response metadata headers surfaced by the Responses stream. */
  headers: Readonly<Record<string, string>>;
  /** Provider request id, when the backend supplies one. */
  requestId?: string | undefined;
  /** Server-selected model, when the backend supplies one. */
  model?: string | undefined;
}

export interface CodexWebSocketOptions {
  headers: Record<string, string>;
  signal: AbortSignal;
  /** Never follow redirects on an authenticated WebSocket handshake. */
  followRedirects?: boolean | undefined;
  /** Opening-handshake deadline (ms). The frame watchdog only starts after open. */
  handshakeTimeoutMs?: number | undefined;
}

type CodexWebSocketListener = {
  bivarianceHack(...args: unknown[]): void;
}['bivarianceHack'];

export interface CodexWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: string, listener: CodexWebSocketListener): CodexWebSocketLike;
  once(event: string, listener: CodexWebSocketListener): CodexWebSocketLike;
  removeListener(event: string, listener: CodexWebSocketListener): CodexWebSocketLike;
}

export type CodexWebSocketFactory = (
  url: string,
  options: CodexWebSocketOptions,
) => CodexWebSocketLike;

export type CodexResponsesParser = (
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
  providerId: string,
  onMetadata?: ((metadata: CodexResponseMetadata) => void) | undefined,
) => AsyncIterable<StreamEvent>;

export interface CodexWebSocketStreamOptions {
  url: string;
  headers: Record<string, string>;
  request: Request;
  body: Record<string, unknown>;
  fallbackModel: string;
  providerId: string;
  signal: AbortSignal;
  /** Best-effort connection prewarm before the first real response.create. */
  prewarm?: boolean | undefined;
  /** Correlates opt-in transport diagnostics with request/usage records. */
  probeRequestId?: string | undefined;
  /**
   * Max silence between WebSocket frames before the turn fails (pre-output
   * failures fall back to SSE). Defaults to `DEFAULT_STALL_TIMEOUT_MS`; `0`
   * disables the watchdog.
   */
  stallTimeoutMs?: number | undefined;
  /**
   * Sticky-routing token for the turn this request belongs to, replayed as
   * `client_metadata['x-codex-turn-state']`.
   *
   * Owned by the caller, not the connection: a turn spans several requests and
   * the connection cannot tell which of them start a new one. This used to be
   * connection-local state that `stream()` cleared on entry, so nothing but a
   * prewarm could ever populate it and the token was never actually sent.
   */
  turnState?: string | undefined;
  /** Receives the turn state the backend published in `response.metadata`. */
  onTurnState?: ((turnState: string) => void) | undefined;
  onMetadata?: ((metadata: CodexResponseMetadata) => void) | undefined;
  onHeaders?: ((headers: Headers) => void) | undefined;
}
