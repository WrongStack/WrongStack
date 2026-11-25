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
  if (state.stopped) return state;
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
  const maxReconnectAttempts =
    config.maxReconnectAttempts === Infinity
      ? Infinity
      : finiteInteger(
          config.maxReconnectAttempts,
          DEFAULT_SURFACE_CONNECTION_CONFIG.maxReconnectAttempts,
        );
  const currentAttempt = finiteInteger(state.reconnectAttempt, 0);
  if (state.stopped || currentAttempt >= maxReconnectAttempts) {
    return { state: { ...state, phase: 'closed' }, plan: null };
  }
  const attempt = currentAttempt + 1;
  const initialBackoffMs = finiteNonNegative(
    config.initialBackoffMs,
    DEFAULT_SURFACE_CONNECTION_CONFIG.initialBackoffMs,
  );
  const maxBackoffMs = finiteNonNegative(
    config.maxBackoffMs,
    DEFAULT_SURFACE_CONNECTION_CONFIG.maxBackoffMs,
  );
  const backoffMultiplier = finitePositive(
    config.backoffMultiplier,
    DEFAULT_SURFACE_CONNECTION_CONFIG.backoffMultiplier,
  );
  const jitterRatio = Math.min(
    1,
    finiteNonNegative(config.jitterRatio, DEFAULT_SURFACE_CONNECTION_CONFIG.jitterRatio),
  );
  const base =
    initialBackoffMs === 0
      ? 0
      : Math.min(initialBackoffMs * backoffMultiplier ** (attempt - 1), maxBackoffMs);
  const randomValue = random();
  const sample = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0.5;
  const centeredJitter = (sample * 2 - 1) * jitterRatio;
  const delayMs = Math.min(maxBackoffMs, Math.max(0, Math.round(base * (1 + centeredJitter))));
  const safeNow = Number.isFinite(now) ? now : Date.now();
  return {
    state: { ...state, phase: 'reconnecting', reconnectAttempt: attempt },
    plan: { attempt, delayMs, retryAt: safeNow + delayMs },
  };
}

export function isConnectionHeartbeatTimedOut(
  state: SurfaceConnectionState,
  config: SurfaceConnectionConfig,
  now = Date.now(),
): boolean {
  if (state.phase !== 'open' || state.lastActivityAt === null) return false;
  if (!Number.isFinite(config.heartbeatIntervalMs) || config.heartbeatIntervalMs <= 0) return false;
  const timeoutMs = finiteNonNegative(
    config.heartbeatTimeoutMs,
    DEFAULT_SURFACE_CONNECTION_CONFIG.heartbeatTimeoutMs,
  );
  return now - state.lastActivityAt > config.heartbeatIntervalMs + timeoutMs;
}

export function enqueueBounded<T>(
  queue: readonly T[],
  item: T,
  limit: number,
): { queue: T[]; dropped: T | null } {
  const boundedLimit = Number.isSafeInteger(Math.floor(limit)) ? Math.max(0, Math.floor(limit)) : 0;
  if (boundedLimit <= 0) return { queue: [], dropped: item };
  if (queue.length < boundedLimit) return { queue: [...queue, item], dropped: null };
  return {
    queue: [...queue.slice(queue.length - boundedLimit + 1), item],
    dropped: queue[0] ?? null,
  };
}

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.floor(value) : fallback;
}
