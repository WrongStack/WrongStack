import { describe, expect, it } from 'vitest';
import {
  createSurfaceConnectionState,
  DEFAULT_SURFACE_CONNECTION_CONFIG,
  planConnectionReconnect,
} from '../src/connection-fsm.js';

describe('planConnectionReconnect non-finite inputs', () => {
  it('sanitizes non-finite reconnectAttempt and now values', () => {
    const result = planConnectionReconnect(
      { ...createSurfaceConnectionState(), reconnectAttempt: Number.NaN },
      DEFAULT_SURFACE_CONNECTION_CONFIG,
      Number.NaN,
    );
    expect(result.plan).not.toBeNull();
    expect(Number.isFinite(result.plan?.attempt)).toBe(true);
    expect(Number.isFinite(result.plan?.delayMs)).toBe(true);
    expect(Number.isFinite(result.plan?.retryAt)).toBe(true);
  });
});
