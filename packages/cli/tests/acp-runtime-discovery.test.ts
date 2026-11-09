import { fileURLToPath } from 'node:url';
import { inspectAcpRuntime } from '@wrongstack/fleet';
import { expect, it } from 'vitest';

const agent = {
  command: process.execPath,
  args: [
    fileURLToPath(new URL('../../acp/tests/fixtures/runtime-config-agent.ts', import.meta.url)),
  ],
};
it('does not coalesce different agent identities that share the same launch command', async () => {
  const root = process.cwd();
  const config = {
    acp: { agents: { first: agent, second: agent }, bridge: { agents: ['first', 'second'] } },
  };
  const results = await Promise.all(
    ['first', 'second'].map((id) => inspectAcpRuntime(config as never, root, id)),
  );
  expect(results.map((x) => x.agentId)).toEqual(['first', 'second']);
});
it('isolates profile defaults in concurrent option discovery', async () => {
  const root = process.cwd();
  const config = { acp: { agents: { fixture: agent }, bridge: { agents: ['fixture'] } } };
  const results = await Promise.all(
    ['fast', 'deep'].map((engine) =>
      inspectAcpRuntime(
        { ...config, modelRuntime: { acp: { fixture: { engine } } } } as never,
        root,
        'fixture',
      ),
    ),
  );
  expect(
    results.map((x) => x.options.find((option) => option.id === 'engine')?.currentValue),
  ).toEqual(['fast', 'deep']);
});
