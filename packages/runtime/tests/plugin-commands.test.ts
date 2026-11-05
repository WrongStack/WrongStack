import { describe, expect, it } from 'vitest';
import { buildPluginCommands } from '../src/commands.js';

describe('builtin plugin commands without a terminal', () => {
  it('collects the commands the plugins register and nothing else', async () => {
    const names = (await buildPluginCommands({})).map((command) => command.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'skill',
        'skill-gen',
        'skill-search',
        'skill-install',
        'skill-import',
        'skill-update',
        'skill-uninstall',
        'prompts',
        'prompt-gen',
        'perf',
      ]),
    );
    // /sync needs the profile paths and config; without them it stays out.
    expect(names).not.toContain('sync');
  });

  it('reports a missing skill library instead of failing', async () => {
    const search = (await buildPluginCommands({})).find((command) => command.name === 'skill');
    const result = await search?.run('', undefined);
    expect(typeof result?.message).toBe('string');
  });
});
