export type SurfaceConnectionPhase = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SurfaceConnectionConfig {
  maxReconnectAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  backoffMultiplier: number;
  jitterRatio: number;
  queueLimit: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

export interface SurfaceConnectionState {
  phase: SurfaceConnectionPhase;
  reconnectAttempt: number;
  lastActivityAt: number | null;
  stopped: boolean;
}

export interface ReconnectPlan {
  attempt: number;
  delayMs: number;
  retryAt: number;
}

export const DEFAULT_SURFACE_CONNECTION_CONFIG: SurfaceConnectionConfig = {
  maxReconnectAttempts: 10,
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  backoffMultiplier: 2,
  jitterRatio: 0,
  queueLimit: 1_000,
  heartbeatIntervalMs: 0,
  heartbeatTimeoutMs: 0,
};

export function createSurfaceConnectionState(): SurfaceConnectionState {
  return { phase: 'idle', reconnectAttempt: 0, lastActivityAt: null, stopped: false };
}

export function markConnectionConnecting(state: SurfaceConnectionState): SurfaceConnectionState {
  if (state.stopped) return state;
  return { ...state, phase: 'connecting' };
}

export function markConnectionOpen(
  state: SurfaceConnectionState,
  now = Date.now(),
): SurfaceConnectionState {
  return {
    ...state,
    phase: 'open',
    reconnectAttempt: 0,
    lastActivityAt: now,
    stopped: false,
  };
}

export function markConnectionActivity(
  state: SurfaceConnectionState,
  now = Date.now(),
): SurfaceConnectionState {
  return { ...state, lastActivityAt: now };
}

export function stopConnection(state: SurfaceConnectionState): SurfaceConnectionState {
  return { ...state, phase: 'closed', stopped: true };
}

export function resetConnection(state: SurfaceConnectionState): SurfaceConnectionState {
  return { ...state, phase: 'idle', reconnectAttempt: 0, stopped: false };
}

export function planConnectionReconnect(
  state: SurfaceConnectionState,
  config: SurfaceConnectionConfig,
  now = Date.now(),
  random = Math.random,
): { state: SurfaceConnectionState; plan: ReconnectPlan | null } {
  if (state.stopped || state.reconnectAttempt >= config.maxReconnectAttempts) {
    return { state: { ...state, phase: 'closed' }, plan: null };
  }
  const attempt = state.reconnectAttempt + 1;
  const base = Math.min(
    config.initialBackoffMs * config.backoffMultiplier ** (attempt - 1),
    config.maxBackoffMs,
  );
  const centeredJitter = (random() * 2 - 1) * config.jitterRatio;
  const delayMs = Math.max(0, Math.round(base * (1 + centeredJitter)));
  return {
    state: { ...state, phase: 'reconnecting', reconnectAttempt: attempt },
    plan: { attempt, delayMs, retryAt: now + delayMs },
  };
}

export function isConnectionHeartbeatTimedOut(
  state: SurfaceConnectionState,
  config: SurfaceConnectionConfig,
  now = Date.now(),
): boolean {
  if (state.phase !== 'open' || state.lastActivityAt === null) return false;
  if (config.heartbeatIntervalMs <= 0) return false;
  return now - state.lastActivityAt > config.heartbeatIntervalMs + config.heartbeatTimeoutMs;
}

export function enqueueBounded<T>(
  queue: readonly T[],
  item: T,
  limit: number,
): { queue: T[]; dropped: T | null } {
  if (limit <= 0) return { queue: [], dropped: item };
  if (queue.length < limit) return { queue: [...queue, item], dropped: null };
  return { queue: [...queue.slice(queue.length - limit + 1), item], dropped: queue[0] ?? null };
}
