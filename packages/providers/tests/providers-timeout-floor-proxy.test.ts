import { describe, expect, it } from 'vitest';
import { SLOW_BACKEND_HANG_TIMEOUT_MS, streamBudget } from '../src/stream-timeout-floors.js';
import { DEFAULT_STREAM_HANG_TIMEOUT_MS } from '../src/stream-timeouts.js';

describe('streamBudget proxy upstream host resolution (F2251)', () => {
  it('preserves slow-backend timeout floor when baseUrl is rewritten through WrongTrace proxy', () => {
    const budget = streamBudget(
      'hang',
      DEFAULT_STREAM_HANG_TIMEOUT_MS,
      false,
      'custom-gateway',
      'http://localhost:3444/proxy/api.minimax.io/v1',
    );
    expect(budget).toBe(SLOW_BACKEND_HANG_TIMEOUT_MS);
  });
});
