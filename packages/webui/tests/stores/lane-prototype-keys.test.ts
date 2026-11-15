import { describe, expect, it } from 'vitest';
import { chatLane } from '../../src/stores/chat-lanes.js';
import { sessionLane } from '../../src/stores/session-lanes.js';

describe('lane stores with Object.prototype key names (F361, F362)', () => {
  it('chatLane handles prototype-named sessionId like "toString" without throwing', () => {
    expect(() =>
      chatLane('toString').addMessage({ role: 'user', content: 'hello' } as never),
    ).not.toThrow();
    expect(chatLane('toString').messages.length).toBeGreaterThanOrEqual(1);
  });

  it('sessionLane handles prototype-named sessionId like "toString" without corrupting data', () => {
    expect(() =>
      sessionLane('toString').updateUsage({ input: 10, output: 5 } as never),
    ).not.toThrow();
    const data = sessionLane('toString').data;
    expect(typeof data).toBe('object');
    expect(data).not.toBeNull();
    expect(data.totalTokens.input).toBeGreaterThanOrEqual(10);
  });
});
