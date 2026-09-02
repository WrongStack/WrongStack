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

/** Read an error message the HQ server may have supplied, else a status line. */
async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (typeof body?.error === 'string') return body.error;
  return response.statusText || `HTTP ${response.status}`;
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
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
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
