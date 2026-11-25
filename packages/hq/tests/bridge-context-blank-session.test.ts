import { describe, expect, it } from 'vitest';
import { createBridgeContext } from '../src/bridge-context.js';
import type { HqPublisher } from '../src/publisher.js';

describe('createBridgeContext.sessionIdTag (F2196)', () => {
  it('falls back to bridgeSessionId when eventSessionId is whitespace-only', () => {
    const ctx = createBridgeContext({
      publisher: { publishEvent() {} } as unknown as HqPublisher,
      sessionId: 'bridge-sess',
    });
    expect(ctx.sessionIdTag('   ')).toEqual({ sessionId: 'bridge-sess' });
    expect(ctx.sessionIdTag('  ev-1  ')).toEqual({ sessionId: 'ev-1' });
  });
});
