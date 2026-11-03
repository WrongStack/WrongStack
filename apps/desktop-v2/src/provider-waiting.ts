import { entries, record } from './engine-values';

/** A provider/model pair the engine's health tracker is holding back from routing. */
export interface WaitingPair {
  providerId: string;
  model: string;
  state: 'degraded' | 'blocked';
  reason: string;
  stateExpiresAt?: number;
  lastErrorMessage?: string;
  lastErrorStatus?: number;
  totalFailures?: number;
  consecutiveFailures?: number;
  rateLimitHits?: number;
  lastFailureAt?: number;
  recentErrors?: { timestamp: number; kind: string; status: number; message: string }[];
}

export type WaitingRoom = Record<string, WaitingPair>;

const keyOf = (providerId: string, model: string) => `${providerId}\u0000${model}`;
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Drops the fields a frame did not carry, so an update never erases what a snapshot said. */
function defined(pair: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(pair).filter(([, value]) => value !== undefined));
}

function waitingState(value: unknown) {
  return value === 'blocked' || value === 'degraded' ? value : null;
}

function snapshotPair(raw: unknown): WaitingPair | null {
  const item = record(raw);
  const providerId = text(item['providerId']);
  const model = text(item['model']);
  const state = waitingState(item['state']);
  if (!providerId || !model || !state) return null;
  return {
    providerId,
    model,
    state,
    reason: text(item['lastErrorKind']) ?? state,
    ...(defined({
      stateExpiresAt: count(item['stateExpiresAt']),
      lastErrorMessage: text(item['lastErrorMessage']),
      lastErrorStatus: count(item['lastErrorStatus']),
      totalFailures: count(item['totalFailures']),
      consecutiveFailures: count(item['consecutiveFailures']),
      rateLimitHits: count(item['rateLimitHits']),
      lastFailureAt: count(item['lastFailureAt']),
    }) as Partial<WaitingPair>),
    ...(Array.isArray(item['recentErrors'])
      ? {
          recentErrors: entries(item['recentErrors']).map((error) => ({
            timestamp: count(error['timestamp']) ?? 0,
            kind: String(error['kind'] ?? ''),
            status: count(error['status']) ?? 0,
            message: String(error['message'] ?? ''),
          })),
        }
      : {}),
  };
}

/**
 * Folds the health tracker's frames into the pairs waiting for a limit reset, as the WebUI's
 * provider status store does: a `provider.status.snapshot` replaces the room, and each
 * `provider.status_changed` moves one pair in or out of it. Healthy pairs are not kept.
 */
export function reduceWaitingRoom(
  room: WaitingRoom,
  type: string,
  payload: Record<string, unknown>,
): WaitingRoom {
  if (type === 'provider.status.snapshot') {
    if (payload['error'] !== undefined || !Array.isArray(payload['statuses'])) return room;
    const next: WaitingRoom = {};
    for (const raw of payload['statuses']) {
      const pair = snapshotPair(raw);
      if (pair) next[keyOf(pair.providerId, pair.model)] = pair;
    }
    return next;
  }
  if (type !== 'provider.status_changed') return room;
  const providerId = text(payload['providerId']);
  const model = text(payload['model']);
  if (!providerId || !model) return room;
  const key = keyOf(providerId, model);
  const state = waitingState(payload['newState']);
  if (!state) {
    if (!(key in room)) return room;
    const { [key]: _recovered, ...rest } = room;
    return rest;
  }
  return {
    ...room,
    [key]: {
      ...room[key],
      ...(defined({
        providerId,
        model,
        state,
        reason: text(payload['reason']) ?? state,
        stateExpiresAt: count(payload['stateExpiresAt']),
        lastErrorMessage: text(payload['lastErrorMessage']),
        lastErrorStatus: count(payload['lastErrorStatus']),
      }) as Omit<WaitingPair, 'recentErrors'>),
    },
  };
}

/** Time left before the tracker re-probes a pair, as the WebUI's room words it. */
export function waitRemaining(expiresAt: number | undefined, now: number): string {
  if (!expiresAt) return 'reset time unknown';
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  if (seconds === 0) return 'rechecking now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const SIBLING_TRIGGER = /Sibling quarantine:.*?\bon\s+([^\s/]+\/\S+)/;

/** For a sibling-quarantined pair, the provider/model whose quota failure blocked it. */
export function siblingTrigger(pair: Pick<WaitingPair, 'lastErrorMessage'>): string | null {
  return SIBLING_TRIGGER.exec(pair.lastErrorMessage ?? '')?.[1] ?? null;
}
