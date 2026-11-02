/**
 * HQ HTTP surface.
 *
 * Every dashboard request goes through here. A bare `fetch('/api/…')` 401s
 * whenever the server runs in browser-token mode — the default since first-run
 * auth — and, more importantly, would not raise the auth gate. The 401 handling
 * is the point of this module: HTTP and WebSocket share one gate, and a
 * rejected credential must surface as the TokenGate rather than as an empty view.
 */
import type {
  HqAlertRuleConfig,
  HqHealthPoint,
  HqNotifyChannelView,
  HqNotifySettingsView,
  HqSessionHistoryEntry,
} from '@wrongstack/hq';
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

/**
 * A non-2xx answer from HQ. The status travels with the error so a caller can
 * tell "refused" (401/403 — the same for every request) from a per-target
 * failure without parsing the message, which carries the server's own text.
 */
export class HqHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HqHttpError';
    this.status = status;
  }
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
    throw new HqHttpError(401, `401 Unauthorized fetching ${path} — browser token required`);
  }
  if (!response.ok) {
    throw new HqHttpError(response.status, `${response.status} ${await errorMessage(response)}`);
  }
  return readJson<T>(response, path);
}

async function postJson<T>(path: string, body: unknown, label: string): Promise<T> {
  return sendJson<T>(path, label, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function sendJson<T>(path: string, label: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await authorizedFetch(path, init);
  } catch {
    throw new Error(`Network error ${label}`);
  }
  if (response.status === 401) {
    raiseAuthGate();
    throw new HqHttpError(401, '401 Unauthorized — browser token required');
  }
  if (!response.ok) throw new HqHttpError(response.status, await errorMessage(response));
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

/**
 * Forget a machine HQ remembers but that has no connected client. The server
 * refuses a connected one (409): it would be learned again at once.
 */
export function forgetMachine(key: string): Promise<{ forgotten: string }> {
  return sendJson(`/api/machines/${encodeURIComponent(key)}`, 'forgetting the machine', {
    method: 'DELETE',
  });
}

/**
 * Replace a machine's operator labels (`[]` clears them). The server
 * lower-cases, de-duplicates and validates; it answers with what it stored.
 */
export function setMachineLabels(
  key: string,
  labels: readonly string[],
): Promise<{ key: string; labels: string[] }> {
  return sendJson(`/api/machines/${encodeURIComponent(key)}/labels`, 'saving the labels', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels }),
  });
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
 * The view layer (`packages/hq-next/src/features/events/events-view.tsx`) wires this
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
  /** Every process on one computer (the server's hostname-first machine key). */
  machineKey?: string | undefined;
  /** Exact match on the envelope's project. */
  projectId?: string | undefined;
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
  if (filters.machineKey !== undefined && filters.machineKey.length > 0) {
    params.set('machineKey', filters.machineKey);
  }
  if (filters.projectId !== undefined && filters.projectId.length > 0) {
    params.set('projectId', filters.projectId);
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

// ── Notification channels (`/api/notify*`, auth.admin) ─────────────────────

export function fetchNotifySettings(): Promise<HqNotifySettingsView> {
  return fetchJson<HqNotifySettingsView>('/api/notify');
}

export function saveNotifySettings(input: {
  publicUrl?: string | null;
  approvalDelaySeconds?: number;
}): Promise<HqNotifySettingsView> {
  return sendJson('/api/notify/settings', 'saving notification settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export interface NotifyChannelInput {
  name?: string;
  type?: HqNotifyChannelView['type'];
  url?: string;
  enabled?: boolean;
  kinds?: HqNotifyChannelView['kinds'];
  minSeverity?: HqNotifyChannelView['minSeverity'];
}

export function addNotifyChannel(input: NotifyChannelInput): Promise<HqNotifyChannelView> {
  return postJson('/api/notify/channels', input, 'adding the channel');
}

export function updateNotifyChannel(
  id: string,
  input: NotifyChannelInput,
): Promise<HqNotifyChannelView> {
  return sendJson(`/api/notify/channels/${encodeURIComponent(id)}`, 'updating the channel', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function removeNotifyChannel(id: string): Promise<{ removed: string }> {
  return sendJson(`/api/notify/channels/${encodeURIComponent(id)}`, 'removing the channel', {
    method: 'DELETE',
  });
}

export function testNotifyChannel(id: string): Promise<{ delivered: true }> {
  return postJson(`/api/notify/channels/${encodeURIComponent(id)}/test`, {}, 'testing the channel');
}

// ── Alert thresholds, daily budgets and snoozes ─────────────────────────────

/** Mirrors the server's `HqAlertSettingsView` (`/api/alerts/settings`). */
export interface AlertSettings {
  thresholds: HqAlertRuleConfig;
  base: HqAlertRuleConfig;
  snoozes: Record<string, number>;
  spend24h: {
    totalUsd: number;
    byProject: Record<string, number>;
    byMachine: Record<string, number>;
  };
}

export function fetchAlertSettings(): Promise<AlertSettings> {
  return fetchJson<AlertSettings>('/api/alerts/settings');
}

export function saveAlertThresholds(thresholds: HqAlertRuleConfig): Promise<AlertSettings> {
  return sendJson('/api/alerts/settings', 'saving alert rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thresholds }),
  });
}

export function snoozeAlertRule(ruleId: string, minutes: number): Promise<{ until: number }> {
  return postJson(
    `/api/alerts/rules/${encodeURIComponent(ruleId)}/snooze`,
    { minutes },
    'muting the rule',
  );
}

export function unsnoozeAlertRule(ruleId: string): Promise<{ unsnoozed: boolean }> {
  return sendJson(`/api/alerts/rules/${encodeURIComponent(ruleId)}/snooze`, 'unmuting the rule', {
    method: 'DELETE',
  });
}

// ── Client ("machine") tokens (`/api/machine-tokens`, auth.admin) ───────────

export interface MachineTokenRow {
  id: string;
  label?: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  /** null = a legacy token with no capability list (full client access). */
  capabilities: string[] | null;
  expired: boolean;
}

export function fetchMachineTokens(): Promise<{ tokenMode: boolean; tokens: MachineTokenRow[] }> {
  return fetchJson('/api/machine-tokens');
}

export interface MintedMachineToken {
  id: string;
  label: string;
  /** The secret, shown once. */
  token: string;
  capabilities: string[];
  expiresAt?: string;
}

export function mintMachineToken(input: {
  label: string;
  ttlDays: number;
  allowShell: boolean;
}): Promise<MintedMachineToken> {
  return postJson('/api/machine-tokens', input, 'creating the token');
}

export function revokeMachineToken(id: string): Promise<{ revoked: string }> {
  return sendJson(`/api/machine-tokens/${encodeURIComponent(id)}`, 'revoking the token', {
    method: 'DELETE',
  });
}

// ── Machine health over time (`/api/machines/health-history`) ───────────────

export function fetchHealthHistory(
  key: string,
  hours = 168,
): Promise<{ key: string; points: HqHealthPoint[] }> {
  const query = new URLSearchParams({ key, hours: String(hours) });
  return fetchJson(`/api/machines/health-history?${query.toString()}`);
}

/** Every machine's readings over the last 7 days, about 84 points each. */
export function fetchHealthOverview(): Promise<{
  machines: { key: string; points: HqHealthPoint[] }[];
}> {
  return fetchJson('/api/machines/health-overview');
}

// ── Ended sessions (`/api/sessions/history`) ────────────────────────────────

export function fetchSessionHistory(filters: {
  projectId?: string | undefined;
  machineKey?: string | undefined;
  limit?: number;
}): Promise<{ sessions: HqSessionHistoryEntry[] }> {
  const query = new URLSearchParams();
  if (filters.projectId) query.set('projectId', filters.projectId);
  if (filters.machineKey) query.set('machineKey', filters.machineKey);
  query.set('limit', String(filters.limit ?? 500));
  return fetchJson(`/api/sessions/history?${query.toString()}`);
}
