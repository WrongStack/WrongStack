import { describe, expect, it, vi } from 'vitest';

const runnerMock = vi.hoisted(() => ({
  calls: 0,
}));

vi.mock('../src/lint-gate/linter-runner.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lint-gate/linter-runner.js')>();
  return {
    ...orig,
    detectLinter: async () => {
      runnerMock.calls += 1;
      if (runnerMock.calls === 1) throw new Error('transient spawn failure');
      return null;
    },
  };
});

import plugin from '../src/lint-gate/index.js';

describe('lint-gate transient probe failure recovery (F363)', () => {
  it('clears cached linterProbe on rejection so subsequent hook calls retry', async () => {
    let preToolHook: ((input: Record<string, unknown>) => Promise<unknown>) | undefined;
    await plugin.setup({
      config: { extensions: {} },
      tools: { register: () => {} },
      registerHook: (event: string, _matcher: string, fn: never) => {
        if (event === 'PreToolUse') preToolHook = fn;
        return () => {};
      },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as never);

    await expect(
      preToolHook!({ toolName: 'write', toolInput: { filePath: 'a.ts', content: 'const x = 1;' } }),
    ).rejects.toThrow('transient spawn failure');

    const second = await preToolHook!({
      toolName: 'write',
      toolInput: { filePath: 'a.ts', content: 'const x = 1;' },
    });
    expect(second).toBeUndefined();
    expect(runnerMock.calls).toBe(2);
  });
});
