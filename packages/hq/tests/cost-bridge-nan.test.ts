import { describe, expect, it } from 'vitest';
import { startCostTelemetryBridge } from '../src/cost-bridge.js';

describe('startCostTelemetryBridge non-finite usage/cost guard', () => {
  it('normalizes NaN/Infinity outputTokens and costUsd to 0 before publishing', () => {
    const handlers = new Map<string, (p: unknown) => void>();
    const events = {
      on: (event: string, fn: (p: unknown) => void) => {
        handlers.set(event, fn);
        return () => handlers.delete(event);
      },
    } as never;

    const published: Array<{ payload: Record<string, unknown> }> = [];
    const dispose = startCostTelemetryBridge({
      events,
      publisher: {
        publishEvent: (env: { payload: Record<string, unknown> }) => {
          published.push(env);
        },
      } as never,
    });

    handlers.get('token.accounted')?.({
      usage: { input: 100, output: Number.NaN },
      cost: { input: 0.01, output: 0.02, total: Number.POSITIVE_INFINITY },
    });
    dispose();

    expect(published[0]?.payload).toMatchObject({
      inputTokens: 100,
      outputTokens: 0,
      totalTokens: 100,
      costUsd: 0,
    });
  });
});
