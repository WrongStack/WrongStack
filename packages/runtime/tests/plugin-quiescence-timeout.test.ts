import type { Tool } from '@wrongstack/contracts/types/tool';
import { describe, expect, it } from 'vitest';
import { installPluginToolQuiescence } from '../src/plugin-host/plugin-quiescence.js';

describe('installPluginToolQuiescence timeout handling', () => {
  it('does not resolve immediately on NaN timeoutMs while a tool is still in flight', async () => {
    let releaseTool!: () => void;
    let finished = false;
    const tool = {
      name: 'demo_tool',
      description: 'demo',
      inputSchema: { type: 'object' },
      execute: async () => {
        await new Promise<void>((resolve) => {
          releaseTool = resolve;
        });
        finished = true;
        return { content: 'ok', isError: false };
      },
    } as unknown as Tool;

    const waitForQuiescence = installPluginToolQuiescence(undefined, {
      listWithOwner: () => [{ tool, owner: 'demo-plugin' }],
      resolveName: (name: string) => name,
    });

    const exec = tool.execute({}, {} as never, {} as never);
    let resolvedEarly = false;
    const wait = waitForQuiescence('demo-plugin', Number.NaN).then(() => {
      if (!finished) resolvedEarly = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolvedEarly).toBe(false);

    releaseTool();
    await Promise.all([exec, wait]);
    expect(resolvedEarly).toBe(false);
  });
});
