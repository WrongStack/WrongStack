import { describe, expect, it } from 'vitest';
import { launchBuiltinRound } from '../src/lib/launch-builtin-round.js';

describe('launchBuiltinRound timeout clamping (F378)', () => {
  it('clamps timeoutMs above 32-bit signed max instead of firing error in 1ms', async () => {
    const listeners = new Map<string, Array<(msg: { payload?: unknown }) => void>>();
    const client = {
      on: (event: string, fn: (msg: { payload?: unknown }) => void) => {
        const arr = listeners.get(event) ?? [];
        arr.push(fn);
        listeners.set(event, arr);
        return () => {};
      },
      send: (msg: { type: string; payload?: unknown }) => {
        if (msg.type === 'prompts.content') {
          setTimeout(() => {
            for (const fn of listeners.get('prompts.content') ?? []) {
              fn({ payload: { slug: 'bughunt', found: true, content: 'Run audit' } });
            }
          }, 30);
        }
      },
      sendMessage: () => 'm1',
    };

    const settledState = await new Promise<string>((resolve) => {
      launchBuiltinRound({
        client: client as never,
        slug: 'bughunt',
        requireSoloSession: false,
        subagentsAllowed: true,
        compose: (c) => c,
        onSent: () => {},
        onSettle: (state) => resolve(state),
        timeoutMs: 3_000_000_000,
      });
    });

    expect(settledState).toBe('idle');
  });
});
