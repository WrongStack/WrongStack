/**
 * Regression tests for the surface connection FSM.
 *
 * These pure functions back every WebSocket/SSE client lifecycle in
 * @wrongstack/webui (and the new @wrongstack/simpleui). The reconnect
 * backoff math, heartbeat timeout, and bounded enqueue are easy to break
 * silently — drift here means reconnect storms and dropped messages in
 * production.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SURFACE_CONNECTION_CONFIG,
  createSurfaceConnectionState,
  enqueueBounded,
  isConnectionHeartbeatTimedOut,
  markConnectionActivity,
  markConnectionConnecting,
  markConnectionOpen,
  planConnectionReconnect,
  resetConnection,
  stopConnection,
} from '../src/index.js';

describe('createSurfaceConnectionState', () => {
  it('returns the idle initial state', () => {
    const state = createSurfaceConnectionState();
    expect(state).toEqual({
      phase: 'idle',
      reconnectAttempt: 0,
      lastActivityAt: null,
      stopped: false,
    });
  });
});

describe('state transitions', () => {
  it('markConnectionConnecting skips stopped connections', () => {
    const stopped = stopConnection(createSurfaceConnectionState());
    expect(markConnectionConnecting(stopped)).toBe(stopped);
  });

  it('markConnectionConnecting moves to connecting', () => {
    const state = markConnectionConnecting(createSurfaceConnectionState());
    expect(state.phase).toBe('connecting');
  });

  it('markConnectionOpen resets reconnectAttempt and stamps lastActivityAt', () => {
    const state = markConnectionConnecting(createSurfaceConnectionState());
    const opened = markConnectionOpen(state, 1000);
    expect(opened.phase).toBe('open');
    expect(opened.reconnectAttempt).toBe(0);
    expect(opened.lastActivityAt).toBe(1000);
  });

  it('markConnectionActivity only updates lastActivityAt', () => {
    const opened = markConnectionOpen(createSurfaceConnectionState(), 1000);
    const active = markConnectionActivity(opened, 2000);
    expect(active.phase).toBe('open');
    expect(active.lastActivityAt).toBe(2000);
  });

  it('stopConnection transitions to closed and stops', () => {
    const opened = markConnectionOpen(createSurfaceConnectionState());
    const stopped = stopConnection(opened);
    expect(stopped.phase).toBe('closed');
    expect(stopped.stopped).toBe(true);
  });

  it('resetConnection returns to idle but preserves stopped=false', () => {
    const opened = markConnectionOpen(createSurfaceConnectionState());
    const reset = resetConnection(opened);
    expect(reset.phase).toBe('idle');
    expect(reset.reconnectAttempt).toBe(0);
    expect(reset.stopped).toBe(false);
  });
});

describe('planConnectionReconnect', () => {
  it('returns plan:null when stopped', () => {
    const stopped = stopConnection(createSurfaceConnectionState());
    const { plan } = planConnectionReconnect(stopped, DEFAULT_SURFACE_CONNECTION_CONFIG, 1000);
    expect(plan).toBeNull();
  });

  it('returns plan:null when attempts exhausted', () => {
    const state = { ...createSurfaceConnectionState(), reconnectAttempt: 999 };
    const { plan } = planConnectionReconnect(state, DEFAULT_SURFACE_CONNECTION_CONFIG, 1000);
    expect(plan).toBeNull();
  });

  it('grows backoff exponentially up to the cap', () => {
    const cfg = { ...DEFAULT_SURFACE_CONNECTION_CONFIG, jitterRatio: 0 };
    let state = createSurfaceConnectionState();
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const next = planConnectionReconnect(state, cfg, 10_000, () => 0.5);
      state = next.state;
      if (!next.plan) break;
      delays.push(next.plan.delayMs);
    }
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(2000);
    expect(delays[2]).toBe(4000);
    expect(delays[3]).toBe(8000);
    expect(delays[4]).toBe(16000);
  });

  it('clamps at maxBackoffMs', () => {
    const cfg = {
      ...DEFAULT_SURFACE_CONNECTION_CONFIG,
      jitterRatio: 0,
      maxBackoffMs: 5000,
    };
    let state = createSurfaceConnectionState();
    for (let i = 0; i < 6; i++) {
      const next = planConnectionReconnect(state, cfg, 10_000, () => 0.5);
      state = next.state;
      if (!next.plan) break;
      expect(next.plan.delayMs).toBeLessThanOrEqual(5000);
    }
  });

  it('applies symmetric jitter centered on the base delay', () => {
    const cfg = { ...DEFAULT_SURFACE_CONNECTION_CONFIG, jitterRatio: 0.5 };
    const state = createSurfaceConnectionState();
    const { plan } = planConnectionReconnect(state, cfg, 0, () => 1);
    expect(plan).not.toBeNull();
    expect(plan!.delayMs).toBe(1500);
  });

  it('never produces a negative delay', () => {
    const cfg = { ...DEFAULT_SURFACE_CONNECTION_CONFIG, jitterRatio: 1 };
    const state = createSurfaceConnectionState();
    const { plan } = planConnectionReconnect(state, cfg, 0, () => 0);
    expect(plan).not.toBeNull();
    expect(plan!.delayMs).toBeGreaterThanOrEqual(0);
  });

  it('retryAt equals now + delayMs', () => {
    const cfg = { ...DEFAULT_SURFACE_CONNECTION_CONFIG, jitterRatio: 0 };
    const { plan } = planConnectionReconnect(createSurfaceConnectionState(), cfg, 12345);
    expect(plan?.retryAt).toBe(12345 + (plan?.delayMs ?? 0));
  });
});

describe('isConnectionHeartbeatTimedOut', () => {
  const cfg = { ...DEFAULT_SURFACE_CONNECTION_CONFIG, heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 500 };

  it('returns false when not open', () => {
    const state = createSurfaceConnectionState();
    expect(isConnectionHeartbeatTimedOut(state, cfg, 5000)).toBe(false);
  });

  it('returns false when lastActivityAt is null', () => {
    const state = { ...createSurfaceConnectionState(), phase: 'open' as const };
    expect(isConnectionHeartbeatTimedOut(state, cfg, 5000)).toBe(false);
  });

  it('returns false when heartbeat is disabled', () => {
    const off = { ...DEFAULT_SURFACE_CONNECTION_CONFIG, heartbeatIntervalMs: 0 };
    const state = { ...createSurfaceConnectionState(), phase: 'open' as const, lastActivityAt: 1000 };
    expect(isConnectionHeartbeatTimedOut(state, off, 5000)).toBe(false);
  });

  it('returns false inside the heartbeat + timeout window', () => {
    const state = { ...createSurfaceConnectionState(), phase: 'open' as const, lastActivityAt: 1000 };
    expect(isConnectionHeartbeatTimedOut(state, cfg, 1500)).toBe(false);
  });

  it('returns true past heartbeatIntervalMs + heartbeatTimeoutMs', () => {
    const state = { ...createSurfaceConnectionState(), phase: 'open' as const, lastActivityAt: 1000 };
    // strict > comparison: at exactly (interval + timeout) the timer is not yet
    // considered expired. One ms past the boundary it is.
    expect(isConnectionHeartbeatTimedOut(state, cfg, 2501)).toBe(true);
  });
});

describe('enqueueBounded', () => {
  it('drops the item when limit <= 0', () => {
    const result = enqueueBounded([1, 2], 3, 0);
    expect(result).toEqual({ queue: [], dropped: 3 });
  });

  it('appends when under the limit', () => {
    const result = enqueueBounded([1, 2], 3, 5);
    expect(result).toEqual({ queue: [1, 2, 3], dropped: null });
  });

  it('drops the oldest item when at the limit', () => {
    const result = enqueueBounded([1, 2, 3], 4, 3);
    expect(result.dropped).toBe(1);
    expect(result.queue).toEqual([2, 3, 4]);
  });

  it('keeps the most recent N items when oversubscribed', () => {
    const result = enqueueBounded([1, 2, 3, 4, 5], 6, 3);
    expect(result.dropped).toBe(1);
    expect(result.queue).toEqual([4, 5, 6]);
  });
});
