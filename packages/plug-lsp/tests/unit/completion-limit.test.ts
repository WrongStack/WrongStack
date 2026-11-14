import { describe, expect, it } from 'vitest';
import { createCompletionTool } from '../../src/tools/completion.js';

describe('lsp_completion limit clamping (F245)', () => {
  it('clamps negative and NaN limits instead of slicing from end or returning empty', async () => {
    const deps = {
      registry: {
        findForPath: async () => ({
          name: 'mock-lsp',
          capabilities: { completionProvider: {} },
          completion: async () => [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }],
        }),
      },
      tracker: { open: async () => {} },
    };
    const tool = createCompletionTool(deps as never);
    const ctx = { cwd: '/tmp/proj' } as never;

    const neg = JSON.parse(
      (await tool.execute(
        { path: 'a.ts', content: 'const x = 1;', line: 1, character: 1, limit: -1, format: 'json' },
        ctx,
        { signal: new AbortController().signal },
      )) as string,
    );
    expect(neg.items).toHaveLength(1);

    const nanRes = JSON.parse(
      (await tool.execute(
        {
          path: 'a.ts',
          content: 'const x = 1;',
          line: 1,
          character: 1,
          limit: Number.NaN,
          format: 'json',
        },
        ctx,
        { signal: new AbortController().signal },
      )) as string,
    );
    expect(nanRes.items).toHaveLength(3);
  });
});
