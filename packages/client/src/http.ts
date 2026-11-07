import type {
  ApiErrorBody,
  ApiSession,
  ApiSessionAgents,
  ApiSessionEvents,
  ApiSessionInterruptRequest,
  ApiSessionInterruptResponse,
  ApiSessionMessageRequest,
  ApiSessionMessageResponse,
} from '@wrongstack/webui-protocol';
import { kindForStatus, WrongStackError } from './errors.js';

export interface HttpClientOptions {
  /** The WebUI server, `http://127.0.0.1:3456`. */
  url: string;
  /** The access token, sent as `X-WS-Token`. */
  token?: string | undefined;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch | undefined;
}

/**
 * The HTTP session API: every live WrongStack session on the machine (not
 * only the ones this server runs), read from the cross-process registry.
 */
export interface WrongStackHttpClient {
  listLiveSessions(): Promise<ApiSession[]>;
  sessionAgents(sessionId: string): Promise<ApiSessionAgents>;
  sessionEvents(sessionId: string, limit?: number): Promise<ApiSessionEvents>;
  /** Delivered to the session's agent before its next model call. */
  messageSession(
    sessionId: string,
    message: ApiSessionMessageRequest,
  ): Promise<ApiSessionMessageResponse>;
  interruptSession(
    sessionId: string,
    request?: ApiSessionInterruptRequest,
  ): Promise<ApiSessionInterruptResponse>;
}

export function createHttpClient(options: HttpClientOptions): WrongStackHttpClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/^ws(s?):/i, (_, s: string) => `http${s.toLowerCase()}:`);
  let urlToken: string | undefined;
  try {
    urlToken = new URL(base).searchParams.get('token') || undefined;
  } catch {
    urlToken = undefined;
  }
  const effectiveToken = options.token || urlToken;

  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (effectiveToken) headers['X-WS-Token'] = effectiveToken;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    let targetUrl: URL;
    try {
      targetUrl = new URL(path, base);
    } catch (error) {
      throw new WrongStackError({
        kind: 'connection',
        code: 'invalid_url',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    let response: Response;
    try {
      response = await doFetch(targetUrl, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (error) {
      throw new WrongStackError({
        kind: 'connection',
        code: 'unreachable',
        detail: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new WrongStackError({
        kind: 'connection',
        code: 'response_body',
        detail: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
    if (!response.ok) {
      let detail = text;
      try {
        const errorBody = JSON.parse(text) as ApiErrorBody;
        detail = typeof errorBody.error === 'string' ? errorBody.error : text;
      } catch {
        // Some refusals are plain text.
      }
      throw new WrongStackError({
        kind: kindForStatus(response.status),
        code: String(response.status),
        ...(detail ? { detail } : {}),
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      });
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new WrongStackError({
        kind: 'protocol',
        code: 'invalid_json',
        detail: text.slice(0, 200),
      });
    }
  }

  const session = (id: string): string => {
    const trimmed = typeof id === 'string' ? id.trim() : '';
    if (!trimmed || trimmed === '.' || trimmed === '..') {
      throw new WrongStackError({
        kind: 'invalid',
        code: 'invalid_session_id',
        detail: `Invalid sessionId: ${JSON.stringify(id)}`,
      });
    }
    return `/api/sessions/${encodeURIComponent(trimmed)}`;
  };

  return {
    listLiveSessions: () => call<ApiSession[]>('/api/sessions'),
    sessionAgents: (id) => call<ApiSessionAgents>(`${session(id)}/agents`),
    sessionEvents: (id, limit) => {
      if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
        throw new WrongStackError({
          kind: 'invalid',
          code: 'invalid_limit',
          detail: `Invalid limit: ${String(limit)}`,
        });
      }
      return call<ApiSessionEvents>(
        `${session(id)}/events${limit !== undefined ? `?limit=${Math.trunc(limit)}` : ''}`,
      );
    },
    messageSession: (id, message) =>
      call<ApiSessionMessageResponse>(`${session(id)}/message`, { method: 'POST', body: message }),
    interruptSession: (id, request = {}) =>
      call<ApiSessionInterruptResponse>(`${session(id)}/interrupt`, {
        method: 'POST',
        body: request,
      }),
  };
}
