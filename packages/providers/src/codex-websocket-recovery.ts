import type { ProviderError } from '@wrongstack/contracts/types';
import { isPlainObject } from './object-utils.js';

/** A pre-output WS failure is safe to retry over SSE without duplicate output. */
export class CodexWebSocketFallbackError extends Error {
  override readonly name = 'CodexWebSocketFallbackError';
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message, { cause });
  }
}

export type WebSocketRecoveryCode =
  | 'previous_response_not_found'
  | 'websocket_connection_limit_reached';

/** Internal signal: reconnect once before degrading this session to HTTP. */
export class CodexWebSocketRecoveryError extends CodexWebSocketFallbackError {
  constructor(
    readonly code: WebSocketRecoveryCode,
    cause: ProviderError,
    readonly canReconnect: boolean,
  ) {
    super('Codex WebSocket continuation state expired', cause);
  }
}

function recoveryCode(value: unknown): WebSocketRecoveryCode | undefined {
  return value === 'previous_response_not_found' || value === 'websocket_connection_limit_reached'
    ? value
    : undefined;
}

/** Only an explicit server code permits replay, never words in an error message. */
export function webSocketRecoveryCode(error: ProviderError): WebSocketRecoveryCode | undefined {
  const flattened = recoveryCode(error.body?.type) ?? recoveryCode(error.body?.code);
  if (flattened) return flattened;
  try {
    const parsed: unknown = JSON.parse(error.body?.raw ?? '');
    if (!isPlainObject(parsed)) return undefined;
    const response = isPlainObject(parsed['response']) ? parsed['response'] : {};
    const status = isPlainObject(response['status_details']) ? response['status_details'] : {};
    const nested = parsed['error'] ?? response['error'] ?? status['error'];
    const fields = isPlainObject(nested) ? nested : parsed;
    return recoveryCode(fields['code']) ?? recoveryCode(fields['type']);
  } catch {
    // Truncated/non-JSON diagnostics cannot establish a safe reconnect reason.
    return undefined;
  }
}
