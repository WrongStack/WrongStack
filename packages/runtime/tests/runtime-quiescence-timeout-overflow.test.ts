import { describe, expect, it } from 'vitest';
import { installPluginToolQuiescence } from '../src/plugin-host/plugin-quiescence.js';

describe('installPluginToolQuiescence 32-bit timeout cap (F2243)', () => {
  it('caps oversized timeoutMs instead of overflowing setTimeout to 1ms', async () => {
    let finishTool!: () => void;
    const tool = {
      name: 'demo_tool',
      execute: async () => {
        await new Promise<void>((r) => {
          finishTool = r;
        });
        return { output: 'ok' };
      },
    };

    const waitQuiescent = installPluginToolQuiescence(undefined, {
      listWithOwner: () => [{ tool: tool as never, owner: 'plug-a' }],
      resolveName: (n: string) => n,
    });

    const execPromise = tool.execute();
    const start = Date.now();
    setTimeout(() => finishTool(), 60);
    await waitQuiescent('plug-a', 1e15);
    const elapsed = Date.now() - start;
    await execPromise;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});
