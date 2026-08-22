import {
  createSurfaceConnectionState,
  DEFAULT_SURFACE_CONNECTION_CONFIG,
  enqueueBounded,
  isConnectionHeartbeatTimedOut,
  markConnectionActivity,
  markConnectionOpen,
  planConnectionReconnect,
  stopConnection,
} from '@wrongstack/webui-protocol';
import { describe, expect, it } from 'vitest';

describe('surface connection FSM', () => {
  it('plans deterministic capped exponential reconnects', () => {
    const config = {
      ...DEFAULT_SURFACE_CONNECTION_CONFIG,
      maxReconnectAttempts: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 250,
    };
    let state = createSurfaceConnectionState();
    const delays: number[] = [];
    for (let index = 0; index < 3; index++) {
      const result = planConnectionReconnect(state, config, 1_000, () => 0.5);
      state = result.state;
      delays.push(result.plan?.delayMs ?? -1);
    }
    expect(delays).toEqual([100, 200, 250]);
    expect(planConnectionReconnect(state, config).plan).toBeNull();
  });

  it('resets attempts on open and suppresses reconnect after stop', () => {
    const first = planConnectionReconnect(
      createSurfaceConnectionState(),
      DEFAULT_SURFACE_CONNECTION_CONFIG,
    ).state;
    expect(markConnectionOpen(first, 100)).toMatchObject({
      phase: 'open',
      reconnectAttempt: 0,
      lastActivityAt: 100,
    });
    expect(
      planConnectionReconnect(stopConnection(first), DEFAULT_SURFACE_CONNECTION_CONFIG).plan,
    ).toBeNull();
  });

  it('detects silent connections only when heartbeat is enabled', () => {
    const state = markConnectionActivity(
      markConnectionOpen(createSurfaceConnectionState(), 10),
      20,
    );
    expect(
      isConnectionHeartbeatTimedOut(
        state,
        { ...DEFAULT_SURFACE_CONNECTION_CONFIG, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 25 },
        146,
      ),
    ).toBe(true);
    expect(isConnectionHeartbeatTimedOut(state, DEFAULT_SURFACE_CONNECTION_CONFIG, 10_000)).toBe(
      false,
    );
  });

  it('bounds queues with FIFO eviction', () => {
    expect(enqueueBounded(['a', 'b'], 'c', 2)).toEqual({
      queue: ['b', 'c'],
      dropped: 'a',
    });
  });
});
