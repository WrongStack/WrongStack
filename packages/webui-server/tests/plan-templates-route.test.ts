import { describe, expect, it } from 'vitest';
import { handleWorklistRoute } from '../src/server/worklist-routes.js';

describe('plan.templates', () => {
  it('lists the built-in plan templates to the asking request', async () => {
    const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ws = { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)) };
    const handled = await handleWorklistRoute(
      ws as never,
      { type: 'plan.templates', payload: { requestId: 'r1' } } as never,
      {} as never,
    );
    expect(handled).toBe(true);
    expect(frames[0]?.type).toBe('plan.templates');
    expect(frames[0]?.payload['requestId']).toBe('r1');
    const templates = frames[0]?.payload['templates'] as Array<{ name: string; items: unknown[] }>;
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.every((row) => row.name && row.items.length > 0)).toBe(true);
  });
});

describe('worklist replies', () => {
  it('answer the asking request, so a client can wait for its own result', async () => {
    const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ws = { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)) };
    await handleWorklistRoute(
      ws as never,
      { type: 'plan.template_use', payload: { template: 'new-feature', requestId: 'r2' } } as never,
      {
        usePlanTemplate: (socket: { send: (raw: string) => void }) =>
          socket.send(
            JSON.stringify({
              type: 'key.operation_result',
              payload: { success: true, message: 'ok' },
            }),
          ),
      } as never,
    );
    expect(frames[0]?.payload['requestId']).toBe('r2');
  });
});
