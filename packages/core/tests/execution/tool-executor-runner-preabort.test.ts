import { describe, expect, it } from 'vitest';
import { runToolWithTimeout } from '../../src/execution/tool-executor-runner.js';

describe('runToolWithTimeout pre-aborted combined signal (F368)', () => {
  it('rejects promptly instead of wedging if signal aborts synchronously during execute()', async () => {
    const controller = new AbortController();
    const tool = {
      name: 'hang_after_abort',
      description: 'hang',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        controller.abort(new Error('cancelled during start'));
        return await new Promise(() => {});
      },
    };

    await expect(
      runToolWithTimeout(
        tool as never,
        {},
        controller.signal,
        { cwd: process.cwd() } as never,
        {} as never,
        {
          iterationTimeoutMs: 60_000,
          maxToolTimeoutMs: 60_000,
          progressEmitIntervalMs: 1000,
          progressTailChars: 100,
          progressHeadChars: 100,
        },
      ),
    ).rejects.toThrow('cancelled during start');
  });
});
