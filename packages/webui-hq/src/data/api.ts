/**
 * HQ HTTP surface.
 *
 * Every dashboard request goes through here. A bare `fetch('/api/…')` 401s
 * whenever the server runs in browser-token mode — the default since first-run
 * auth — and, more importantly, would not raise the auth gate. The 401 handling
 * is the point of this module: HTTP and WebSocket share one gate, and a
 * rejected credential must surface as the TokenGate rather than as an empty view.
 */
import { authHeaders } from './auth/token-storage.js';
import { useHqStore } from './store/index.js';

/** `fetch` with the HQ credential attached. */
export function authorizedFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
    ...authHeaders(),
  };
  return fetch(input, { ...init, headers });
}

function raiseAuthGate(): void {
  useHqStore.getState().markAuthRequired();
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`Invalid JSON response from ${label}: ${response.status}`);
  }
}

/**
 * Read an error message the HQ server may have supplied, else a status line.
 *
 * The server answers in two shapes — `{error: "text"}` and
 * `{error: {code, message}}` — and only the first was read, so "Session not
 * found" reached the operator as a bare "404 Not Found".
 */
async function errorMessage(response: Response): Promise<string> {
  const fallback = response.statusText || `HTTP ${response.status}`;
  const body = (await response.json().catch(() => null)) as {
    error?: string | { message?: unknown };
  } | null;
  if (typeof body?.error === 'string') return body.error;
  if (typeof body?.error?.message === 'string') return body.error.message;
  return fallback;
}

export async function fetchJson<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await authorizedFetch(path);
  } catch {
    throw new Error(`Network error fetching ${path}`);
  }
  if (response.status === 401) {
    raiseAuthGate();
    throw new Error(`401 Unauthorized fetching ${path} — browser token required`);
  }
  if (!response.ok) throw new Error(`${response.status} ${await errorMessage(response)}`);
  return readJson<T>(response, path);
}

async function postJson<T>(path: string, body: unknown, label: string): Promise<T> {
  let response: Response;
  try {
    response = await authorizedFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Network error ${label}`);
  }
  if (response.status === 401) {
    raiseAuthGate();
    throw new Error('401 Unauthorized — browser token required');
  }
  if (!response.ok) throw new Error(await errorMessage(response));
  return readJson<T>(response, path);
}

export type MailboxSendType =
  | 'note'
  | 'ask'
  | 'assign'
  | 'steer'
  | 'btw'
  | 'queue'
  | 'broadcast'
  | 'status'
  | 'result'
  | 'review';

export interface MailboxSendInput {
  projectId?: string | undefined;
  sessionId?: string | undefined;
  type: MailboxSendType;
  to?: string | undefined;
  subject?: string | undefined;
  body: string;
  priority?: 'high' | 'normal' | 'low' | undefined;
  audience?: 'all' | 'leaders' | undefined;
}

export interface MailboxSendResult {
  delivered: boolean;
  messageId?: string;
  to: string;
  type: string;
  audience?: 'all' | 'leaders' | undefined;
}

export function postMailboxSend(input: MailboxSendInput): Promise<MailboxSendResult> {
  return postJson<MailboxSendResult>('/api/mailbox-send', input, 'sending mailbox message');
}

export interface CommandDispatchResult {
  commandId: string;
  queued: boolean;
}

export function postCommand(
  clientId: string,
  type: string,
  payload: unknown,
): Promise<CommandDispatchResult> {
  return postJson<CommandDispatchResult>(
    '/api/command',
    { clientId, type, payload },
    'sending command',
  );
}

/**
 * W5 #19 (RFC hq-improvements-2026-09.md): Event Log timeline view support.
 *
 * Fetches the most recent telemetry envelopes from the server with optional
 * filters. The server-side handler (`handleApiEvents` in
 * `packages/cli/src/hq-server/routes/data-handlers.ts`) accepts `type`,
 * `clientId`, and `machineId` query parameters and applies them to the
 * in-memory event-log snapshot. The handler caps `limit` at 5000 and
 * defaults to 200.
 *
 * The view layer (`packages/webui-hq/src/views/events.tsx`) wires this
 * to a filterable timeline with type / clientId / machineId / time-range
 * controls; the time range is resolved into `since`/`until` epoch-ms
 * values before this call so the server doesn't need to parse a date
 * format. Empty / undefined filters are omitted from the query string.
 */
export interface EventsResponse {
  events: ReadonlyArray<{
    type?: string;
    timestamp?: string;
    clientId?: string;
    machineId?: string;
    sessionId?: string;
    /**
     * W4 #4 — groups several envelopes into one logical activity (a Brain
     * decision request id, a fleet run id). Optional: envelopes without it are
     * simply uncorrelated, so the timeline must not require it.
     */
    correlationId?: string;
    payload?: unknown;
  }>;
  total: number;
}

export interface FetchEventsFilters {
  type?: string | undefined;
  clientId?: string | undefined;
  machineId?: string | undefined;
  /** Epoch ms lower bound (inclusive). Server filters events with timestamp < since. */
  sinceMs?: number | undefined;
  /** Epoch ms upper bound (inclusive). Server filters events with timestamp > until. */
  untilMs?: number | undefined;
  /** Max events to return (server caps at 5000, default 200). */
  limit?: number | undefined;
}

export function fetchEvents(filters: FetchEventsFilters = {}): Promise<EventsResponse> {
  const params = new URLSearchParams();
  if (filters.type !== undefined && filters.type.length > 0) {
    params.set('type', filters.type);
  }
  if (filters.clientId !== undefined && filters.clientId.length > 0) {
    params.set('clientId', filters.clientId);
  }
  if (filters.machineId !== undefined && filters.machineId.length > 0) {
    params.set('machineId', filters.machineId);
  }
  if (filters.sinceMs !== undefined) {
    params.set('since', String(filters.sinceMs));
  }
  if (filters.untilMs !== undefined) {
    params.set('until', String(filters.untilMs));
  }
  if (filters.limit !== undefined) {
    params.set('limit', String(filters.limit));
  }
  const query = params.toString();
  return fetchJson<EventsResponse>(query.length > 0 ? `/api/events?${query}` : '/api/events');
}
