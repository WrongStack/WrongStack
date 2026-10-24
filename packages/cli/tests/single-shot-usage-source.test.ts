import { EventBus } from '@wrongstack/contracts/kernel';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const output = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('@wrongstack/core/utils', async (original) => ({
  ...(await original<object>()),
  writeOut: output.write,
}));
vi.mock('@wrongstack/tools', () => ({ getProcessRegistry: () => ({ killAll: vi.fn() }) }));

import { runSingleShotDispatch } from '../src/boot/dispatch-singleshot.js';

beforeEach(() => output.write.mockReset());
describe('single-shot usage pricing provenance', () => {
  it.each([true, false])('marks pricing coverage explicitly (priced=%s)', async (priced) => {
    const events = new EventBus();
    let ran = false;
    const counter = {
      total: () => ({ input: ran ? 10 : 0, output: ran ? 5 : 0 }),
      estimateCost: () => ({ total: 0 }),
    };
    const agent = {
      ctx: { session: { id: 's' } },
      run: async () => {
        ran = true;
        events.emit('token.accounted', {
          sessionId: 's',
          usage: { input: 10, output: 5 },
          deltaUsage: { input: 10, output: 5 },
          cost: { input: 0, output: 0, total: 0 },
          ...(priced ? { deltaCost: { input: 0, output: 0, total: 0 } } : {}),
        });
        return { status: 'done', finalText: 'Result', iterations: 1 };
      },
    };
    expect(
      await runSingleShotDispatch({
        agent,
        query: 'test',
        flags: { 'output-json': true },
        tokenCounter: counter,
        renderer: { writeError: vi.fn() },
        events,
      } as unknown as Parameters<typeof runSingleShotDispatch>[0]),
    ).toBe(0);
    const result = JSON.parse(output.write.mock.calls.at(-1)![0] as string);
    expect(result.usage).toMatchObject({
      input: 10,
      output: 5,
      cost: 0,
      costSource: priced ? 'catalog-estimate' : 'unknown',
    });
  });
});
