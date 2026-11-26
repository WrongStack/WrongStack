import type { Tool } from '@wrongstack/contracts/types/tool';
import { ToolRegistry } from '@wrongstack/core/registry';
import { expect, it } from 'vitest';
import { installPluginToolQuiescence } from '../src/plugin-host/plugin-quiescence.js';

it('waits for the owner of a registered copy of an instrumented tool', async () => {
  const registry = new ToolRegistry();
  const waitForQuiescence = installPluginToolQuiescence(undefined, registry);
  const gate = Promise.withResolvers<void>();
  registry.register(
    {
      name: 'original',
      description: 'fixture',
      inputSchema: { type: 'object' },
      async execute() {
        await gate.promise;
        return { content: 'done', isError: false };
      },
    } as Tool,
    'base-plugin',
  );

  registry.register({ ...registry.get('original')!, name: 'copy' }, 'copy-plugin');
  const running = registry.get('copy')!.execute({}, {} as never, {} as never);
  let copyIsDrained = false;
  const copyWait = waitForQuiescence('copy-plugin', Infinity).then(() => {
    copyIsDrained = true;
  });
  await Promise.resolve();
  const drainedBeforeRelease = copyIsDrained;
  gate.resolve();
  await Promise.all([running, copyWait]);

  expect(drainedBeforeRelease).toBe(false);
});
